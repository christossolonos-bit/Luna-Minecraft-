import { CompanionState } from "../types";
import { isHuntableAnimal } from "../bot-combat";
import { formatStructuresForContext } from "../spatial-awareness";
import { contextForState } from "./craft-knowledge";
import { isFoodItem } from "../bot-eat";

export type CompanionContextOptions = {
  ownerName: string;
  /** Pre-built status line from AgentStatusTracker */
  statusLine?: string;
};

function countItems(state: CompanionState, pattern: RegExp): number {
  if (!state.inventory?.length) {
    return 0;
  }
  return state.inventory
    .filter((i) => pattern.test(i.name))
    .reduce((n, i) => n + i.count, 0);
}

function countNamed(state: CompanionState, name: string): number {
  if (!state.inventory?.length) {
    return 0;
  }
  return state.inventory.filter((i) => i.name === name).reduce((n, i) => n + i.count, 0);
}

function timeLabel(timeOfDay?: number): string {
  const t = timeOfDay ?? 6000;
  if (t >= 0 && t < 6000) return "morning";
  if (t >= 6000 && t < 12_000) return "day";
  if (t >= 12_000 && t < 18_000) return "evening";
  return "night";
}

function ownerDistanceM(state: CompanionState): number | null {
  if (!state.owner) {
    return null;
  }
  const a = state.player.position;
  const b = state.owner.position;
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function formatNearbyEntities(state: CompanionState): string {
  const mobs = state.nearbyMobs ?? [];
  const limit = Number(process.env.MC_AI_CONTEXT_MOB_LIMIT ?? "15") || 15;
  if (mobs.length === 0) {
    return "Nearby entities: none in range (40m).";
  }
  const listed = mobs.slice(0, limit).map((m) => {
    const tag = m.hostile ? "hostile" : isHuntableAnimal(m.name) ? "animal" : "mob";
    return `${m.name}@${m.distance.toFixed(0)}m(${tag})`;
  });
  const more = mobs.length > limit ? ` (+${mobs.length - limit} more)` : "";
  return `Nearby entities (${mobs.length}): ${listed.join(", ")}${more}.`;
}

function formatInventory(state: CompanionState): string[] {
  const lines: string[] = [];
  if (state.inventorySummary) {
    lines.push(state.inventorySummary);
  } else if (state.inventory?.length) {
    const invLimit = Number(process.env.MC_AI_CONTEXT_INV_ITEMS ?? "24") || 24;
    const inv = state.inventory
      .slice(0, invLimit)
      .map((i) => `${i.name}x${i.count}`)
      .join(", ");
    lines.push(`Luna inventory: ${inv}.`);
  } else {
    lines.push("Luna inventory: empty.");
  }

  const planks = countItems(state, /_planks$/);
  const wool =
    countItems(state, /_wool$/) + countNamed(state, "wool");
  const logs = countItems(state, /_log$|_stem$/);
  const food = state.inventory?.filter((i) => isFoodItem(i.name)).reduce((n, i) => n + i.count, 0) ?? 0;

  lines.push(
    `Material counts: logs=${logs} planks=${planks} sticks=${countNamed(state, "stick")} ` +
      `cobble=${countItems(state, /cobble/)} coal=${countNamed(state, "coal")} ` +
      `wool=${wool} leather=${countNamed(state, "leather")} iron_ingot=${countNamed(state, "iron_ingot")} ` +
      `food_items=${food}.`
  );

  if (state.hotbar?.length) {
    const sel = state.selectedHotbarSlot ?? 1;
    lines.push(`Selected hotbar key: ${sel}.`);
  }

  return lines;
}

function formatRecentActivity(state: CompanionState, ownerName: string): string[] {
  const lines: string[] = [];
  const ownerAct = state.recentOwnerActivity?.slice(-4);
  if (ownerAct?.length) {
    lines.push(
      `Recent ${ownerName} actions: ${ownerAct.map((e) => `${e.kind}:${e.detail}`).join(" | ")}.`
    );
  }
  const builds = state.recentBuildEvents?.slice(-3);
  if (builds?.length) {
    lines.push(
      `Recent Luna builds: ${builds.map((e) => `${e.kind} ${e.blockId}`).join(" | ")}.`
    );
  }
  return lines;
}

/**
 * Full structured snapshot for the LLM user message (not the system prompt).
 * Keep sections newline-separated so small models can scan them.
 */
export function formatCompanionContextForLlm(
  state: CompanionState,
  options: CompanionContextOptions
): string {
  const lines: string[] = [];

  if (options.statusLine) {
    lines.push(options.statusLine);
  }

  const luna = state.player;
  lines.push(
    `Luna: pos (${luna.position.x.toFixed(0)},${luna.position.y.toFixed(0)},${luna.position.z.toFixed(0)}) ` +
      `facing ${state.facingLabel ?? "unknown"} ` +
      `health ${luna.health.toFixed(0)}/20 hunger ${luna.hunger}/20 ` +
      `holding ${luna.heldItem ?? "nothing"}.`
  );

  lines.push("--- SITUATIONAL AWARENESS (trust for tool/task choice) ---");
  lines.push(formatStructuresForContext(state.nearbyStructures ?? []));
  if (state.nearbyCraftingTable) {
    const table = state.nearbyStructures?.find((s) => s.kind === "crafting_table");
    if (table) {
      lines.push(
        `Crafting table: YES — ${table.direction} Luna ${table.distance.toFixed(1)}m (use craft_tools; do not say you lack a table).`
      );
    } else {
      lines.push("Crafting table: YES within 48m (exact direction not in 12m scan).");
    }
  } else {
    lines.push("Crafting table: NO within 48m — craft 4 planks and place one first.");
  }
  if (state.nearbyChest) {
    const chest = state.nearbyStructures?.find((s) => s.kind === "chest" || s.kind === "trapped_chest");
    if (chest) {
      lines.push(`Chest: YES — ${chest.direction} Luna ${chest.distance.toFixed(1)}m.`);
    } else {
      lines.push("Chest: YES within 48m.");
    }
  } else {
    lines.push("Chest: NO within 48m.");
  }
  lines.push(
    "If owner says a station is behind/in front of you, match WORKSTATIONS above — do not contradict sensors."
  );
  lines.push("--- END SITUATIONAL AWARENESS ---");

  if (state.owner) {
    const o = state.owner;
    const dist = ownerDistanceM(state);
    lines.push(
      `${options.ownerName}: pos (${o.position.x.toFixed(0)},${o.position.y.toFixed(0)},${o.position.z.toFixed(0)}) ` +
        `${dist !== null ? `${dist.toFixed(0)}m away` : ""} holding ${o.heldItem ?? "nothing"}.`
    );
  } else {
    lines.push(`${options.ownerName}: not in world or out of range.`);
  }

  const world = state.world;
  lines.push(
    `World: ${world.dimension} ${timeLabel(world.timeOfDay)}` +
      `${world.biome ? ` biome ${world.biome}` : ""}` +
      `${world.timeOfDay !== undefined ? ` time=${world.timeOfDay}` : ""}.`
  );

  if (world.nearbyBlocks?.length) {
    lines.push(`Blocks around Luna (5x5x4): ${world.nearbyBlocks.join(", ")}.`);
    if (world.nearbyBlocks.some((b) => b.includes("coal_ore"))) {
      lines.push("Coal ore is RIGHT NEXT to Luna — use gather_coal with pickaxe, not gather_wood.");
    }
  }

  lines.push(formatNearbyEntities(state));

  lines.push(...formatInventory(state));
  lines.push(...formatRecentActivity(state, options.ownerName));
  lines.push(contextForState(state));

  return lines.filter(Boolean).join("\n");
}
