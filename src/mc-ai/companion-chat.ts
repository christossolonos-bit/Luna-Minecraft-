import { CompanionState } from "../types";
import { McTurnResult, hasActionableCommand, isCasualQuestion } from "./actions";

/** Chat / questions — not a terse command ack. */
export function isCompanionSocialMessage(message: string): boolean {
  const m = message.trim().toLowerCase();
  if (m.length < 3) {
    return false;
  }
  if (parseOwnerFeedbackLike(m)) {
    return false;
  }
  if (
    hasActionableCommand(m) &&
    !/\?/.test(m) &&
    !/\b(what are you doing|tell me what|what do you mean|help me fight|fight for me)\b/.test(m)
  ) {
    return false;
  }
  return (
    isCasualQuestion(message) ||
    /\?/.test(m) ||
    /\b(what do you mean|what did you mean|don't understand|confused|huh)\b/.test(m) ||
    /\b(what are you doing|what're you doing|what you doing|tell me what you|doing outside|up to)\b/.test(
      m
    ) ||
    /\b(help me fight|fight for me|hit for me|kill (them|it|the)|attack (them|the)|clear the mobs)\b/.test(
      m
    ) ||
    /\b(can you tell|tell me about|why are you|how come you)\b/.test(m)
  );
}

function parseOwnerFeedbackLike(m: string): boolean {
  return /\b(good job|bad job|well done|wrong|don't do that)\b/.test(m);
}

function hostilesNear(state: CompanionState | null): { count: number; nearest?: string } {
  const list = state?.nearbyMobs?.filter((mob) => mob.hostile && mob.distance < 24) ?? [];
  if (!list.length) {
    return { count: 0 };
  }
  const sorted = [...list].sort((a, b) => a.distance - b.distance);
  return { count: list.length, nearest: sorted[0]!.name };
}

function distToOwner(state: CompanionState | null): number | null {
  if (!state?.owner) {
    return null;
  }
  const p = state.player.position;
  const o = state.owner.position;
  return Math.hypot(p.x - o.x, p.z - o.z);
}

/** Rule-based Luna voice — no LLM, full personality. */
export function resolveCompanionChatTurn(
  message: string,
  state: CompanionState | null,
  hints?: { statusLine?: string; activity?: string }
): McTurnResult | null {
  if (!isCompanionSocialMessage(message)) {
    return null;
  }

  const m = message.trim().toLowerCase();
  const p = state?.player;
  const pos = p
    ? `(${Math.floor(p.position.x)}, ${Math.floor(p.position.y)}, ${Math.floor(p.position.z)})`
    : "somewhere in the world";
  const dist = distToOwner(state);
  const distText = dist != null ? ` You're about ${Math.round(dist)}m away.` : "";
  const activity =
    hints?.activity?.replace(/^STATUS:\s*/i, "").slice(0, 120) ||
    hints?.statusLine?.slice(0, 120) ||
    "working on survival stuff";
  const { count: hostileCount, nearest } = hostilesNear(state);

  if (
    /\b(hit|fight|kill|attack|help).{0,40}(for me|creeper|mobs?|them|outside)\b/.test(m) ||
    /\b(fight for me|help me fight|can you fight)\b/.test(m)
  ) {
    if (hostileCount > 0) {
      return {
        say: `On it — ${hostileCount} hostile mob${hostileCount > 1 ? "s" : ""} nearby${nearest ? ` (${nearest})` : ""}! I'll equip my sword and push them back.`,
        move: "none",
        lookAt: "none",
        task: "fight_mobs",
        equip: "sword"
      };
    }
    return {
      say: `I don't see anything on me right now, but I'll watch your back — say fight again if something spawns!`,
      move: "none",
      lookAt: "owner",
      task: "none"
    };
  }

  if (/\b(what do you mean|what did you mean|don't understand|confused)\b/.test(m) || m === "huh") {
    return {
      say: `Sorry if I was vague — mic garble happens! You can say come here, fight mobs, chop wood, or ask what I'm carrying.`,
      move: "none",
      lookAt: "owner",
      task: "none"
    };
  }

  if (
    /\b(what are you doing|what're you doing|what you doing|tell me what you|doing outside|what you up to)\b/.test(
      m
    )
  ) {
    const threat =
      hostileCount > 0
        ? ` Careful — ${hostileCount} mob${hostileCount > 1 ? "s" : ""} near me!`
        : "";
    return {
      say: `I'm at ${pos} — ${activity}.${distText}${threat} Want me to come to you?`,
      move: "none",
      lookAt: "owner",
      task: "none"
    };
  }

  if (isCasualQuestion(message)) {
    if (/\b(how are you|you ok|you okay)\b/.test(m)) {
      const hp = p?.health ?? 20;
      return {
        say: `I'm fine — ${hp.toFixed(0)} hearts and still kicking! What should we do next?`,
        move: "none",
        lookAt: "owner",
        task: "none"
      };
    }
    if (/\b(hello|hey|hi)\b/.test(m)) {
      return {
        say: `Hey! Good to hear you — I'm right here at ${pos}.`,
        move: "none",
        lookAt: "owner",
        task: "none"
      };
    }
  }

  return {
    say: `I'm here at ${pos}!${distText} Tell me if you want me to come over, fight, gather, or craft something.`,
    move: "none",
    lookAt: "owner",
    task: "none"
  };
}

/** Replace empty / robotic LLM lines with Luna's voice. */
export function polishCompanionSay(
  turn: McTurnResult,
  message: string,
  state: CompanionState | null,
  hints?: { statusLine?: string; activity?: string }
): McTurnResult {
  const say = turn.say.trim();
  const bland =
    !say ||
    /^(got it!?|okay!?|on it!?|sure\.?|ok\.?|yes\.?|understood\.?)$/i.test(say) ||
    say === '{"error": "no_think"}';

  if (!bland) {
    return turn;
  }

  const social = resolveCompanionChatTurn(message, state, hints);
  if (social) {
    return { ...turn, say: social.say, move: social.move, task: social.task, equip: social.equip ?? turn.equip };
  }

  if (hasActionableCommand(message, turn) && turn.task !== "none") {
    const taskLabel = turn.task.replace(/_/g, " ");
    return { ...turn, say: `Okay — I'll ${taskLabel} for you!` };
  }

  if (hasActionableCommand(message, turn) && turn.move !== "none") {
    return { ...turn, say: `Coming — on my way to you!` };
  }

  return {
    ...turn,
    say: `I'm listening — want me to come to you, fight, gather, or craft something?`
  };
}
