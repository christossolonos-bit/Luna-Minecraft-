import { Bot } from "mineflayer";
import { Block } from "prismarine-block";
import { fightHostiles, huntAnimal } from "./bot-combat";
import {
  craftAllPlanksFromLogs,
  craftItem,
  craftSticksFromPlanks,
  ensureCraftingTable,
  findCraftingTable,
  hasNearbyCraftingTable,
  processWoodInventory
} from "./bot-craft";
import { abortActiveMining, mineBlockReliably, pickaxeOrAxeForBlock } from "./bot-gather";
import { prepareToolsForTask } from "./bot-inventory";
import { ActionResult } from "./types";

export { hasNearbyCraftingTable };

export type BotTaskName =
  | "gather_wood"
  | "gather_stone"
  | "gather_coal"
  | "craft_tools"
  | "craft_survival"
  | "deposit_chest"
  | "fight_mobs"
  | "hunt_animal";

export type BotTaskOptions = {
  amount?: number;
  maxDistance?: number;
  timeoutMs?: number;
  target?: string;
};

export type BotTaskResult = ActionResult & {
  detail?: string;
};

const LOG_MATCH = (block: Block) =>
  block.name.endsWith("_log") ||
  block.name.endsWith("_stem") ||
  block.name === "crimson_stem" ||
  block.name === "warped_stem";

const STONE_MATCH = (block: Block) =>
  block.name === "stone" ||
  block.name === "deepslate" ||
  block.name === "andesite" ||
  block.name === "diorite" ||
  block.name === "granite" ||
  block.name === "tuff" ||
  block.name === "calcite";

const COAL_MATCH = (block: Block) =>
  block.name === "coal_ore" || block.name === "deepslate_coal_ore";

const DEPOSIT_ITEM = (name: string) =>
  name.endsWith("_log") ||
  name.endsWith("_planks") ||
  name.endsWith("_stem") ||
  name === "cobblestone" ||
  name === "cobbled_deepslate" ||
  name === "raw_iron" ||
  name === "raw_gold" ||
  name === "raw_copper" ||
  name === "coal" ||
  name === "stick" ||
  name === "flint";

export async function runBotTask(
  bot: Bot,
  task: BotTaskName,
  options: BotTaskOptions = {}
): Promise<BotTaskResult> {
  const amount = Math.max(1, Math.min(options.amount ?? defaultAmount(task), 64));
  const maxDistance = options.maxDistance ?? 48;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const deadline = Date.now() + timeoutMs;

  try {
    if (task !== "craft_tools" && task !== "deposit_chest") {
      await prepareToolsForTask(bot, task);
    }
    switch (task) {
      case "gather_wood":
        return await gatherMatching(bot, LOG_MATCH, amount, maxDistance, deadline);
      case "gather_stone":
        return await gatherMatching(bot, STONE_MATCH, amount, maxDistance, deadline);
      case "gather_coal":
        return await gatherMatching(bot, COAL_MATCH, amount, maxDistance, deadline);
      case "craft_tools":
        return await craftBasicTools(bot, maxDistance);
      case "craft_survival":
        return await craftSurvivalGear(bot, maxDistance);
      case "deposit_chest":
        return await depositToChest(bot, maxDistance);
      case "fight_mobs":
        return await fightHostiles(bot, { maxDistance, timeoutMs: Math.min(timeoutMs, 60_000) });
      case "hunt_animal":
        return await huntAnimal(bot, {
          species: options.target,
          maxDistance: Math.max(maxDistance, 40),
          timeoutMs
        });
      default:
        return { ok: false, action: "run_task", reason: `Unknown task: ${task}` };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, action: "run_task", reason: message };
  }
}

function defaultAmount(task: BotTaskName): number {
  if (task === "craft_tools" || task === "craft_survival" || task === "fight_mobs") {
    return 1;
  }
  if (task === "gather_coal") {
    return Number(process.env.MC_TASK_COAL_AMOUNT ?? "4") || 4;
  }
  return Number(process.env.MC_TASK_GATHER_AMOUNT ?? "8") || 8;
}

function collectBlockPlugin(bot: Bot) {
  return (bot as Bot & { collectBlock?: { collect: (target: Block, options?: object) => Promise<void> } })
    .collectBlock;
}

async function gatherMatching(
  bot: Bot,
  matching: (block: Block) => boolean,
  amount: number,
  maxDistance: number,
  deadline: number
): Promise<BotTaskResult> {
  let collected = 0;
  let lastError = "";

  while (collected < amount && Date.now() < deadline) {
    const block = bot.findBlock({ matching, maxDistance, count: 1 });
    if (!block) {
      break;
    }
    try {
      abortActiveMining(bot);
      await mineBlockReliably(bot, block, {
        tool: pickaxeOrAxeForBlock(block.name),
        pathTimeoutMs: Math.min(25_000, deadline - Date.now())
      });
      collected += 1;
      console.log(`[gather] broke ${block.name} at (${block.position.x},${block.position.y},${block.position.z})`);
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      console.log(`[gather] failed ${block.name}: ${lastError}`);
      break;
    }
  }

  if (collected === 0) {
    return {
      ok: false,
      action: "run_task",
      reason: lastError
        ? lastError
        : `No reachable blocks found within ${maxDistance} blocks.`
    };
  }

  let craftSummary = "";
  if (process.env.MC_AI_AUTO_CRAFT !== "false") {
    const crafted = await processWoodInventory(bot, maxDistance);
    if (crafted.length > 0) {
      craftSummary = crafted.join(", ");
      console.log(`[craft] after wood: ${craftSummary}`);
    }
  }

  return {
    ok: true,
    action: "run_task",
    detail: `collected ${collected}/${amount} blocks${craftSummary ? `; ${craftSummary}` : ""}`
  };
}

async function craftBasicTools(bot: Bot, maxDistance: number): Promise<BotTaskResult> {
  await craftAllPlanksFromLogs(bot);
  await craftSticksFromPlanks(bot, 4);

  const table = await ensureCraftingTable(bot, maxDistance);
  if (!table) {
    const logs = bot.inventory.items().filter((i) => i.name.endsWith("_log")).length;
    const planks = bot.inventory
      .items()
      .filter((i) => i.name.endsWith("_planks"))
      .reduce((n, i) => n + i.count, 0);
    return {
      ok: false,
      action: "run_task",
      reason:
        logs > 0 || planks >= 4
          ? "Could not place a crafting table — clear space beside Luna or place one within 48 blocks."
          : "Gather logs first, then I can craft planks and tools."
    };
  }

  const crafted: string[] = [];

  if (await craftItem(bot, "wooden_sword", 1, table)) {
    crafted.push("wooden_sword");
  }
  if (await craftItem(bot, "wooden_pickaxe", 1, table)) {
    crafted.push("wooden_pickaxe");
  }
  if (await craftItem(bot, "wooden_axe", 1, table)) {
    crafted.push("wooden_axe");
  }
  if (await craftItem(bot, "wooden_shovel", 1, table)) {
    crafted.push("wooden_shovel");
  }

  if (countItem(bot, "cobblestone") >= 3) {
    await craftAllPlanksFromLogs(bot);
    await craftSticksFromPlanks(bot, 4);
    if (await craftItem(bot, "stone_sword", 1, table)) {
      crafted.push("stone_sword");
    }
    if (await craftItem(bot, "stone_pickaxe", 1, table)) {
      crafted.push("stone_pickaxe");
    }
    if (await craftItem(bot, "stone_axe", 1, table)) {
      crafted.push("stone_axe");
    }
  }

  if (countItem(bot, "iron_ingot") >= 2) {
    await craftItem(bot, "stick", 1, null);
    if (await craftItem(bot, "iron_sword", 1, table)) {
      crafted.push("iron_sword");
    }
  }

  if (crafted.length === 0) {
    return {
      ok: false,
      action: "run_task",
      reason: "Not enough materials — gather wood (and stone for stone tools) first."
    };
  }

  return {
    ok: true,
    action: "run_task",
    detail: `crafted ${crafted.join(", ")}`
  };
}

async function craftSurvivalGear(bot: Bot, maxDistance: number): Promise<BotTaskResult> {
  await craftAllPlanksFromLogs(bot);
  await craftSticksFromPlanks(bot, 4);

  const table = await ensureCraftingTable(bot, maxDistance);
  if (!table) {
    return {
      ok: false,
      action: "run_task",
      reason: "Need logs → planks → crafting table before survival crafting."
    };
  }

  const crafted: string[] = [];

  const cobble = countItem(bot, "cobblestone");
  const sticks = countItem(bot, "stick");
  const hasStonePick = bot.inventory.items().some((i) => i.name === "stone_pickaxe");
  if (cobble >= 3 && sticks >= 2 && !hasStonePick) {
    if (await craftItem(bot, "stone_pickaxe", 1, table)) {
      crafted.push("stone_pickaxe");
    }
  }

  if (countItem(bot, "cobblestone") >= 8 && !bot.inventory.items().some((i) => i.name === "furnace")) {
    if (await craftItem(bot, "furnace", 1, table)) {
      crafted.push("furnace");
    }
  }

  if (countItem(bot, "coal") >= 1 && countItem(bot, "stick") >= 1) {
    if (await craftItem(bot, "torch", 8, null)) {
      crafted.push("torch");
    }
  }

  if (countItem(bot, "wheat") >= 3) {
    if (await craftItem(bot, "bread", 1, null)) {
      crafted.push("bread");
    }
  }

  const leather = countItem(bot, "leather");
  if (leather >= 8 && !bot.inventory.items().some((i) => i.name.endsWith("_chestplate"))) {
    if (await craftItem(bot, "leather_chestplate", 1, table)) {
      crafted.push("leather_chestplate");
    }
  }

  if (countItem(bot, "iron_ingot") >= 8) {
    if (await craftItem(bot, "iron_chestplate", 1, table)) {
      crafted.push("iron_chestplate");
    }
    if (countItem(bot, "iron_ingot") >= 1 && countItem(bot, "stick") >= 1) {
      if (await craftItem(bot, "shield", 1, table)) {
        crafted.push("shield");
      }
    }
  }

  if (crafted.length === 0) {
    const tools = await craftBasicTools(bot, maxDistance);
    if (tools.ok) {
      return { ok: true, action: "run_task", detail: `fallback tools: ${tools.detail ?? "ok"}` };
    }
    return {
      ok: false,
      action: "run_task",
      reason: "Need coal+stick, wheat, leather, or iron for survival gear — gather resources first."
    };
  }

  return {
    ok: true,
    action: "run_task",
    detail: `survival gear: ${crafted.join(", ")}`
  };
}

function countItem(bot: Bot, name: string): number {
  return bot.inventory.items().filter((i) => i.name === name).reduce((n, i) => n + i.count, 0);
}

async function depositToChest(bot: Bot, maxDistance: number): Promise<BotTaskResult> {
  const chestBlock = bot.findBlock({
    matching: (b) => b.name === "chest" || b.name === "trapped_chest",
    maxDistance,
    count: 1
  });
  if (!chestBlock) {
    return {
      ok: false,
      action: "run_task",
      reason: "No chest found within 48 blocks."
    };
  }

  const collector = collectBlockPlugin(bot);
  if (collector && "chestLocations" in collector) {
    const locs = (collector as { chestLocations: { x: number; y: number; z: number }[] }).chestLocations;
    const pos = chestBlock.position;
    const exists = locs.some((p) => p.x === pos.x && p.y === pos.y && p.z === pos.z);
    if (!exists) {
      locs.push(pos);
    }
  }

  const container = await bot.openContainer(chestBlock);
  let moved = 0;
  try {
    for (const item of [...bot.inventory.items()]) {
      if (!DEPOSIT_ITEM(item.name)) {
        continue;
      }
      await container.deposit(item.type, null, item.count);
      moved += item.count;
    }
  } finally {
    await container.close();
  }

  if (moved === 0) {
    return {
      ok: false,
      action: "run_task",
      reason: "Nothing to deposit (gather wood/stone first)."
    };
  }

  return {
    ok: true,
    action: "run_task",
    detail: `stored ${moved} items in chest`
  };
}

export function sampleInventory(bot: Bot): { name: string; count: number }[] {
  const map = new Map<string, number>();
  for (const item of bot.inventory.items()) {
    map.set(item.name, (map.get(item.name) ?? 0) + item.count);
  }
  return [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 16);
}

export function hasNearbyChest(bot: Bot, maxDistance = 48): boolean {
  return Boolean(
    bot.findBlock({
      matching: (b) => b.name === "chest" || b.name === "trapped_chest",
      maxDistance,
      count: 1
    })
  );
}
