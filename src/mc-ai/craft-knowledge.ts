import { CompanionState } from "../types";
import { SurvivalGoal } from "./survival-skills";
import { isFoodItem } from "../bot-eat";

export type CraftStation = "inventory" | "crafting_table" | "furnace";

export type RecipeDef = {
  id: string;
  output: string;
  outputCount: number;
  /** Item id patterns or exact names */
  inputs: { item: string; count: number }[];
  station: CraftStation;
  note?: string;
};

export type GatherGuide = {
  id: string;
  label: string;
  blocks: string[];
  tool: "axe" | "pickaxe" | "shovel" | "sword" | "hand";
  task: SurvivalGoal;
  yields: string;
};

export type BuildGuide = {
  id: string;
  label: string;
  purpose: string;
  steps: string[];
  blocksNeeded: { item: string; count: number }[];
};

/** Core survival recipes Luna should know by heart. */
export const RECIPES: RecipeDef[] = [
  { id: "planks", output: "planks", outputCount: 4, inputs: [{ item: "log", count: 1 }], station: "inventory", note: "Any log/stem in 2x2 grid" },
  { id: "sticks", output: "stick", outputCount: 4, inputs: [{ item: "planks", count: 2 }], station: "inventory" },
  { id: "crafting_table", output: "crafting_table", outputCount: 1, inputs: [{ item: "planks", count: 4 }], station: "inventory" },
  { id: "wooden_pickaxe", output: "wooden_pickaxe", outputCount: 1, inputs: [{ item: "planks", count: 3 }, { item: "stick", count: 2 }], station: "crafting_table" },
  { id: "wooden_axe", output: "wooden_axe", outputCount: 1, inputs: [{ item: "planks", count: 3 }, { item: "stick", count: 2 }], station: "crafting_table" },
  { id: "wooden_sword", output: "wooden_sword", outputCount: 1, inputs: [{ item: "planks", count: 2 }, { item: "stick", count: 1 }], station: "crafting_table" },
  { id: "wooden_shovel", output: "wooden_shovel", outputCount: 1, inputs: [{ item: "planks", count: 1 }, { item: "stick", count: 2 }], station: "crafting_table" },
  { id: "stone_pickaxe", output: "stone_pickaxe", outputCount: 1, inputs: [{ item: "cobblestone", count: 3 }, { item: "stick", count: 2 }], station: "crafting_table" },
  { id: "stone_axe", output: "stone_axe", outputCount: 1, inputs: [{ item: "cobblestone", count: 3 }, { item: "stick", count: 2 }], station: "crafting_table" },
  { id: "stone_sword", output: "stone_sword", outputCount: 1, inputs: [{ item: "cobblestone", count: 2 }, { item: "stick", count: 1 }], station: "crafting_table" },
  { id: "furnace", output: "furnace", outputCount: 1, inputs: [{ item: "cobblestone", count: 8 }], station: "crafting_table" },
  { id: "torch", output: "torch", outputCount: 4, inputs: [{ item: "coal", count: 1 }, { item: "stick", count: 1 }], station: "inventory" },
  { id: "bread", output: "bread", outputCount: 1, inputs: [{ item: "wheat", count: 3 }], station: "inventory" },
  { id: "iron_pickaxe", output: "iron_pickaxe", outputCount: 1, inputs: [{ item: "iron_ingot", count: 3 }, { item: "stick", count: 2 }], station: "crafting_table" },
  { id: "iron_sword", output: "iron_sword", outputCount: 1, inputs: [{ item: "iron_ingot", count: 2 }, { item: "stick", count: 1 }], station: "crafting_table" },
  { id: "shield", output: "shield", outputCount: 1, inputs: [{ item: "planks", count: 6 }, { item: "iron_ingot", count: 1 }], station: "crafting_table" },
  { id: "leather_chestplate", output: "leather_chestplate", outputCount: 1, inputs: [{ item: "leather", count: 8 }], station: "crafting_table" },
  { id: "iron_chestplate", output: "iron_chestplate", outputCount: 1, inputs: [{ item: "iron_ingot", count: 8 }], station: "crafting_table" },
  { id: "chest", output: "chest", outputCount: 1, inputs: [{ item: "planks", count: 8 }], station: "crafting_table" },
  { id: "bed", output: "bed", outputCount: 1, inputs: [{ item: "wool", count: 3 }, { item: "planks", count: 3 }], station: "crafting_table", note: "Color matches wool; no sticks" }
];

export const GATHER_GUIDES: GatherGuide[] = [
  { id: "wood", label: "Wood", blocks: ["oak_log", "birch_log", "spruce_log", "any log/stem"], tool: "axe", task: "gather_wood", yields: "logs → planks → sticks → tools" },
  { id: "stone", label: "Stone", blocks: ["stone", "deepslate", "andesite"], tool: "pickaxe", task: "gather_stone", yields: "cobblestone for tools & furnace" },
  { id: "coal", label: "Coal", blocks: ["coal_ore", "deepslate_coal_ore"], tool: "pickaxe", task: "gather_coal", yields: "coal for torches & smelting" },
  { id: "iron", label: "Iron ore", blocks: ["iron_ore", "deepslate_iron_ore"], tool: "pickaxe", task: "gather_stone", yields: "mine ore → smelt in furnace → iron ingots" }
];

export const BUILD_GUIDES: BuildGuide[] = [
  {
    id: "workbench",
    label: "Crafting station",
    purpose: "Craft tools and gear",
    steps: [
      "Chop 1+ logs → craft planks in inventory (2x2)",
      "Craft 4 planks → crafting_table in inventory",
      "Place crafting_table on flat ground beside you",
      "Use table for pickaxe, sword, furnace, chest"
    ],
    blocksNeeded: [{ item: "planks", count: 4 }]
  },
  {
    id: "lighting",
    label: "Light the area",
    purpose: "Stop mob spawns at night",
    steps: [
      "Mine coal (or use charcoal from smelting logs)",
      "Craft sticks from planks",
      "Craft torches: 1 coal + 1 stick → 4 torches (inventory)",
      "Place torches on walls/floors every ~8 blocks"
    ],
    blocksNeeded: [{ item: "torch", count: 8 }]
  },
  {
    id: "starter_shelter",
    label: "Starter shelter",
    purpose: "Safe place to craft and sleep",
    steps: [
      "Flat 5×5 floor (planks or cobble)",
      "Walls 2 blocks high around edges",
      "Roof layer on top",
      "Door gap + torches inside",
      "Place crafting_table and chest inside",
      "Optional: furnace in corner for smelting"
    ],
    blocksNeeded: [
      { item: "planks", count: 40 },
      { item: "torch", count: 4 },
      { item: "crafting_table", count: 1 }
    ]
  },
  {
    id: "storage",
    label: "Storage",
    purpose: "Stash extra resources",
    steps: [
      "Craft chest: 8 planks at crafting table",
      "Place chest in shelter",
      "Deposit logs, cobble, coal, extras"
    ],
    blocksNeeded: [{ item: "planks", count: 8 }]
  }
];

/** Ordered survival progression chains. */
export const PROCESS_CHAINS: { id: string; label: string; steps: string[] }[] = [
  {
    id: "tools_wood",
    label: "Wooden tools",
    steps: ["gather_wood", "craft planks+sticks (inventory)", "craft+place crafting_table", "craft_tools"]
  },
  {
    id: "tools_stone",
    label: "Stone tools",
    steps: ["wooden pickaxe", "gather_stone", "craft stone pickaxe/sword at table"]
  },
  {
    id: "night_ready",
    label: "Night ready",
    steps: ["gather_coal", "craft torches", "place torches", "craft sword", "eat food"]
  },
  {
    id: "iron_gear",
    label: "Iron gear",
    steps: ["stone pick", "mine iron ore", "build furnace", "smelt iron", "craft iron tools/armor"]
  }
];

type InvCounts = Map<string, number>;

function buildInvCounts(state: CompanionState): InvCounts {
  const map = new Map<string, number>();
  if (!state.inventory) {
    return map;
  }
  for (const slot of state.inventory) {
    map.set(slot.name, (map.get(slot.name) ?? 0) + slot.count);
  }
  return map;
}

function countPattern(inv: InvCounts, pattern: RegExp): number {
  let n = 0;
  for (const [name, count] of inv) {
    if (pattern.test(name)) {
      n += count;
    }
  }
  return n;
}

function hasItem(inv: InvCounts, pattern: RegExp): boolean {
  return countPattern(inv, pattern) > 0;
}

function hasTool(inv: InvCounts, suffix: string): boolean {
  return [...inv.keys()].some((n) => n.endsWith(suffix));
}

export type ProcessStep = {
  goal: SurvivalGoal;
  reason: string;
  chain: string;
  missing?: string[];
  priority: number;
};

/** What to do next based on recipe/process knowledge and inventory. */
export function recommendProcessStep(state: CompanionState): ProcessStep | null {
  const inv = buildInvCounts(state);
  const logs = countPattern(inv, /_log$|_stem$/);
  const planks = countPattern(inv, /_planks$/);
  const sticks = inv.get("stick") ?? 0;
  const cobble = countPattern(inv, /cobble|stone$/);
  const coal = inv.get("coal") ?? 0;
  const hasPick = hasTool(inv, "_pickaxe");
  const hasAxe = hasTool(inv, "_axe");
  const hasSword = hasTool(inv, "_sword");
  const hasTable = state.nearbyCraftingTable;
  const food = state.inventory?.filter((i) => isFoodItem(i.name)).reduce((n, i) => n + i.count, 0) ?? 0;
  const night = (state.world.timeOfDay ?? 6000) > 12_000 && (state.world.timeOfDay ?? 6000) < 24_000;
  const hostiles = state.nearbyMobs?.some((m) => m.hostile && m.distance < 10);

  // Chain: logs → planks → sticks → table → tools
  if (logs >= 1 && planks < 4 && !hasPick) {
    return {
      goal: "craft_tools",
      reason: "Recipe: 1 log → 4 planks (inventory) — convert logs before gathering more",
      chain: "tools_wood",
      missing: ["planks from logs"],
      priority: 92
    };
  }
  if (planks >= 4 && sticks < 2 && !hasPick) {
    return {
      goal: "craft_tools",
      reason: "Recipe: 2 planks → 4 sticks, then crafting table",
      chain: "tools_wood",
      missing: ["sticks"],
      priority: 90
    };
  }
  if ((planks >= 4 || logs >= 1) && !hasTable && !hasPick) {
    return {
      goal: "craft_tools",
      reason: "Process: craft & place crafting_table (4 planks) for tools",
      chain: "tools_wood",
      missing: ["crafting_table nearby"],
      priority: 88
    };
  }
  if (hasTable && !hasPick && (planks >= 3 || logs >= 1)) {
    return {
      goal: "craft_tools",
      reason: "Recipe: wooden pickaxe at table (3 planks + 2 sticks)",
      chain: "tools_wood",
      priority: 86
    };
  }
  if (!hasAxe && logs < 4 && !hasPick) {
    return {
      goal: "gather_wood",
      reason: "Gather: chop trees with axe/hand → logs for full tool chain",
      chain: "tools_wood",
      missing: ["logs"],
      priority: 70
    };
  }

  // Stone progression
  if (hasPick && cobble < 8) {
    return {
      goal: "gather_stone",
      reason: "Gather: mine stone/deepslate with pickaxe → cobble for stone tools & furnace",
      chain: "tools_stone",
      missing: ["cobblestone"],
      priority: 65
    };
  }
  if (hasPick && cobble >= 3 && !hasItem(inv, /stone_pickaxe|iron_pickaxe|diamond_pickaxe/)) {
    return {
      goal: "craft_tools",
      reason: "Recipe: stone pickaxe (3 cobble + 2 sticks) at crafting table",
      chain: "tools_stone",
      priority: 64
    };
  }

  // Coal & torches
  const nearbyBlocks = state.world.nearbyBlocks ?? [];
  const coalOreVisible = nearbyBlocks.some((b) => b.includes("coal_ore"));
  if (hasPick && coalOreVisible && coal < 8) {
    return {
      goal: "gather_coal",
      reason: "Coal ore visible beside Luna — mine it with pickaxe (priority)",
      chain: "night_ready",
      priority: 78 + (night ? 12 : 0)
    };
  }
  if (hasPick && coal < 4 && cobble >= 4) {
    return {
      goal: "gather_coal",
      reason: "Gather: mine coal_ore with pickaxe → torches & smelting",
      chain: "night_ready",
      missing: ["coal"],
      priority: 55 + (night ? 20 : 0)
    };
  }
  if (coal >= 1 && sticks >= 1 && countPattern(inv, /torch/) < 8 && night) {
    return {
      goal: "craft_survival",
      reason: "Recipe: 1 coal + 1 stick → 4 torches; place for lighting",
      chain: "night_ready",
      priority: 72
    };
  }

  // Combat & food
  if (hostiles && !hasSword && (planks >= 2 || logs >= 1)) {
    return {
      goal: "craft_tools",
      reason: "Recipe: wooden/stone sword before fighting hostiles",
      chain: "night_ready",
      priority: 85
    };
  }
  if (hostiles && hasSword) {
    return {
      goal: "fight_mobs",
      reason: "Combat: sword equipped, clear hostiles",
      chain: "night_ready",
      priority: 88
    };
  }
  if (food < 4) {
    return {
      goal: "craft_survival",
      reason: "Food: craft bread (3 wheat) or cook meat — stay fed",
      chain: "night_ready",
      missing: ["food"],
      priority: 60
    };
  }

  // Storage
  if (logs + planks >= 16 && cobble >= 12 && state.nearbyChest) {
    return {
      goal: "deposit_chest",
      reason: "Build process: stash extras in chest to free inventory",
      chain: "storage",
      priority: 45
    };
  }

  return null;
}

export function recipeSummaryCompact(): string {
  const lines = [
    "CRAFT (inventory 2x2): log→4 planks; 2 planks→4 sticks; 4 planks→crafting_table; coal+stick→4 torches; 3 wheat→bread",
    "CRAFT (table): 3 planks+2 sticks→wooden pick/axe; 3 cobble+2 sticks→stone pick; 8 cobble→furnace; 8 planks→chest; 3 wool+3 planks→bed (no sticks)",
    "GATHER: trees+axe→logs; stone/coal+pickaxe→cobble/coal; deposit extras in chest",
    "BUILD: place crafting_table → craft tools → torches on walls → shelter floor/walls/roof → chest inside"
  ];
  return lines.join(" | ");
}

export function contextForState(state: CompanionState | null): string {
  if (!state) {
    return recipeSummaryCompact();
  }

  const step = recommendProcessStep(state);
  const inv = buildInvCounts(state);
  const logs = countPattern(inv, /_log$|_stem$/);
  const planks = countPattern(inv, /_planks$/);
  const parts = [
    `Crafting knowledge: ${recipeSummaryCompact()}`,
    `Inventory mats: logs=${logs} planks=${planks} cobble=${countPattern(inv, /cobble/)} coal=${inv.get("coal") ?? 0} sticks=${inv.get("stick") ?? 0}.`,
    state.nearbyCraftingTable ? "Crafting table nearby." : "No crafting table nearby — craft 4 planks + place table.",
    state.nearbyChest ? "Chest nearby for storage." : ""
  ];
  if (step) {
    parts.push(`Next process step: ${step.reason} → task ${step.goal}.`);
  }
  return parts.filter(Boolean).join(" ");
}

export function processKnowledgeForPrompt(): string {
  return [
    "SURVIVAL PROCESS (recipes you know):",
    "1 Wood line: chop logs → inventory craft planks → sticks → crafting_table (4 planks) → place table → wooden pick/axe/sword.",
    "2 Stone line: wooden pick → mine stone → cobble → stone tools at table; 8 cobble → furnace.",
    "3 Light & night: mine coal → torches (coal+stick) → place torches; sword for mobs; eat when hungry.",
    "4 Build: flat floor → 2-high walls → roof → torches inside → crafting_table + chest in shelter.",
    "5 Iron (later): mine iron ore → smelt in furnace → iron pick/sword/armor at table.",
    "Always convert logs to planks in inventory before gathering more wood. Use axe for trees, pickaxe for stone/coal."
  ].join("\n");
}
