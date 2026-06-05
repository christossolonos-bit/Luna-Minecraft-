import { CompanionClient } from "../sdk";
import { CompanionState } from "../types";
import { loadMcAiConfig } from "../mc-ai/config";
import { distance, ownerMoveTarget } from "../mc-ai/actions";
import { McBrain, chunkChat } from "../mc-ai/brain";
import { checkOllamaHealth } from "../mc-ai/ollama";
import { McVoice, voiceEnabledFromEnv } from "../mc-ai/voice";
import { ActionRunner, createQueuedSender, UserCommandJob, UserCommandQueue } from "../mc-ai/sequential";
import { abilitiesHelpText } from "./abilities";

export type SimpleLunaOptions = {
  /** Ollama + optional TTS for conversation — written commands unchanged. */
  enableLlmChat?: boolean;
};
type SimpleCommand =
  | "follow"
  | "stop"
  | "tp"
  | "deposit"
  | "gather_wood"
  | "check_logs"
  | "collect_wheat"
  | "plant_wheat"
  | "take_pickaxe"
  | "take_axe"
  | "help"
  | "unknown";

function hasToolInState(state: CompanionState | null, kind: "pickaxe" | "axe"): boolean {
  const suffix = kind === "pickaxe" ? "_pickaxe" : "_axe";
  return state?.inventory?.some((i) => i.name.endsWith(suffix)) ?? false;
}

function missingToolsMessage(state: CompanionState | null): string | null {
  const missing: string[] = [];
  if (!hasToolInState(state, "pickaxe")) {
    missing.push("pickaxe");
  }
  if (!hasToolInState(state, "axe")) {
    missing.push("axe");
  }
  if (missing.length === 0) {
    return null;
  }
  if (missing.length === 2) {
    return "I don't have a pickaxe or axe. Say take pickaxe or take axe.";
  }
  return `I don't have an ${missing[0]}. Say take ${missing[0]}.`;
}

function parseCommand(
  message: string,
  state: CompanionState | null
): { cmd: SimpleCommand; say: string; skipAction?: boolean } {
  const m = message.trim().toLowerCase();
  if (!m || /^(help|abilities|what can you do)\b/.test(m)) {
    return {
      cmd: "help",
      say:
        'Commands: follow me, stop, tp to me, gather wood, collect wheat, plant wheat, check logs, put in chest, take pickaxe, take axe.'
    };
  }
  if (/\b(stop|stay there|wait here|don't follow|dont follow|halt)\b/.test(m)) {
    return { cmd: "stop", say: "Okay, I'll stay here." };
  }
  if (/\b(follow me|stay with me|stick with me|follow)\b/.test(m)) {
    return { cmd: "follow", say: "Following you!" };
  }
  if (
    /\b(tp to me|teleport to me|teleport here|tp here|warp to me)\b/.test(m) ||
    /\b(tp|teleport)\b/.test(m)
  ) {
    return { cmd: "tp", say: "On my way!" };
  }
  if (/\b(take|grab|get)\s+(a\s+)?(pickaxe|pick)\b/.test(m)) {
    return { cmd: "take_pickaxe", say: "Getting a pickaxe from the chest." };
  }
  if (/\b(take|grab|get)\s+(a\s+)?axe\b/.test(m)) {
    return { cmd: "take_axe", say: "Getting an axe from the chest." };
  }
  const wantsGatherWood =
    /\b(gather wood|chop wood|cut (a |the |)tree|get wood)\b/.test(m) ||
    /\b(chop|cut|fell)(?:ping|s|t|ting)?\s+(?:down\s+)?(?:the\s+|this\s+|a\s+)?tree\b/.test(m) ||
    /\b(chop|cut)\s+(?:some\s+)?wood\b/.test(m);
  if (wantsGatherWood) {
    if (!hasToolInState(state, "axe")) {
      return {
        cmd: "gather_wood",
        say: "I don't have an axe. Say take axe.",
        skipAction: true
      };
    }
    return { cmd: "gather_wood", say: "Finding a tree and checking what kind it is…" };
  }
  if (
    /\b(plant|replant|sow)\s+(the\s+|my\s+|)(wheat|farm|seeds?)\b/.test(m) ||
    /\b(plant wheat|replant farm|plant seeds|sow wheat)\b/.test(m)
  ) {
    return { cmd: "plant_wheat", say: "Taking wheat seeds from the chest and planting at the farm." };
  }
  if (
    /\b(collect|harvest|gather|get)\s+(the\s+|my\s+|)(wheat|farm)\b/.test(m) ||
    /\b(collect wheat|harvest wheat|farm wheat)\b/.test(m)
  ) {
    return { cmd: "collect_wheat", say: "Collecting wheat, stashing it, then replanting seeds." };
  }
  if (/\bput in chest\b/.test(m) || /\bput (it |everything )?in (the |a )?chest\b/.test(m)) {
    return { cmd: "deposit", say: "Putting items in chest." };
  }
  if (
    /\b(check (my |your |)(inventory|logs?)|do you have (any |)logs?|how many logs?)\b/.test(m) ||
    /\b(check|count|show)\s+(logs?|wood)\b/.test(m)
  ) {
    return { cmd: "check_logs", say: "Checking my inventory for logs…" };
  }
  if (/\b(do you have|got a|have a|need a)\s+(pickaxe|pick|axe|tools?)\b/.test(m)) {
    const msg = missingToolsMessage(state);
    return {
      cmd: "help",
      say: msg ?? "I have a pickaxe and an axe.",
      skipAction: true
    };
  }
  return {
    cmd: "unknown",
    say: 'Try "follow me", "gather wood", "collect wheat", "plant wheat", or "take axe".'
  };
}

function isWrittenCommand(cmd: SimpleCommand): boolean {
  return cmd !== "unknown";
}

/**
 * Luna: follow, teleport, sleep sync, chest stash, tools, gather wood.
 * Optional Ollama chat when enableLlmChat — commands always use the simple parser.
 */
export async function startSimpleLuna(options: SimpleLunaOptions = {}): Promise<void> {
  const enableLlmChat = options.enableLlmChat ?? false;
  const config = loadMcAiConfig();
  const client = new CompanionClient({
    url: config.bridgeUrl,
    actionTimeoutMs: 300_000,
    safety: {
      maxMoveDistance: Number(process.env.MC_AI_MAX_MOVE ?? "48"),
      allowBreakBlocks: false,
      allowPlaceBlocks: false,
      protectedRadiusAroundPlayer: Number(process.env.MC_AI_OWNER_PROTECT_RADIUS ?? "2") || 2
    }
  });

  let latestState: CompanionState | null = null;
  let followOwner = false;
  let lastFollowMoveAt = 0;
  let lastChatReplyAt = 0;
  let busy = false;

  const brain = enableLlmChat ? new McBrain(config) : null;
  const voiceFlags = voiceEnabledFromEnv();
  const voice = voiceFlags.enabled
    ? new McVoice({
        enabled: true,
        sttEnabled: voiceFlags.stt,
        ttsEnabled: voiceFlags.tts,
        onTranscript: (text) => {
          commandQueue.enqueue({ message: text, kind: "voice", isBuild: false });
        }
      })
    : null;

  const actionRunner = new ActionRunner();
  const runAction = createQueuedSender(actionRunner, (a) => client.sendAction(a));
  const commandQueue = new UserCommandQueue(8);

  console.log("");
  console.log(enableLlmChat ? "=== Luna (commands + chat) ===" : "=== Luna (simple) ===");
  console.log(`Owner: ${config.owner} | Bridge: ${config.bridgeUrl}`);
  console.log(abilitiesHelpText());
  if (enableLlmChat) {
    console.log(`Chat: Ollama ${config.model} @ ${config.ollamaHost}`);
    const ollamaIssue = await checkOllamaHealth(config.ollamaHost, config.model);
    if (ollamaIssue) {
      console.warn(`[luna] Ollama: ${ollamaIssue}`);
    }
  } else if (voiceFlags.enabled) {
    console.log("Voice: commands only (hold PTT key) — no Ollama chat.");
  }
  voice?.start();
  console.log("");

  async function runTakeTool(kind: "pickaxe" | "axe"): Promise<void> {
    followOwner = false;
    await runAction({ type: "stop_all" });
    const result = await runAction({
      type: "run_task",
      task: "take_tool",
      target: kind
    });
    if (result.reason) {
      await runAction({
        type: "chat",
        message: (result.ok ? result.reason : `Couldn't take ${kind}: ${result.reason}`).slice(
          0,
          config.mcChatLimit
        )
      });
    }
  }

  async function runCommand(cmd: SimpleCommand): Promise<void> {
    switch (cmd) {
      case "follow":
        followOwner = true;
        break;
      case "stop":
        followOwner = false;
        await runAction({ type: "stop_all" });
        break;
      case "tp":
        followOwner = false;
        await runAction({ type: "stop_all" });
        await runAction({ type: "teleport_to_owner" });
        break;
      case "deposit":
        followOwner = false;
        await runAction({ type: "stop_all" });
        {
          const result = await runAction({ type: "run_task", task: "deposit_chest" });
          if (result.reason) {
            await runAction({
              type: "chat",
              message: (result.ok ? result.reason : `Couldn't stash: ${result.reason}`).slice(
                0,
                config.mcChatLimit
              )
            });
          }
        }
        break;
      case "gather_wood":
        followOwner = false;
        await runAction({ type: "stop_all" });
        {
          const result = await runAction({ type: "run_task", task: "gather_wood" });
          if (result.reason) {
            const failMsg = /axe|tool/i.test(result.reason)
              ? "I need an axe — say take axe."
              : `Wood run failed: ${result.reason}`;
            await runAction({
              type: "chat",
              message: (result.ok ? result.reason : failMsg).slice(0, config.mcChatLimit)
            });
          }
        }
        break;
      case "take_pickaxe":
        await runTakeTool("pickaxe");
        break;
      case "take_axe":
        await runTakeTool("axe");
        break;
      case "collect_wheat":
        followOwner = false;
        await runAction({ type: "stop_all" });
        {
          const result = await runAction({ type: "run_task", task: "collect_wheat" });
          if (result.reason) {
            await runAction({
              type: "chat",
              message: (result.ok ? result.reason : `Wheat run failed: ${result.reason}`).slice(
                0,
                config.mcChatLimit
              )
            });
          }
        }
        break;
      case "plant_wheat":
        followOwner = false;
        await runAction({ type: "stop_all" });
        {
          const result = await runAction({ type: "run_task", task: "plant_wheat" });
          if (result.reason) {
            await runAction({
              type: "chat",
              message: (result.ok ? result.reason : `Plant failed: ${result.reason}`).slice(
                0,
                config.mcChatLimit
              )
            });
          }
        }
        break;
      case "check_logs":
        {
          const result = await runAction({ type: "run_task", task: "check_logs" });
          if (result.reason) {
            await runAction({
              type: "chat",
              message: result.reason.slice(0, config.mcChatLimit)
            });
          }
          if (result.detail === "can_pillar" && hasToolInState(latestState, "axe")) {
            await runAction({
              type: "chat",
              message: "Using my logs to climb the trunk.".slice(0, config.mcChatLimit)
            });
            followOwner = false;
            await runAction({ type: "stop_all" });
            const wood = await runAction({ type: "run_task", task: "gather_wood" });
            if (wood.reason) {
              const failMsg = /axe|tool/i.test(wood.reason)
                ? "I need an axe — say take axe."
                : wood.ok
                  ? wood.reason
                  : `Wood run failed: ${wood.reason}`;
              await runAction({
                type: "chat",
                message: failMsg.slice(0, config.mcChatLimit)
              });
            }
          }
        }
        break;
      case "help":
      case "unknown":
        break;
    }
  }

  async function announce(say: string): Promise<void> {
    const msg = say.slice(0, config.mcChatLimit);
    await runAction({ type: "chat", message: msg });
    if (voiceFlags.tts && voice) {
      await voice.speak(say);
    }
  }

  async function replyWithLlm(message: string, source: UserCommandJob["kind"]): Promise<void> {
    if (!brain) {
      return;
    }
    const now = Date.now();
    if (now - lastChatReplyAt < config.replyCooldownMs) {
      return;
    }
    lastChatReplyAt = now;

    try {
      const reply = await brain.replyChatOnly(message, latestState, jobSourceLabel(source));
      if (!reply) {
        return;
      }
      for (const chunk of chunkChat(reply, config.mcChatLimit)) {
        await runAction({ type: "chat", message: chunk });
      }
      await voice?.speak(reply);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[luna/chat] ${msg}`);
      await runAction({
        type: "chat",
        message: "My chat brain glitched — try again in a sec.".slice(0, config.mcChatLimit)
      });
    }
  }

  function jobSourceLabel(kind: UserCommandJob["kind"]): string {
    return kind === "voice" ? "voice" : "Minecraft chat";
  }

  async function processOwnerCommand(job: UserCommandJob): Promise<void> {
    busy = true;
    try {
      const { cmd, say, skipAction } = parseCommand(job.message, latestState);

      if (isWrittenCommand(cmd)) {
        if (say) {
          await announce(say);
        }
        if (!skipAction) {
          await runCommand(cmd);
        }
        return;
      }

      // Voice = commands only; never free-chat with Ollama
      if (enableLlmChat && brain && job.kind === "chat") {
        await replyWithLlm(job.message, job.kind);
        return;
      }

      if (say) {
        await announce(say);
      }
    } finally {
      busy = false;
    }
  }

  commandQueue.setProcessor(processOwnerCommand);

  client.onState((state) => {
    latestState = state;

    if (state.ownerSleeping || state.lunaSleeping) {
      followOwner = false;
      return;
    }

    if (followOwner && state.owner && !busy && commandQueue.pending === 0) {
      const now = Date.now();
      if (now - lastFollowMoveAt < 2500) {
        return;
      }
      const d = distance(state.player.position, state.owner.position);
      if (d > 4) {
        const target = ownerMoveTarget(state);
        if (target) {
          lastFollowMoveAt = now;
          void runAction({ type: "move_to", target, sprint: d > 8 });
        }
      }
    }
  });

  client.onPlayerChat((chat) => {
    if (chat.username.toLowerCase() !== config.owner.toLowerCase()) {
      return;
    }
    console.log(`\n[${chat.username}] ${chat.message}`);
    commandQueue.enqueue({ message: chat.message, kind: "chat", isBuild: false });
  });

  await client.connect();
  const voiceHint = voiceFlags.enabled ? " | Voice PTT: commands only" : "";
  console.log(
    enableLlmChat
      ? `[luna] Commands: follow, tp, gather wood, check logs… | In-game chat: Ollama replies.${voiceHint}`
      : `[luna] Connected — follow, tp, gather wood, collect/plant wheat, put in chest, take tools, sleep.${voiceHint}`
  );
}
