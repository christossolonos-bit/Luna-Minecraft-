import { Bot } from "mineflayer";
import { Block } from "prismarine-block";
import { goals, Movements } from "mineflayer-pathfinder";
import { Vec3 } from "vec3";
import { equipToolCategory } from "./bot-inventory";
import { isBedBlock, isSleepRoutineActive } from "./bot-sleep";
import { addProtectedBlocksToMovements, refuseProtectedDig } from "./bot-protect";

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

export function configureGatherMovements(bot: Bot): Movements {
  const movements = new Movements(bot);
  movements.canDig = true;
  movements.allowSprinting = true;
  movements.dontMineUnderFallingBlock = false;
  movements.dontCreateFlow = false;
  addProtectedBlocksToMovements(bot, movements);
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function blockIsGone(bot: Bot, pos: Vec3): boolean {
  const b = bot.blockAt(pos);
  return !b || b.name === "air";
}

/** Resolve when the block at `pos` becomes air (backup if dig promise ends early). */
function waitForBlockBroken(bot: Bot, pos: Vec3, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (blockIsGone(bot, pos)) {
      resolve();
      return;
    }

    const onUpdate = (oldBlock: Block | null, newBlock: Block | null) => {
      if (newBlock?.position.equals(pos) && (!newBlock || newBlock.name === "air")) {
        cleanup();
        resolve();
      }
      if (oldBlock?.position.equals(pos) && blockIsGone(bot, pos)) {
        cleanup();
        resolve();
      }
    };

    const timer = setTimeout(() => {
      cleanup();
      if (blockIsGone(bot, pos)) {
        resolve();
      } else {
        reject(new Error("mining timed out"));
      }
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      bot.removeListener("blockUpdate", onUpdate);
    };

    bot.on("blockUpdate", onUpdate);
  });
}

function stopOtherDig(bot: Bot, pos: Vec3): void {
  const target = bot.targetDigBlock;
  if (target && !target.position.equals(pos)) {
    try {
      bot.stopDigging();
    } catch {
      // ignore
    }
  }
}

/**
 * Hold dig on a block until it breaks — retries if a swing is interrupted.
 * Uses force-look + raycast face so the axe stays on target.
 */
export async function holdDigUntilBroken(
  bot: Bot,
  block: Block,
  options: { tool?: "pickaxe" | "axe"; maxRetries?: number } = {}
): Promise<void> {
  if (!bot.entity) {
    throw new Error("Bot not spawned");
  }
  if (isSleepRoutineActive()) {
    throw new Error("paused — owner is sleeping");
  }
  if (isBedBlock(block)) {
    throw new Error("will not break a bed");
  }
  if (refuseProtectedDig(block, "protected workstation")) {
    throw new Error(`will not break ${block.name}`);
  }

  const pos = block.position.clone();
  const prefer = options.tool ?? "pickaxe";
  const maxRetries = options.maxRetries ?? 6;
  const digTimeout = Number(process.env.MC_DIG_TIMEOUT_MS ?? "45000") || 45_000;

  if (blockIsGone(bot, pos)) {
    return;
  }

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (isSleepRoutineActive()) {
      throw new Error("paused — owner is sleeping");
    }

    const current = bot.blockAt(pos);
    if (!current || current.name === "air") {
      return;
    }

    stopOtherDig(bot, pos);
    await equipForMining(bot, current, prefer);

    const held = bot.heldItem;
    if (!held) {
      throw new Error(`No tool equipped to mine ${current.name}`);
    }
    if (!current.canHarvest(held.type)) {
      throw new Error(`Cannot harvest ${current.name} with ${held.name}`);
    }
    if (!bot.canDigBlock(current)) {
      throw new Error(`Cannot reach ${current.name} to mine`);
    }

    const dist = bot.entity.position.distanceTo(blockCenter(current));
    if (dist > MAX_DIG_REACH) {
      throw new Error(`Too far to mine ${current.name} (${dist.toFixed(1)}m)`);
    }

    await bot.lookAt(blockCenter(current), true);
    bot.clearControlStates();

    try {
      await Promise.race([
        bot.dig(current, true, "raycast"),
        waitForBlockBroken(bot, pos, digTimeout)
      ]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!blockIsGone(bot, pos)) {
        console.log(`[gather] mining attempt ${attempt + 1}/${maxRetries} interrupted: ${msg}`);
        try {
          bot.stopDigging();
        } catch {
          // ignore
        }
        await delay(120 + attempt * 40);
        continue;
      }
    }

    if (blockIsGone(bot, pos)) {
      try {
        bot.stopDigging();
      } catch {
        // ignore
      }
      return;
    }

    console.log(`[gather] mining attempt ${attempt + 1}/${maxRetries} — ${current.name} still there`);
    try {
      bot.stopDigging();
    } catch {
      // ignore
    }
    await delay(100 + attempt * 30);
  }

  const left = bot.blockAt(pos);
  if (left && left.name !== "air") {
    throw new Error(`Mining failed — ${left.name} still at (${pos.x},${pos.y},${pos.z})`);
  }
}

/** Dig a block already in reach — no pathfinding (for tree trunk mining). */
export async function digBlockInReach(
  bot: Bot,
  block: Block,
  options: { tool?: "pickaxe" | "axe" } = {}
): Promise<void> {
  await holdDigUntilBroken(bot, block, options);
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
  if (isSleepRoutineActive()) {
    throw new Error("paused — owner is sleeping");
  }
  if (isBedBlock(block)) {
    throw new Error("will not break a bed");
  }
  if (refuseProtectedDig(block, "protected workstation")) {
    throw new Error(`will not break ${block.name}`);
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

  bot.pathfinder.setGoal(null);
  await digBlockInReach(bot, block, { tool: prefer });
}

export function pickaxeOrAxeForBlock(name: string): "pickaxe" | "axe" {
  if (name.endsWith("_log") || name.endsWith("_stem") || name === "mushroom_stem") {
    return "axe";
  }
  return "pickaxe";
}
