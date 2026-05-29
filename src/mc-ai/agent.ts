import { CompanionClient } from "../sdk";
import { ActionResult, CompanionAction, CompanionState } from "../types";
import { McBrain, chunkChat } from "./brain";
import { loadMcAiConfig } from "./config";
import { checkOllamaHealth } from "./ollama";
import { AutonomousPlayer } from "./autonomous";
import { GameplayRL, snapshotState } from "./reinforcement";
import { AgentStatusTracker } from "./agent-status";
import { TutorialLearner, shouldStudyAfterStreak } from "./tutorial-learner";
import { SurvivalGoal, SurvivalSkills } from "./survival-skills";
import { CompanionObserver } from "./companion-observe";
import { StuckLearning } from "./learning";
import {
  handleOwnerHelpAck,
  handleStuckAfterAction,
  handleStuckObservation,
  StuckHandler
} from "./stuck-handler";
import { McVoice, voiceEnabledFromEnv } from "./voice";
import {
  distance,
  focusTurnOnUserIntent,
  hasActionableCommand,
  heuristicTurn,
  isTaskIntent,
  McTurnResult,
  ownerMoveTarget,
  resolveActions,
  resolveDirectCraftTurn,
  resolveDirectHuntTurn,
  resolveDirectOwnerQuestion,
  resolveSpatialAwarenessTurn,
  applySpatialAwarenessToTurn,
  parseHuntTarget,
  stripConversationalActions,
  splitOwnerCommands,
  suggestTaskChain,
  asksAboutInventory
} from "./actions";
import { isOwnerDirectQuestion } from "./owner-questions";
import { eatThresholds, hasFoodInInventory, shouldAutoEat } from "./auto-eat";
import {
  craftCommandSay,
  checkCraftMaterials,
  parseCraftItemRequest
} from "./craft-requests";
import { ActionRunner, createQueuedSender, UserCommandJob, UserCommandQueue } from "./sequential";

export async function startMcAi(): Promise<void> {
  const config = loadMcAiConfig();
  const brain = new McBrain(config);
  const voiceFlags = voiceEnabledFromEnv();
  const client = new CompanionClient({
    url: config.bridgeUrl,
    actionTimeoutMs: 180_000,
    safety: {
      maxMoveDistance: Number(process.env.MC_AI_MAX_MOVE ?? "48"),
      allowBreakBlocks: true,
      allowPlaceBlocks: process.env.MC_AI_ALLOW_PLACE !== "false",
      protectedRadiusAroundPlayer: Number(process.env.MC_AI_OWNER_PROTECT_RADIUS ?? "2") || 2
    }
  });

  let lastReplyAt = 0;
  let lastBuildCommentAt = 0;
  let lastFollowMoveAt = 0;
  let lastDefendAt = 0;
  let lastEatAt = 0;
  let busy = false;
  let taskFocus = false;
  let followOwner = false;
  let lastAutonomousAt = 0;
  let autonomousBusy = false;
  let actionEpoch = 0;
  let latestState: CompanionState | null = null;

  const learningEnabled = process.env.MC_AI_LEARNING !== "false";
  const learning = learningEnabled ? new StuckLearning() : null;
  const observeEnabled = process.env.MC_AI_OBSERVE !== "false";
  const observer = observeEnabled ? new CompanionObserver() : null;
  const gameplayRl = new GameplayRL();
  const survivalSkills = new SurvivalSkills(gameplayRl);
  const tutorialLearner = new TutorialLearner();
  const agentStatus = new AgentStatusTracker();
  const autonomous = new AutonomousPlayer(undefined, survivalSkills, gameplayRl);
  const actionRunner = new ActionRunner();
  const runAction = createQueuedSender(actionRunner, (a) => client.sendAction(a));
  const commandQueue = new UserCommandQueue(
    Number(process.env.MC_AI_COMMAND_QUEUE_MAX ?? "12") || 12
  );

  console.log(`[mc-ai] model=${config.model} @ ${config.ollamaHost}`);
  console.log(`[mc-ai] owner=${config.owner} | bridge=${config.bridgeUrl}`);
  console.log("[mc-ai] Craft/build knowledge: recipes, gather chains, shelter process.");
  if (learning) {
    brain.setLearningSummary(learning.summaryForPrompt());
    console.log(`[mc-ai] Stuck learning on (${learning.fixCount} pattern(s)).`);
  }
  if (observer) {
    brain.setObservationSummary(observer.summaryForPrompt());
    console.log(`[mc-ai] Companion observe on (${observer.habitCount} habit(s) learned).`);
  }
  if (autonomous.enabled) {
    brain.setAutonomousSummary(autonomous.summaryForPrompt());
    refreshBrainContext();
    console.log("[mc-ai] Autonomous survival practice on when idle (your commands always win).");
  }
  if (gameplayRl.enabled) {
    console.log("[mc-ai] Reinforcement learning + self-reflection on gameplay outcomes.");
  }
  if (tutorialLearner.enabled) {
    console.log("[mc-ai] Tutorial learning: studies minecraft.wiki when stuck or unsure.");
  }
  console.log("[mc-ai] Agent status: location, phase, stuck detection, progress decisions.");
  console.log("[mc-ai] Owner commands run one-by-one (queued, no overlap).");
  if (process.env.MC_AI_AUTO_EAT !== "false") {
    const { health, hunger } = eatThresholds();
    console.log(`[mc-ai] Auto-eat when health < ${health} or hunger < ${hunger}.`);
  }
  console.log("");

  const ollamaIssue = await checkOllamaHealth(config.ollamaHost, config.model);
  if (ollamaIssue) {
    console.warn(`[mc-ai] WARNING: ${ollamaIssue}`);
    console.warn("[mc-ai] Voice and movement work, but chat replies need Ollama.\n");
  }

  const voice = new McVoice({
    enabled: voiceFlags.enabled,
    sttEnabled: voiceFlags.stt,
    ttsEnabled: voiceFlags.tts,
    onTranscript: (text) => {
      const trimmed = text.trim();
      if (!trimmed) {
        console.log("[mic] (empty transcript — try speaking again)");
        return;
      }
      console.log(`\n[mic] ${trimmed}`);
      enqueueOwnerMessage(trimmed, "voice", false);
    }
  });
  voice.start();

  const shutdown = () => {
    voice.stop();
    client.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);

  await client.connect();
  console.log("[mc-ai] Connected to bridge.");

  const stuckHandler: StuckHandler = {
    onChat: async (message) => {
      console.log(`Luna: ${message}`);
      await voice.speak(message);
      for (const part of chunkChat(message, config.mcChatLimit)) {
        await runAction({ type: "chat", message: part });
      }
    },
    onActions: async (actions) => {
      const results: ActionResult[] = [];
      for (const action of actions) {
        const result = await runAction(action);
        results.push(result);
        if (!result.ok) {
          console.log(`[learn] ${action.type}: ${result.reason ?? "failed"}`);
        }
      }
      return results;
    }
  };

  function refreshBrainContext(): void {
    refreshSurvivalContext();
    brain.setTutorialSummary(tutorialLearner.summaryForPrompt());
    brain.setStatusSummary(latestState ? agentStatus.summaryForPrompt(latestState) : "");
  }

  function refreshSurvivalContext(): void {
    const habits = observer?.getHabits() ?? [];
    brain.setSurvivalSummary(
      survivalSkills.summaryForPrompt(habits, gameplayRl.summaryForPrompt())
    );
  }

  function maybeStudyTutorials(goal: SurvivalGoal | string, reason?: string): void {
    if (!tutorialLearner.enabled) {
      return;
    }
    const critical =
      Boolean(reason) &&
      /crafting table|not enough materials|no reachable|stuck|pathfinding|timeout|could not place/i.test(
        reason!
      );
    const g = goal as SurvivalGoal;
    const streak = ALL_SURVIVAL_GOALS.includes(g) ? gameplayRl.getStreakFail(g) : 0;
    if (!critical && !shouldStudyAfterStreak(streak)) {
      return;
    }
    tutorialLearner.maybeStudyFromFailure(
      goal,
      reason,
      config.ollamaHost,
      config.model,
      refreshBrainContext
    );
  }

  const ALL_SURVIVAL_GOALS: SurvivalGoal[] = [
    "explore",
    "gather_wood",
    "gather_stone",
    "gather_coal",
    "craft_tools",
    "craft_survival",
    "deposit_chest",
    "fight_mobs"
  ];

  function goalFromTask(task: string): SurvivalGoal | null {
    const map: Record<string, SurvivalGoal> = {
      gather_wood: "gather_wood",
      gather_stone: "gather_stone",
      gather_coal: "gather_coal",
      craft_tools: "craft_tools",
      craft_survival: "craft_survival",
      deposit_chest: "deposit_chest",
      fight_mobs: "fight_mobs",
      hunt_animal: "fight_mobs"
    };
    return map[task] ?? null;
  }

  function recordGameplayLearning(
    goal: SurvivalGoal,
    actionType: string,
    before: ReturnType<typeof snapshotState>,
    ok: boolean,
    reason?: string
  ): void {
    const after = latestState ? snapshotState(latestState) : before;
    const { reward, reflection } = gameplayRl.recordEpisode(
      goal,
      actionType,
      before,
      after,
      ok,
      reason
    );
    console.log(`[rl] ${goal} ${ok ? "ok" : "fail"} reward=${reward.toFixed(1)}`);
    if (reflection) {
      console.log(`[reflect] ${reflection}`);
    }
    if (!ok) {
      maybeStudyTutorials(goal, reason);
    }
    agentStatus.recordActionResult(goal, ok, reason);
    refreshBrainContext();
    gameplayRl.scheduleLlmReflection(config.ollamaHost, config.model);
  }

  async function afterActionStuck(action: CompanionAction, result: ActionResult): Promise<void> {
    maybeStudyTutorials("explore", result.reason ?? "stuck");
    if (!learning || !latestState) {
      return;
    }
    await handleStuckAfterAction(learning, action, result, latestState, stuckHandler);
    brain.setLearningSummary(learning.summaryForPrompt());
  }

  async function runAutonomousTick(state: CompanionState): Promise<void> {
    if (
      autonomous.shouldPause({
        busy,
        taskFocus,
        voiceBusy: voice.isBusy(),
        followOwner,
        lastReplyAt,
        userQueuePending: commandQueue.pending > 0
      }) ||
      shouldAutoEat(state)
    ) {
      return;
    }
    const interval = Number(process.env.MC_AI_AUTONOMOUS_INTERVAL_MS ?? "12000") || 12000;
    const now = Date.now();
    if (now - lastAutonomousAt < interval || autonomousBusy) {
      return;
    }
    const plan = agentStatus.decideProgress(state, observer?.getHabits() ?? [], survivalSkills);
    if (!plan) {
      return;
    }

    if (plan.reason) {
      console.log(`[decide] ${plan.reason}`);
    }

    autonomousBusy = true;
    agentStatus.setActivity("autonomous", plan.goal);
    const epoch = actionEpoch;
    lastAutonomousAt = now;
    console.log(`[auto] ${plan.goal}${agentStatus.snapshot(state).stuck ? " (recovering)" : ""}`);

    let snap = snapshotState(state);
    try {
      for (const action of plan.actions) {
        if (epoch !== actionEpoch) {
          console.log("[auto] paused — owner command");
          break;
        }
        const result = await runAction(action);
        const ok = result.ok;
        recordGameplayLearning(plan.goal, action.type, snap, ok, result.reason);
        snap = latestState ? snapshotState(latestState) : snap;
        if (!ok) {
          console.log(`[auto] ${action.type}: ${result.reason ?? "failed"}`);
          await afterActionStuck(action, result);
        } else if (action.type === "move_to") {
          console.log(`[auto] walking to explore`);
        } else if (action.type === "run_task") {
          console.log(`[auto] ${plan.goal}: ${result.reason ?? "done"}`);
        }
        autonomous.recordOutcome(plan.goal, ok, result.reason ?? result.action);
        brain.setAutonomousSummary(autonomous.summaryForPrompt());
      }
    } finally {
      autonomousBusy = false;
    }
  }

  client.onState((state) => {
    latestState = state;

    agentStatus.tick(state, {
      busy,
      autonomousBusy,
      followOwner,
      commandQueuePending: commandQueue.pending,
      voiceBusy: voice.isBusy(),
      taskFocus
    });
    brain.setStatusSummary(agentStatus.summaryForPrompt(state));

    if (shouldAutoEat(state) && hasFoodInInventory(state)) {
      const eatCooldown = Number(process.env.MC_AI_EAT_COOLDOWN_MS ?? "6000") || 6000;
      const urgent = state.player.health < 6;
      const now = Date.now();
      if (
        !busy &&
        !taskFocus &&
        !autonomousBusy &&
        commandQueue.pending === 0 &&
        !voice.isBusy() &&
        (urgent || now - lastEatAt >= eatCooldown)
      ) {
        lastEatAt = now;
        agentStatus.setActivity("eating", "none");
        console.log(
          `[eat] health ${state.player.health.toFixed(0)}, hunger ${state.player.hunger} — eating`
        );
        void runAction({ type: "eat" }).then((r) => {
          if (r.ok) {
            console.log(`[eat] ${r.reason ?? "done"}`);
          } else if (r.reason && !/already full|hunger full/i.test(r.reason)) {
            console.log(`[eat] ${r.reason}`);
          }
        });
      }
    }

    void runAutonomousTick(state);

    if (observer) {
      const observePrompt = observer.ingest(state);
      brain.setObservationSummary(observer.summaryForPrompt());
      refreshBrainContext();
      if (
        observePrompt &&
        process.env.MC_AI_OBSERVE_COMMENTS === "true" &&
        !busy
      ) {
        const now = Date.now();
        if (now - lastBuildCommentAt >= config.buildCommentCooldownMs && now - lastReplyAt >= config.replyCooldownMs) {
          enqueueOwnerMessage(observePrompt, "build", true);
        }
      }
    }

    const hasSword = state.inventory?.some((i) => i.name.endsWith("_sword"));
    if (
      observer?.shouldAutoDefend(state) &&
      !busy &&
      !taskFocus &&
      !autonomousBusy &&
      commandQueue.pending === 0 &&
      !voice.isBusy() &&
      hasSword
    ) {
      const now = Date.now();
      if (now - lastDefendAt > 10_000) {
        lastDefendAt = now;
        console.log("[combat] hostile nearby — defending");
        void runAction({ type: "run_task", task: "fight_mobs" }).then((r) => {
          if (r.ok) {
            console.log(`[combat] ${r.reason ?? "done"}`);
          } else {
            console.log(`[combat] ${r.reason ?? "failed"}`);
          }
        });
      }
    }

    if (learning?.isAwaitingHelp && !busy) {
      void handleStuckObservation(learning, state, stuckHandler).then(() => {
        brain.setLearningSummary(learning.summaryForPrompt());
      });
    }

    if (
      followOwner &&
      !taskFocus &&
      state.owner &&
      !busy &&
      commandQueue.pending === 0 &&
      !voice.isBusy()
    ) {
      const now = Date.now();
      if (now - lastFollowMoveAt < 2500) {
        return;
      }
      const d = distance(state.player.position, state.owner.position);
      if (d > 4) {
        const target = ownerMoveTarget(state);
        if (target) {
          lastFollowMoveAt = now;
          const moveAction: CompanionAction = { type: "move_to", target, sprint: d > 8 };
          void runAction(moveAction).then(async (r) => {
            if (!r.ok) {
              console.log(`[move] ${r.reason ?? "failed"}`);
              await afterActionStuck(moveAction, r);
            }
          });
        }
      }
    }

    if (!config.buildComments || busy) {
      return;
    }
    const now = Date.now();
    if (now - lastBuildCommentAt < config.buildCommentCooldownMs) {
      return;
    }
    if (now - lastReplyAt < config.replyCooldownMs) {
      return;
    }
    const prompt = brain.popNewBuildEvent(state);
    if (!prompt) {
      return;
    }
    enqueueOwnerMessage(prompt, "build", true);
  });

  client.onPlayerChat((chat) => {
    if (chat.username.toLowerCase() !== config.owner.toLowerCase()) {
      return;
    }
    if (learning) {
      handleOwnerHelpAck(learning, chat.message, latestState, stuckHandler);
    }
    console.log(`\n[${chat.username}] ${chat.message}`);
    enqueueOwnerMessage(chat.message, "chat", false);
  });

  function enqueueOwnerMessage(message: string, kind: UserCommandJob["kind"], isBuild: boolean): void {
    actionEpoch += 1;
    client.cancelPendingAction();
    autonomousBusy = false;

    const parts = splitOwnerCommands(message);
    for (const part of parts) {
      commandQueue.enqueue(
        { message: part, kind, isBuild },
        (pending) => {
          if (pending > 1) {
            console.log(`[queue] ${pending} command(s) lined up`);
          }
        }
      );
    }
  }

  async function executeTurn(state: CompanionState | null, turn: McTurnResult, userMessage = ""): Promise<void> {
    const focused = focusTurnOnUserIntent(turn, userMessage);

    if (focused.move === "follow_owner") {
      followOwner = true;
    } else if (focused.move === "stop") {
      followOwner = false;
    } else if (focused.move === "come_to_owner" || focused.move === "teleport_to_owner") {
      followOwner = false;
    }

    if (isTaskIntent(focused.task)) {
      followOwner = false;
      taskFocus = true;
      agentStatus.setActivity("owner_command", focused.task as SurvivalGoal);
    }

    const chain = suggestTaskChain(userMessage);
    const tasks: McTurnResult[] =
      chain.length > 0
        ? chain.map((task) => ({ ...focused, task, move: "none" as const }))
        : [focused];

    const actionGapMs = Number(process.env.MC_AI_ACTION_GAP_MS ?? "350") || 350;

    try {
      for (const step of tasks) {
        const actions = resolveActions(state, step);
        const rlGoal: SurvivalGoal =
          step.task !== "none" ? (step.task as SurvivalGoal) : "explore";
        let snap = latestState ? snapshotState(latestState) : snapshotState(state!);

        for (let i = 0; i < actions.length; i++) {
          const action = actions[i]!;
          if (action.type === "run_task") {
            console.log(`[task] ${action.task}${action.amount ? ` x${action.amount}` : ""}`);
            if (action.task === "fight_mobs" && observer?.preferredSword()) {
              console.log(`[observe] learned weapon habit: ${observer.preferredSword()}`);
            }
          }
          const result = await runAction(action);
          const taskGoal = action.type === "run_task" ? goalFromTask(action.task) : null;
          recordGameplayLearning(taskGoal ?? rlGoal, action.type, snap, result.ok, result.reason);
          snap = latestState ? snapshotState(latestState) : snap;

          if (!result.ok) {
            console.log(`[task] ${action.type}: ${result.reason ?? "failed"}`);
            if (action.type === "run_task") {
              survivalSkills.recordTask(action.task, false, result.reason);
            }
            await afterActionStuck(action, result);
          } else if (action.type === "move_to") {
            console.log(
              `[move] walking to (${action.target.x}, ${action.target.y}, ${action.target.z})`
            );
          } else if (action.type === "teleport_to_owner") {
            console.log(`[move] ${result.reason ?? "teleported"}`);
          } else if (action.type === "equip_tool" || action.type === "equip_hotbar") {
            console.log(`[equip] ${result.reason ?? "ok"}`);
          } else if (action.type === "run_task") {
            console.log(`[task] done: ${result.reason ?? action.task}`);
            survivalSkills.recordTask(action.task, true, result.reason);
          } else if (action.type === "craft_item") {
            console.log(`[craft] ${action.item}: ${result.reason ?? "ok"}`);
          }
          if (actionGapMs > 0 && i < actions.length - 1) {
            await new Promise((r) => setTimeout(r, actionGapMs));
          }
        }
      }
    } finally {
      taskFocus = false;
    }
  }

  async function processOwnerCommand(job: UserCommandJob): Promise<void> {
    const { message, kind, isBuild } = job;
    busy = true;
    agentStatus.setActivity("owner_command", "none");
    await runAction({ type: "stop_all" });
    try {
      const source =
        kind === "voice"
          ? "voice (microphone)"
          : isBuild
            ? "Minecraft build"
            : "Minecraft chat";
      let turn: McTurnResult;
      const directOwner = resolveDirectOwnerQuestion(message, latestState);
      const directSpatial = resolveSpatialAwarenessTurn(message, latestState);
      const directHunt = resolveDirectHuntTurn(message, latestState);
      const directCraft = resolveDirectCraftTurn(message, latestState);
      if (directOwner) {
        console.log("[owner] direct question — inventory/status (no LLM, no wiki)");
        turn = focusTurnOnUserIntent(directOwner, message);
      } else if (directSpatial) {
        console.log(`[awareness] spatial cue → task ${directSpatial.task}`);
        turn = focusTurnOnUserIntent(directSpatial, message);
      } else if (directHunt) {
        console.log(`[hunt] direct command: ${directHunt.taskTarget ?? "animal"}`);
        turn = focusTurnOnUserIntent(directHunt, message);
      } else if (directCraft) {
        console.log(
          `[craft] direct command: ${directCraft.craftItem ?? "materials check only"}`
        );
        turn = focusTurnOnUserIntent(directCraft, message);
      } else {
        refreshBrainContext();
        turn = focusTurnOnUserIntent(
          await brain.replyTurn(message, latestState, source),
          message
        );
        const craftItem = parseCraftItemRequest(message);
        if (craftItem) {
          const check = checkCraftMaterials(latestState, craftItem);
          turn = {
            ...turn,
            say: craftCommandSay(message, latestState) ?? turn.say,
            task: "none",
            craftItem: check.ok ? craftItem : undefined
          };
        }
        const huntTarget = parseHuntTarget(message);
        if (huntTarget) {
          turn = {
            ...turn,
            say: resolveDirectHuntTurn(message, latestState)?.say ?? turn.say,
            task: "hunt_animal",
            taskTarget: huntTarget,
            craftItem: undefined
          };
        }
        turn = applySpatialAwarenessToTurn(turn, message, latestState);
      }

      if (!isOwnerDirectQuestion(message)) {
        tutorialLearner.maybeStudyFromQuestion(
          message,
          config.ollamaHost,
          config.model,
          refreshBrainContext
        );
      }

      if (asksAboutInventory(message) && latestState?.inventorySummary) {
        turn = { ...turn, say: `I've got: ${latestState.inventorySummary}`, task: "none" };
      } else if (!turn.say && hasActionableCommand(message, turn)) {
        turn = { ...turn, say: "On it!" };
      }

      turn = stripConversationalActions(turn, message);

      if (!turn.say) {
        return;
      }
      console.log(`Luna: ${turn.say}`);
      if (turn.move !== "none") {
        console.log(`[move] intent: ${turn.move}`);
      }
      if (turn.task !== "none") {
        console.log(`[task] intent: ${turn.task} (focused)`);
      }
      if (turn.craftItem) {
        console.log(`[craft] intent: ${turn.craftItem}`);
      }
      if (turn.task === "hunt_animal" && turn.taskTarget) {
        console.log(`[hunt] intent: ${turn.taskTarget}`);
      }
      if (turn.equip && turn.equip !== "none") {
        console.log(`[equip] intent: ${turn.equip}`);
      }
      if (turn.hotbarSlot) {
        console.log(`[equip] hotbar slot ${turn.hotbarSlot}`);
      }
      if (asksAboutInventory(message) && latestState?.inventorySummary) {
        console.log(`[inv] ${latestState.inventorySummary}`);
      }

      await executeTurn(latestState, turn, message);

      await voice.speak(turn.say);
      for (const part of chunkChat(turn.say, config.mcChatLimit)) {
        await runAction({ type: "chat", message: part });
      }

      lastReplyAt = Date.now();
      if (isBuild) {
        lastBuildCommentAt = Date.now();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[mc-ai] ${msg}`);
      if (hasActionableCommand(message)) {
        let turn = focusTurnOnUserIntent(heuristicTurn(message), message);
        const huntTarget = parseHuntTarget(message);
        const craftItem = parseCraftItemRequest(message);
        const directOwner = resolveDirectOwnerQuestion(message, latestState);
        if (directOwner) {
          turn = { ...turn, ...directOwner };
        } else if (huntTarget) {
          turn = {
            ...turn,
            say: resolveDirectHuntTurn(message, latestState)?.say ?? "On it!",
            task: "hunt_animal",
            taskTarget: huntTarget
          };
        } else if (craftItem) {
          turn = {
            ...turn,
            say: craftCommandSay(message, latestState) ?? "On it!",
            craftItem: checkCraftMaterials(latestState, craftItem).ok ? craftItem : undefined
          };
        } else if (asksAboutInventory(message) && latestState?.inventorySummary) {
          turn = { ...turn, say: `I've got: ${latestState.inventorySummary}` };
        } else {
          turn = { ...turn, say: "On it!" };
        }
        console.log(`Luna: ${turn.say} (command parse, no LLM)`);
        await executeTurn(latestState, turn, message);
        await voice.speak(turn.say);
        for (const part of chunkChat(turn.say, config.mcChatLimit)) {
          await runAction({ type: "chat", message: part });
        }
        lastReplyAt = Date.now();
        return;
      }
      if (/ollama|fetch failed|ECONNREFUSED/i.test(msg)) {
        const fallback = "Sorry, I can't think right now — is Ollama running?";
        console.log(`Luna: ${fallback}`);
        try {
          await voice.speak(fallback);
          await runAction({ type: "chat", message: fallback });
        } catch {
          // ignore secondary failures
        }
      }
    } finally {
      busy = false;
    }
  }

  commandQueue.setProcessor(processOwnerCommand);

  await new Promise(() => {});
}
