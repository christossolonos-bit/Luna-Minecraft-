import { Bot } from "mineflayer";
import { Block } from "prismarine-block";
import { goals, Movements } from "mineflayer-pathfinder";
import { Vec3 } from "vec3";
import { equipToolCategory } from "./bot-inventory";

const MAX_DIG_REACH = 4.5;

/** Stop pathfinding, collectblock, and an in-progress dig swing. */
export function abortActiveMining(bot: Bot): void {
  try {
    bot.pathfinder.setGoal(null);
    bot.pathfinder.stop();
  } catch {
    // ignore
  }
  bot.clearControlStates();
  if (bot.targetDigBlock) {
    try {
      bot.stopDigging();
    } catch {
      // ignore
    }
  }
  const collector = (bot as Bot & { collectBlock?: { cancelTask: () => Promise<void> } }).collectBlock;
  if (collector?.cancelTask) {
    void collector.cancelTask().catch(() => {});
  }
}

function configureGatherMovements(bot: Bot): Movements {
  const movements = new Movements(bot);
  movements.canDig = true;
  movements.allowSprinting = true;
  movements.dontMineUnderFallingBlock = false;
  movements.dontCreateFlow = false;
  bot.pathfinder.setMovements(movements);
  return movements;
}

function toolPlugin(bot: Bot) {
  return (bot as Bot & { tool?: { equipForBlock: (block: Block, opts?: object) => Promise<void> } })
    .tool;
}

async function pathToMineBlock(bot: Bot, block: Block, timeoutMs: number): Promise<void> {
  const pos = block.position;
  const goal = new goals.GoalGetToBlock(pos.x, pos.y, pos.z);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      bot.pathfinder.setGoal(null);
      reject(new Error(`path to ${block.name} timed out`));
    }, timeoutMs);
    bot.pathfinder
      .goto(goal)
      .then(() => {
        clearTimeout(timer);
        resolve();
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

async function equipForMining(bot: Bot, block: Block, prefer: "pickaxe" | "axe"): Promise<void> {
  const tool = toolPlugin(bot);
  if (tool) {
    try {
      await tool.equipForBlock(block, { requireHarvest: true, getFromChest: false, maxTools: 1 });
      return;
    } catch {
      // fall through to hotbar equip
    }
  }
  await equipToolCategory(bot, prefer);
}

function blockCenter(block: Block): Vec3 {
  return block.position.offset(0.5, 0.5, 0.5);
}

/**
 * Walk adjacent to the block, equip a harvest-capable tool, then dig until broken.
 * Avoids collectBlock GoalLookAtBlock "swing at air" when out of reach.
 */
export async function mineBlockReliably(
  bot: Bot,
  block: Block,
  options: { tool?: "pickaxe" | "axe"; pathTimeoutMs?: number } = {}
): Promise<void> {
  if (!bot.entity) {
    throw new Error("Bot not spawned");
  }

  configureGatherMovements(bot);
  const pathTimeout = options.pathTimeoutMs ?? 25_000;
  const prefer = options.tool ?? "pickaxe";

  try {
    await pathToMineBlock(bot, block, pathTimeout);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/PathStopped|pathfinding timed out/i.test(msg)) {
      throw err;
    }
  }

  const current = bot.blockAt(block.position);
  if (!current || current.name === "air") {
    throw new Error("Block already gone");
  }

  await equipForMining(bot, current, prefer);

  const held = bot.heldItem;
  if (!held) {
    throw new Error(`No tool equipped to mine ${current.name}`);
  }
  if (!current.canHarvest(held.type)) {
    throw new Error(`Cannot harvest ${current.name} with ${held.name} — need a better pickaxe`);
  }

  const dist = bot.entity.position.distanceTo(blockCenter(current));
  if (dist > MAX_DIG_REACH) {
    throw new Error(`Too far to mine ${current.name} (${dist.toFixed(1)}m, need ≤${MAX_DIG_REACH}m)`);
  }

  await bot.lookAt(blockCenter(current), true);

  const digTimeout = Number(process.env.MC_DIG_TIMEOUT_MS ?? "30000") || 30_000;
  await Promise.race([
    bot.dig(current),
    new Promise<never>((_, reject) => {
      setTimeout(() => {
        try {
          bot.stopDigging();
        } catch {
          // ignore
        }
        reject(new Error(`dig ${current.name} timed out`));
      }, digTimeout);
    })
  ]);

  const after = bot.blockAt(block.position);
  if (after && after.name !== "air" && after.name === current.name) {
    throw new Error(`Dig finished but ${current.name} still there`);
  }
}

export function pickaxeOrAxeForBlock(name: string): "pickaxe" | "axe" {
  if (name.endsWith("_log") || name.endsWith("_stem") || name === "mushroom_stem") {
    return "axe";
  }
  return "pickaxe";
}
