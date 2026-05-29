import { CompanionState } from "../types";

/** Owner is asking Luna about herself — not a Minecraft wiki / tutorial topic. */
export function isOwnerDirectQuestion(message: string): boolean {
  return (
    asksAboutInventory(message) ||
    asksAboutOwnerGift(message) ||
    asksAboutLunaState(message)
  );
}

export function asksAboutInventory(message: string): boolean {
  const m = message.toLowerCase();
  return /\b(what do you have|what's in your inventory|whats in your inventory|your inventory|what are you carrying|list your items|what tools do you have|what items do you have|show me your inventory|what is in your inventory)\b/.test(
    m
  );
}

export function asksAboutOwnerGift(message: string): boolean {
  const m = message.toLowerCase();
  return /\b(what did i give|what did you get|did i give you|what have i given|what did i give you|did you get anything)\b/.test(
    m
  );
}

export function asksAboutLunaState(message: string): boolean {
  const m = message.toLowerCase();
  return /\b(where are you|how much health|how hungry|are you hurt|are you stuck)\b/.test(m) &&
    /\b(you|luna)\b/.test(m);
}

export type OwnerQuestionTurn = {
  say: string;
  move: "none";
  lookAt: "none";
  task: "none";
};

export function resolveDirectOwnerQuestion(
  message: string,
  state: CompanionState | null
): OwnerQuestionTurn | null {
  if (!state || !isOwnerDirectQuestion(message)) {
    return null;
  }

  if (asksAboutInventory(message)) {
    const inv = state.inventorySummary ?? "empty";
    return {
      say: `I've got: ${inv}`,
      move: "none",
      lookAt: "none",
      task: "none"
    };
  }

  if (asksAboutOwnerGift(message)) {
    const inv = state.inventorySummary ?? "nothing in my inventory";
    const recent = state.recentOwnerActivity?.slice(-5) ?? [];
    const ownerActs = recent.length
      ? ` I last saw you: ${recent.map((e) => e.detail.replace(/\|/g, " ")).join("; ")}.`
      : "";
    return {
      say: `I don't track every item you hand me, but right now ${inv}.${ownerActs}`,
      move: "none",
      lookAt: "none",
      task: "none"
    };
  }

  if (asksAboutLunaState(message)) {
    const p = state.player;
    return {
      say: `I'm at (${p.position.x.toFixed(0)}, ${p.position.y.toFixed(0)}, ${p.position.z.toFixed(0)}) with ${p.health.toFixed(0)} health and ${p.hunger}/20 hunger.`,
      move: "none",
      lookAt: "none",
      task: "none"
    };
  }

  return null;
}
