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
import { depositAllToEmptyDoubleChest, takeToolFromNearbyChest } from "./bot-chest";
import { abortActiveMining, mineBlockReliably, pickaxeOrAxeForBlock } from "./bot-gather";
import { buildHouseAroundSign } from "./bot-build";
import { collectWheatAndStash, plantWheatAtFarm } from "./bot-farm";
import { chopTreeAndStash, summarizeBotLogInventory } from "./bot-tree";
import { minePendingOres, stripMineFromHere } from "./bot-strip-mine";
import { isSleepRoutineActive } from "./bot-sleep";
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
  | "hunt_animal"
  | "take_tool"
  | "check_logs"
  | "collect_wheat"
  | "plant_wheat"
  | "build_house"
  | "strip_mine"
  | "mine_ores";

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

export async function runBotTask(
  bot: Bot,
  task: BotTaskName,
  options: BotTaskOptions = {}
): Promise<BotTaskResult> {
  const amount = Math.max(1, Math.min(options.amount ?? defaultAmount(task), 64));
  const maxDistance = options.maxDistance ?? 48;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const deadline = Date.now() + timeoutMs;

  if (isSleepRoutineActive()) {
    return { ok: false, action: "run_task", reason: "paused — owner is sleeping" };
  }

  try {
    if (
      task !== "craft_tools" &&
      task !== "deposit_chest" &&
      task !== "take_tool" &&
      task !== "check_logs" &&
      task !== "collect_wheat" &&
      task !== "plant_wheat" &&
      task !== "build_house"
    ) {
      await prepareToolsForTask(bot, task);
    }
    switch (task) {
      case "gather_wood":
        return await gatherWoodTree(bot, maxDistance, deadline);
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
      case "take_tool": {
        const kind = options.target === "pickaxe" ? "pickaxe" : "axe";
        const taken = await takeToolFromNearbyChest(bot, kind, maxDistance);
        return {
          ok: taken.ok,
          action: "run_task",
          reason: taken.reason,
          detail: taken.ok ? taken.reason : undefined
        };
      }
      case "check_logs": {
        const summary = summarizeBotLogInventory(bot);
        const msg = summary.canPillar ? `Yes — ${summary.message}` : summary.message;
        return {
          ok: true,
          action: "run_task",
          reason: msg,
          detail: summary.canPillar ? "can_pillar" : "no_logs"
        };
      }
      case "collect_wheat": {
        const farmRadius = Number(process.env.MC_FARM_RADIUS ?? "64") || 64;
        const farmTimeout = options.timeoutMs ?? 300_000;
        const result = await collectWheatAndStash(
          bot,
          options.maxDistance ?? farmRadius,
          Date.now() + farmTimeout
        );
        return {
          ok: result.ok,
          action: "run_task",
          reason: result.reason,
          detail: result.ok ? result.reason : undefined
        };
      }
      case "plant_wheat": {
        const result = await plantWheatAtFarm(bot, maxDistance, deadline);
        return {
          ok: result.ok,
          action: "run_task",
          reason: result.reason,
          detail: result.ok ? result.reason : undefined
        };
      }
      case "build_house": {
        const buildDeadline = Date.now() + Math.max(timeoutMs, 600_000);
        const result = await buildHouseAroundSign(bot, maxDistance, buildDeadline);
        return {
          ok: result.ok,
          action: "run_task",
          reason: result.reason,
          detail: result.detail ?? (result.incomplete ? "incomplete" : result.ok ? result.reason : undefined)
        };
      }
      case "strip_mine": {
        const segments = Math.max(1, Math.min(amount, 32));
        const result = await stripMineFromHere(bot, {
          segments,
          deadline,
          resume: options.target === "resume",
          continuous: options.target !== "finite"
        });
        return {
          ok: result.ok,
          action: "run_task",
          reason: result.reason,
          detail: result.detail ?? (result.ok ? result.reason : undefined)
        };
      }
      case "mine_ores": {
        const result = await minePendingOres(bot, deadline);
        return {
          ok: result.ok,
          action: "run_task",
          reason: result.reason,
          detail: result.ok ? result.reason : undefined
        };
      }
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
  if (task === "strip_mine") {
    return Number(process.env.MC_STRIP_MINE_SEGMENTS ?? "6") || 6;
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

async function gatherWoodTree(
  bot: Bot,
  maxDistance: number,
  deadline: number
): Promise<BotTaskResult> {
  const result = await chopTreeAndStash(bot, maxDistance, deadline);
  return {
    ok: result.ok,
    action: "run_task",
    reason: result.reason,
    detail: result.ok ? result.reason : undefined
  };
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
    if (isSleepRoutineActive()) {
      return {
        ok: collected > 0,
        action: "run_task",
        reason: collected > 0 ? `paused after ${collected} blocks` : "paused — owner is sleeping"
      };
    }
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
  const result = await depositAllToEmptyDoubleChest(bot, maxDistance);
  return {
    ok: result.ok,
    action: "run_task",
    reason: result.reason,
    detail: result.ok ? result.reason : undefined
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
