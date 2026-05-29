import { Bot } from "mineflayer";
import { Block } from "prismarine-block";
import { Vec3 } from "vec3";
import { goals } from "mineflayer-pathfinder";

export function logToPlanksName(logName: string): string | null {
  if (logName.endsWith("_log")) {
    return logName.replace(/_log$/, "_planks");
  }
  if (logName.endsWith("_stem")) {
    return logName.replace(/_stem$/, "_planks");
  }
  return null;
}

export function countLogs(bot: Bot): number {
  return bot.inventory
    .items()
    .filter((i) => i.name.endsWith("_log") || i.name.endsWith("_stem"))
    .reduce((n, i) => n + i.count, 0);
}

export function countPlanks(bot: Bot): number {
  return bot.inventory
    .items()
    .filter((i) => i.name.endsWith("_planks"))
    .reduce((n, i) => n + i.count, 0);
}

export function countSticks(bot: Bot): number {
  return bot.inventory.items().filter((i) => i.name === "stick").reduce((n, i) => n + i.count, 0);
}

export async function craftItem(
  bot: Bot,
  itemName: string,
  count: number,
  table: Block | null
): Promise<boolean> {
  const item = bot.registry.itemsByName[itemName];
  if (!item) {
    return false;
  }
  if (table) {
    await approachCraftingTable(bot, table);
  }
  const recipes = bot.recipesFor(item.id, null, 1, table);
  if (!recipes.length) {
    return false;
  }
  try {
    await bot.craft(recipes[0]!, count, table === null ? undefined : table);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[craft] failed ${itemName}: ${msg}`);
    return false;
  }
}

async function approachCraftingTable(bot: Bot, table: Block): Promise<void> {
  const pf = bot.pathfinder;
  if (!pf) {
    return;
  }
  const pos = table.position;
  const dist = bot.entity.position.distanceTo(pos.offset(0.5, 0.5, 0.5));
  if (dist <= 3) {
    return;
  }
  try {
    await pf.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 2));
  } catch {
    // craft may still work in range
  }
}

function woolColorFromName(name: string): string | null {
  if (name === "wool") {
    return "white";
  }
  const match = name.match(/^(\w+)_wool$/);
  return match?.[1] ?? null;
}

function bedNameForWool(woolName: string): string {
  const color = woolColorFromName(woolName);
  return color ? `${color}_bed` : "white_bed";
}

async function craftBedFromInventory(
  bot: Bot,
  table: Block,
  count: number
): Promise<{ ok: boolean; bedName?: string }> {
  const woolStacks = bot.inventory.items().filter((i) => i.name.endsWith("_wool") || i.name === "wool");
  const byColor = new Map<string, number>();
  for (const stack of woolStacks) {
    const color = woolColorFromName(stack.name) ?? "white";
    byColor.set(color, (byColor.get(color) ?? 0) + stack.count);
  }
  const colorEntry = [...byColor.entries()].find(([, n]) => n >= 3);
  if (!colorEntry) {
    return { ok: false };
  }
  const bedName = `${colorEntry[0]}_bed`;
  if (bot.registry.itemsByName[bedName] && (await craftItem(bot, bedName, count, table))) {
    return { ok: true, bedName };
  }
  for (const stack of woolStacks) {
    const name = bedNameForWool(stack.name);
    if (stack.count >= 3 && (await craftItem(bot, name, count, table))) {
      return { ok: true, bedName: name };
    }
  }
  return { ok: false };
}

/** 2x2 inventory craft — logs → planks (all stacks). */
export async function craftAllPlanksFromLogs(bot: Bot): Promise<number> {
  let crafted = 0;
  for (let pass = 0; pass < 64; pass++) {
    const log = bot.inventory.items().find((i) => i.name.endsWith("_log") || i.name.endsWith("_stem"));
    if (!log) {
      break;
    }
    const planksName = logToPlanksName(log.name);
    if (!planksName || !bot.registry.itemsByName[planksName]) {
      break;
    }
    if (await craftItem(bot, planksName, 1, null)) {
      crafted += 1;
    } else {
      break;
    }
  }
  if (crafted > 0) {
    console.log(`[craft] ${crafted} log(s) → planks (inventory)`);
  }
  return crafted;
}

/** 2x2 inventory craft — planks → sticks. */
export async function craftSticksFromPlanks(bot: Bot, minSticks = 4): Promise<number> {
  let crafted = 0;
  while (countSticks(bot) < minSticks && countPlanks(bot) >= 2) {
    if (await craftItem(bot, "stick", 1, null)) {
      crafted += 1;
    } else {
      break;
    }
  }
  if (crafted > 0) {
    console.log(`[craft] planks → sticks (inventory)`);
  }
  return crafted;
}

export async function placeBlockBesideBot(bot: Bot, blockName: string): Promise<boolean> {
  const stack = bot.inventory.items().find((i) => i.name === blockName);
  if (!stack) {
    return false;
  }

  await bot.equip(stack, "hand");
  const feet = bot.entity.position.floored();
  const offsets = [
    new Vec3(1, 0, 0),
    new Vec3(-1, 0, 0),
    new Vec3(0, 0, 1),
    new Vec3(0, 0, -1),
    new Vec3(0, 1, 0)
  ];

  for (const off of offsets) {
    const target = feet.plus(off);
    const ground = bot.blockAt(target.offset(0, -1, 0));
    const air = bot.blockAt(target);
    if (!ground || ground.name === "air" || !air || air.name !== "air") {
      continue;
    }
    try {
      await bot.placeBlock(ground, new Vec3(0, 1, 0));
      console.log(`[craft] placed ${blockName} at (${target.x}, ${target.y}, ${target.z})`);
      return true;
    } catch {
      // try next spot
    }
  }
  return false;
}

export function findCraftingTable(bot: Bot, maxDistance: number): Block | null {
  return (
    bot.findBlock({
      matching: (b) => b.name === "crafting_table",
      maxDistance,
      count: 1
    }) ?? null
  );
}

/** Craft table in inventory (4 planks) and place it if none nearby. */
export async function ensureCraftingTable(bot: Bot, maxDistance: number): Promise<Block | null> {
  const existing = findCraftingTable(bot, maxDistance);
  if (existing) {
    return existing;
  }

  await craftAllPlanksFromLogs(bot);
  if (countPlanks(bot) < 4) {
    return null;
  }

  if (!bot.inventory.items().some((i) => i.name === "crafting_table")) {
    const ok = await craftItem(bot, "crafting_table", 1, null);
    if (!ok) {
      return null;
    }
    console.log("[craft] crafted crafting_table (inventory)");
  }

  if (process.env.MC_AI_AUTO_PLACE_CRAFT_TABLE !== "false") {
    await placeBlockBesideBot(bot, "crafting_table");
  }

  return findCraftingTable(bot, Math.max(maxDistance, 12));
}

export function hasBasicTools(bot: Bot): { pick: boolean; sword: boolean; axe: boolean } {
  const items = bot.inventory.items();
  return {
    pick: items.some((i) => i.name.endsWith("_pickaxe")),
    sword: items.some((i) => i.name.endsWith("_sword")),
    axe: items.some((i) => i.name.endsWith("_axe"))
  };
}

/** After chopping: planks → sticks → table → wooden tools. */
export async function processWoodInventory(bot: Bot, maxDistance: number): Promise<string[]> {
  const steps: string[] = [];
  const planksBefore = countPlanks(bot);
  const logsBefore = countLogs(bot);

  if (logsBefore > 0) {
    const n = await craftAllPlanksFromLogs(bot);
    if (n > 0) {
      steps.push(`planks x${countPlanks(bot)}`);
    }
  }

  if (countPlanks(bot) > planksBefore || countLogs(bot) < logsBefore) {
    await craftSticksFromPlanks(bot, 4);
    if (countSticks(bot) > 0) {
      steps.push("sticks");
    }
  }

  const table = await ensureCraftingTable(bot, maxDistance);
  if (!table) {
    if (countLogs(bot) > 0 || countPlanks(bot) > 0) {
      steps.push("need 4 planks for crafting table");
    }
    return steps;
  }

  const tools = hasBasicTools(bot);
  if (!tools.sword && (await craftItem(bot, "wooden_sword", 1, table))) {
    steps.push("wooden_sword");
  }
  if (!tools.pick && (await craftItem(bot, "wooden_pickaxe", 1, table))) {
    steps.push("wooden_pickaxe");
  }
  if (!tools.axe && (await craftItem(bot, "wooden_axe", 1, table))) {
    steps.push("wooden_axe");
  }

  return steps;
}

export function hasNearbyCraftingTable(bot: Bot, maxDistance = 48): boolean {
  return Boolean(findCraftingTable(bot, maxDistance));
}

export async function craftSpecificItem(
  bot: Bot,
  itemKey: string,
  maxDistance = 48,
  count = 1
): Promise<{ ok: boolean; reason?: string }> {
  const key = itemKey.toLowerCase().replace(/\s+/g, "_");

  if (key === "bed") {
    const wool = bot.inventory.items().filter((i) => i.name.endsWith("_wool") || i.name === "wool");
    const woolCount = wool.reduce((n, i) => n + i.count, 0);
    const planks = countPlanks(bot);
    if (woolCount < 3) {
      return { ok: false, reason: `Need 3 wool for a bed (have ${woolCount}).` };
    }
    if (planks < 3) {
      return { ok: false, reason: `Need 3 planks for a bed (have ${planks}).` };
    }
    const table = await ensureCraftingTable(bot, maxDistance);
    if (!table) {
      return { ok: false, reason: "Need a crafting table — place one or give me 4 planks." };
    }
    const made = await craftBedFromInventory(bot, table, count);
    if (made.ok && made.bedName) {
      console.log(`[craft] made ${made.bedName}`);
      return { ok: true, reason: `crafted ${made.bedName.replace(/_/g, " ")}` };
    }
    return {
      ok: false,
      reason: `Could not craft bed — need 3 wool of one color + 3 planks (have ${woolCount} wool, ${planks} planks).`
    };
  }

  if (key === "crafting_table" || key === "crafting table") {
    await craftAllPlanksFromLogs(bot);
    if (countPlanks(bot) < 4) {
      return { ok: false, reason: `Need 4 planks (have ${countPlanks(bot)}).` };
    }
    if (await craftItem(bot, "crafting_table", count, null)) {
      await placeBlockBesideBot(bot, "crafting_table");
      return { ok: true, reason: "crafted and placed crafting table" };
    }
    return { ok: false, reason: "Could not craft crafting table." };
  }

  if (key === "chest") {
    const table = await ensureCraftingTable(bot, maxDistance);
    if (!table) {
      return { ok: false, reason: "Need crafting table for chest." };
    }
    if (countPlanks(bot) < 8) {
      return { ok: false, reason: `Need 8 planks (have ${countPlanks(bot)}).` };
    }
    if (await craftItem(bot, "chest", count, table)) {
      return { ok: true, reason: "crafted chest" };
    }
    return { ok: false, reason: "Could not craft chest." };
  }

  if (key === "furnace") {
    const table = await ensureCraftingTable(bot, maxDistance);
    if (!table) {
      return { ok: false, reason: "Need crafting table for furnace." };
    }
    const cobble = bot.inventory.items().filter((i) => i.name === "cobblestone").reduce((n, i) => n + i.count, 0);
    if (cobble < 8) {
      return { ok: false, reason: `Need 8 cobblestone (have ${cobble}).` };
    }
    if (await craftItem(bot, "furnace", count, table)) {
      return { ok: true, reason: "crafted furnace" };
    }
    return { ok: false, reason: "Could not craft furnace." };
  }

  if (key === "torch" || key === "torches") {
    await craftSticksFromPlanks(bot, 1);
    if (await craftItem(bot, "torch", Math.max(1, count * 4), null)) {
      return { ok: true, reason: "crafted torch" };
    }
    return { ok: false, reason: "Need coal and stick for torches." };
  }

  if (key === "bread") {
    if (await craftItem(bot, "bread", count, null)) {
      return { ok: true, reason: "crafted bread" };
    }
    return { ok: false, reason: "Need 3 wheat for bread." };
  }

  if (key === "stick" || key === "sticks") {
    const made = await craftSticksFromPlanks(bot, count * 4);
    if (made >= count) {
      return { ok: true, reason: "crafted sticks" };
    }
    return { ok: false, reason: "Need 2 planks per stick batch." };
  }

  return { ok: false, reason: `Unknown craft item: ${itemKey}` };
}
