import { CompanionState } from "../types";
import { findStructure } from "../spatial-awareness";
import { NearbyStructure } from "../types";
import { McTurnResult } from "./actions";

export type SpatialOwnerHint = {
  kind: string;
  direction?: string;
  action: "craft_tools" | "craft_survival" | "deposit_chest" | "acknowledge";
};

const KIND_ALIASES: Record<string, string> = {
  "crafting table": "crafting_table",
  "crossing table": "crafting_table",
  workbench: "crafting_table",
  "craft table": "crafting_table",
  furnace: "furnace",
  chest: "chest",
  bed: "bed"
};

function normalizeSpatialMessage(message: string): string {
  return message
    .toLowerCase()
    .replace(/\bcrossing table\b/g, "crafting table")
    .replace(/\bcraftingable\b/g, "crafting table");
}

export function parseSpatialOwnerHint(message: string): SpatialOwnerHint | null {
  const m = normalizeSpatialMessage(message).trim();
  const dirMatch = m.match(/\b(behind|in front of|ahead of|to your left|to your right|left of|right of|near|next to)\b/);

  if (/\b(look behind|behind you|turn around|over there)\b/.test(m)) {
    return { kind: "crafting_table", direction: "behind", action: "acknowledge" };
  }
  const direction = dirMatch?.[1]
    ?.replace("in front of", "ahead")
    .replace("ahead of", "ahead")
    .replace("to your left", "left")
    .replace("to your right", "right")
    .replace("left of", "left")
    .replace("right of", "right")
    .replace("next to", "nearby")
    .replace("near", "nearby");

  for (const [phrase, kind] of Object.entries(KIND_ALIASES)) {
    if (!m.includes(phrase)) {
      continue;
    }
    const youDirected =
      /\b(you|luna|behind you|in front of you|near you)\b/.test(m) ||
      /\b(there is|there's|you have|you've got|use the|look behind)\b/.test(m);
    if (!youDirected && !dirMatch) {
      continue;
    }
    let action: SpatialOwnerHint["action"] = "acknowledge";
    if (kind === "crafting_table") {
      const informing =
        /\b(there is|there's|you have|look|see|notice|behind|in front|pickaxe in|sword in)\b/.test(m);
      const wantsCraft = /\b(craft|make)\b.*\b(tool|pick|sword|axe)\b/.test(m);
      if (wantsCraft) {
        action = "craft_tools";
      } else if (informing) {
        action = "acknowledge";
      } else if (/\b(use|grab)\b/.test(m)) {
        action = "craft_tools";
      }
    }
    if (kind === "chest" && /\b(deposit|store|put|stash)\b/.test(m)) {
      action = "deposit_chest";
    }
    if (kind === "furnace" && /\b(smel|cook|furnace)\b/.test(m)) {
      action = "craft_survival";
    }
    return { kind, direction, action };
  }
  return null;
}

function structureLine(s: NearbyStructure): string {
  return `${s.kind.replace(/_/g, " ")} ${s.direction} me (${s.distance.toFixed(0)}m)`;
}

export function resolveSpatialAwarenessTurn(
  message: string,
  state: CompanionState | null
): McTurnResult | null {
  const hint = parseSpatialOwnerHint(message);
  if (!hint || !state) {
    return null;
  }

  const structures = state.nearbyStructures ?? [];
  const match = findStructure(structures, hint.kind, hint.direction);

  if (!match) {
    const generic = state.nearbyCraftingTable && hint.kind === "crafting_table";
    if (generic && hint.action === "craft_tools") {
      return {
        say: "I sense a crafting table nearby — I'll use it for tools.",
        move: "none",
        lookAt: "none",
        task: "craft_tools"
      };
    }
    return {
      say: `I don't see a ${hint.kind.replace(/_/g, " ")}${hint.direction ? ` ${hint.direction} me` : " nearby"} in my scan — move me closer?`,
      move: "none",
      lookAt: "none",
      task: "none"
    };
  }

  const line = structureLine(match);
  if (hint.action === "acknowledge") {
    const picks = state.inventory?.filter((i) => i.name.includes("pickaxe")).reduce((n, i) => n + i.count, 0) ?? 0;
    const pickNote =
      picks > 0 ? ` I already have ${picks} pickaxe(s) in my inventory.` : "";
    if (/\bpickaxe\b/.test(message.toLowerCase())) {
      return {
        say: `You're right — ${line}.${pickNote} I'll use the table if I need to craft.`,
        move: "none",
        lookAt: "none",
        task: "none"
      };
    }
    return {
      say: `You're right — ${line}.${pickNote}`,
      move: "none",
      lookAt: "none",
      task: "none"
    };
  }
  if (hint.action === "craft_tools") {
    return {
      say: `Yes — ${line}. On it, crafting at the table!`,
      move: "none",
      lookAt: "none",
      task: "craft_tools"
    };
  }
  if (hint.action === "deposit_chest") {
    return {
      say: `Got it — ${line}. I'll deposit extras.`,
      move: "none",
      lookAt: "none",
      task: "deposit_chest"
    };
  }
  return {
    say: `I see it — ${line}.`,
    move: "none",
    lookAt: "none",
    task: "none"
  };
}

/** After LLM: align task with sensed stations when owner gave a spatial cue. */
export function applySpatialAwarenessToTurn(
  turn: McTurnResult,
  message: string,
  state: CompanionState | null
): McTurnResult {
  const direct = resolveSpatialAwarenessTurn(message, state);
  if (!direct) {
    return turn;
  }
  return {
    ...turn,
    say: direct.say,
    task: direct.task,
    move: "none",
    lookAt: "none",
    craftItem: undefined
  };
}
