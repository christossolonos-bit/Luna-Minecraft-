import { CompanionState } from "../types";

export type CraftableItem =
  | "bed"
  | "chest"
  | "crafting_table"
  | "furnace"
  | "torch"
  | "bread"
  | "stick";

type MaterialReq = { label: string; test: (state: CompanionState) => number; need: number };

const CRAFT_SPECS: Record<
  CraftableItem,
  { patterns: RegExp[]; materials: MaterialReq[]; needsTable: boolean; label: string }
> = {
  bed: {
    patterns: [/\b(bed|make a bed|craft a bed|create a bed|build a bed)\b/i],
    materials: [
      { label: "wool", test: (s) => countPattern(s, /_wool$/) + countNamed(s, "wool"), need: 3 },
      { label: "planks", test: (s) => countPattern(s, /_planks$/), need: 3 }
    ],
    needsTable: true,
    label: "bed"
  },
  chest: {
    patterns: [/\b(chest|make a chest|craft a chest)\b/i],
    materials: [{ label: "planks", test: (s) => countPattern(s, /_planks$/), need: 8 }],
    needsTable: true,
    label: "chest"
  },
  crafting_table: {
    patterns: [/\b(crafting table|make a crafting table|craft a crafting table|workbench)\b/i],
    materials: [{ label: "planks", test: (s) => countPattern(s, /_planks$/), need: 4 }],
    needsTable: false,
    label: "crafting table"
  },
  furnace: {
    patterns: [/\b(furnace|make a furnace|craft a furnace|smelter)\b/i],
    materials: [{ label: "cobblestone", test: (s) => countNamed(s, "cobblestone"), need: 8 }],
    needsTable: true,
    label: "furnace"
  },
  torch: {
    patterns: [/\b(torch|torches|make torches|craft torches)\b/i],
    materials: [
      { label: "coal", test: (s) => countNamed(s, "coal"), need: 1 },
      { label: "stick", test: (s) => countNamed(s, "stick"), need: 1 }
    ],
    needsTable: false,
    label: "torch"
  },
  bread: {
    patterns: [/\b(bread|make bread|craft bread|bake bread)\b/i],
    materials: [{ label: "wheat", test: (s) => countNamed(s, "wheat"), need: 3 }],
    needsTable: false,
    label: "bread"
  },
  stick: {
    patterns: [/\b(sticks|make sticks|craft sticks)\b/i],
    materials: [{ label: "planks", test: (s) => countPattern(s, /_planks$/), need: 2 }],
    needsTable: false,
    label: "sticks"
  }
};

function countPattern(state: CompanionState, pattern: RegExp): number {
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

/** Owner describing the world — not asking Luna to craft a new table. */
export function isSpatialCueMessage(message: string): boolean {
  const m = message.toLowerCase();
  return (
    /\b(behind you|in front of you|look behind|look around|over there|right there)\b/.test(m) ||
    (/\b(there is|there's|you have|see the|notice the)\b/.test(m) &&
      /\b(crafting table|workbench|furnace|chest)\b/.test(m))
  );
}

export function parseCraftItemRequest(message: string): CraftableItem | null {
  const m = message.trim();
  if (isSpatialCueMessage(m)) {
    return null;
  }
  for (const [item, spec] of Object.entries(CRAFT_SPECS) as [CraftableItem, (typeof CRAFT_SPECS)[CraftableItem]][]) {
    if (spec.patterns.some((p) => p.test(m))) {
      return item;
    }
  }
  return null;
}

export type CraftMaterialCheck = {
  ok: boolean;
  missing: string[];
  item: CraftableItem;
  label: string;
  needsTable: boolean;
};

export function checkCraftMaterials(
  state: CompanionState | null,
  item: CraftableItem
): CraftMaterialCheck {
  const spec = CRAFT_SPECS[item];
  if (!state) {
    return { ok: false, missing: ["world state"], item, label: spec.label, needsTable: spec.needsTable };
  }
  const missing: string[] = [];
  for (const mat of spec.materials) {
    const have = mat.test(state);
    if (have < mat.need) {
      missing.push(`${mat.need - have} more ${mat.label} (have ${have})`);
    }
  }
  const hasTable =
    state.nearbyCraftingTable ||
    state.nearbyStructures?.some((s) => s.kind === "crafting_table");
  if (spec.needsTable && !hasTable) {
    const planks = countPattern(state, /_planks$/);
    if (planks < 4) {
      missing.push("crafting table nearby (need 4 planks to make one)");
    }
  }
  return {
    ok: missing.length === 0,
    missing,
    item,
    label: spec.label,
    needsTable: spec.needsTable
  };
}

export function craftCommandSay(message: string, state: CompanionState | null): string | null {
  const item = parseCraftItemRequest(message);
  if (!item) {
    return null;
  }
  const check = checkCraftMaterials(state, item);
  if (check.ok) {
    return `On it — crafting a ${check.label}!`;
  }
  return `I need ${check.missing.join(", ")} for a ${check.label}.`;
}
