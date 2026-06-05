import { Bot } from "mineflayer";
import { Block } from "prismarine-block";
import { goals, Movements } from "mineflayer-pathfinder";
import { Vec3 } from "vec3";
import {
  AXE_ITEM_NAMES,
  equipToolCategory,
  hasToolCategory,
  PICKAXE_ITEM_NAMES
} from "./bot-inventory";

const CHEST_BLOCKS = new Set(["chest", "trapped_chest"]);

type ChestWindow = {
  inventoryStart: number;
  slots: Array<{ type: number; count: number; name?: string } | null>;
  deposit: (itemType: number, metadata: number | null, count: number) => Promise<void>;
  withdraw: (itemType: number, metadata: number | null, count: number) => Promise<void>;
  close: () => Promise<void> | void;
};

function isChestBlock(block: Block | null): block is Block {
  return block != null && CHEST_BLOCKS.has(block.name);
}

function posKey(pos: Vec3): string {
  return `${pos.x},${pos.y},${pos.z}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chestMatcher(block: Block): boolean {
  return isChestBlock(block);
}

/** Use mineflayer chunk iterator — works once sections are loaded. */
function findChestsWithWorldScan(bot: Bot, maxDistance: number): Block[] {
  const findBlocks = (bot as Bot & { findBlocks?: (opts: object) => Vec3[] }).findBlocks;
  if (!findBlocks) {
    return [];
  }
  const positions = findBlocks.call(bot, {
    matching: chestMatcher,
    maxDistance,
    count: 32
  });
  const chests: Block[] = [];
  const seen = new Set<string>();
  for (const pos of positions) {
    const block = bot.blockAt(pos);
    if (!isChestBlock(block)) {
      continue;
    }
    const key = posKey(block.position);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    chests.push(block);
  }
  return chests;
}

/** Blocks touching Luna (1–2 blocks away) — catches chests right beside her. */
function scanChestBlocksTouching(bot: Bot): Block[] {
  const base = bot.entity.position.floored();
  const chests: Block[] = [];
  const seen = new Set<string>();

  for (let dx = -2; dx <= 2; dx++) {
    for (let dy = -1; dy <= 2; dy++) {
      for (let dz = -2; dz <= 2; dz++) {
        if (dx === 0 && dy === 0 && dz === 0) {
          continue;
        }
        const block = bot.blockAt(base.offset(dx, dy, dz));
        if (!isChestBlock(block)) {
          continue;
        }
        const key = posKey(block.position);
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        chests.push(block);
      }
    }
  }
  return chests;
}

/** Brute-force scan around Luna's feet (catches blocks right beside her). */
function scanChestBlocksLocal(bot: Bot, maxDistance: number): Block[] {
  const center = bot.entity.position.floored();
  const r = Math.ceil(Math.min(maxDistance, 8));
  const seen = new Set<string>();
  const chests: Block[] = [];

  for (let x = -r; x <= r; x++) {
    for (let y = -3; y <= 3; y++) {
      for (let z = -r; z <= r; z++) {
        const pos = center.offset(x, y, z);
        if (bot.entity.position.distanceTo(pos.offset(0.5, 0.5, 0.5)) > maxDistance) {
          continue;
        }
        const block = bot.blockAt(pos);
        if (!isChestBlock(block)) {
          continue;
        }
        const key = posKey(block.position);
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        chests.push(block);
      }
    }
  }
  return chests;
}

function mergeChests(...lists: Block[][]): Block[] {
  const byKey = new Map<string, Block>();
  for (const list of lists) {
    for (const c of list) {
      byKey.set(posKey(c.position), c);
    }
  }
  return [...byKey.values()];
}

async function lookAround(bot: Bot): Promise<void> {
  const baseYaw = bot.entity.yaw;
  const pitch = 0;
  for (const step of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
    try {
      await bot.look(baseYaw + step, pitch, true);
      await delay(120);
    } catch {
      // best effort
    }
  }
}

function applySafeMovements(bot: Bot): void {
  const movements = new Movements(bot);
  movements.canDig = false;
  movements.allow1by1towers = false;
  movements.allowSprinting = true;
  movements.scafoldingBlocks = [];
  bot.pathfinder.setMovements(movements);
}

function waitForGoal(bot: Bot, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      bot.pathfinder.setGoal(null);
      reject(new Error("Pathfinding timed out."));
    }, timeoutMs);

    const onGoal = () => {
      cleanup();
      resolve();
    };

    const cleanup = () => {
      clearTimeout(timer);
      bot.removeListener("goal_reached", onGoal);
      bot.removeListener("path_stop", onGoal);
    };

    bot.on("goal_reached", onGoal);
    bot.on("path_stop", onGoal);
  });
}

/** Walk a small loop so chunk sections load, scanning after each stop. */
async function walkAroundAndScan(bot: Bot, maxDistance: number): Promise<Block[]> {
  applySafeMovements(bot);
  const start = bot.entity.position.floored();
  const patrolRadius = Math.min(5, Math.max(3, Math.floor(maxDistance / 4)));
  const steps = [
    new Vec3(patrolRadius, 0, 0),
    new Vec3(patrolRadius, 0, patrolRadius),
    new Vec3(0, 0, patrolRadius),
    new Vec3(-patrolRadius, 0, patrolRadius),
    new Vec3(-patrolRadius, 0, 0),
    new Vec3(-patrolRadius, 0, -patrolRadius),
    new Vec3(0, 0, -patrolRadius),
    new Vec3(patrolRadius, 0, -patrolRadius),
    new Vec3(0, 0, 0)
  ];

  let best: Block[] = [];

  for (const off of steps) {
    const target = start.plus(off);
    bot.pathfinder.setGoal(new goals.GoalNear(target.x, target.y, target.z, 1));
    try {
      await waitForGoal(bot, 12_000);
    } catch {
      // keep patrolling
    }
    bot.pathfinder.setGoal(null);
    await lookAround(bot);

    const found = mergeChests(
      scanChestBlocksTouching(bot),
      scanChestBlocksLocal(bot, maxDistance),
      findChestsWithWorldScan(bot, maxDistance)
    );
    if (found.length > best.length) {
      best = found;
    }
    if (found.length > 0) {
      console.log(`[chest] spotted ${found.length} chest block(s) while walking`);
      return found;
    }
    await delay(200);
  }

  bot.pathfinder.setGoal(null);
  return best;
}

async function discoverChests(bot: Bot, maxDistance: number): Promise<Block[]> {
  let chests = mergeChests(
    scanChestBlocksTouching(bot),
    scanChestBlocksLocal(bot, maxDistance),
    findChestsWithWorldScan(bot, maxDistance)
  );
  if (chests.length > 0) {
    console.log(`[chest] found ${chests.length} chest block(s) nearby`);
    return chests;
  }

  await lookAround(bot);
  chests = mergeChests(
    scanChestBlocksTouching(bot),
    scanChestBlocksLocal(bot, maxDistance),
    findChestsWithWorldScan(bot, maxDistance)
  );
  if (chests.length > 0) {
    console.log(`[chest] found ${chests.length} after looking around`);
    return chests;
  }

  console.log("[chest] walking nearby to load chunks…");
  return walkAroundAndScan(bot, maxDistance);
}

function chestPartner(bot: Bot, chest: Block): Block | null {
  for (const off of [
    new Vec3(1, 0, 0),
    new Vec3(-1, 0, 0),
    new Vec3(0, 0, 1),
    new Vec3(0, 0, -1)
  ]) {
    const neighbor = bot.blockAt(chest.position.plus(off));
    if (isChestBlock(neighbor)) {
      return neighbor;
    }
  }
  return null;
}

function findDoubleChestPairs(bot: Bot, chests: Block[]): Block[] {
  const used = new Set<string>();
  const openFrom: Block[] = [];

  for (const chest of chests) {
    const key = posKey(chest.position);
    if (used.has(key)) {
      continue;
    }
    const partner = chestPartner(bot, chest);
    if (!partner) {
      continue;
    }
    used.add(key);
    used.add(posKey(partner.position));
    openFrom.push(chest);
  }

  const botPos = bot.entity.position;
  openFrom.sort((a, b) => botPos.distanceTo(a.position) - botPos.distanceTo(b.position));
  return openFrom;
}

function chestSlotsEmpty(window: ChestWindow): boolean {
  for (let i = 0; i < window.inventoryStart; i++) {
    if (window.slots[i] != null) {
      return false;
    }
  }
  return true;
}

function isDoubleChestWindow(window: ChestWindow): boolean {
  return window.inventoryStart >= 54;
}

function isNearBlock(bot: Bot, block: Block): boolean {
  return bot.entity.position.distanceTo(block.position.offset(0.5, 0.5, 0.5)) <= 4.5;
}

async function pathNearBlock(bot: Bot, block: Block): Promise<boolean> {
  if (isNearBlock(bot, block)) {
    return true;
  }
  applySafeMovements(bot);
  const p = block.position;
  bot.pathfinder.setGoal(new goals.GoalNear(p.x, p.y, p.z, 2));
  try {
    await waitForGoal(bot, 30_000);
    bot.pathfinder.setGoal(null);
    return true;
  } catch {
    bot.pathfinder.setGoal(null);
    return false;
  }
}

async function openChestSafely(bot: Bot, block: Block): Promise<ChestWindow | null> {
  try {
    await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true);
    await delay(200);
    return (await bot.openContainer(block)) as ChestWindow;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[chest] could not open chest at (${block.position.x},${block.position.y},${block.position.z}): ${msg}`);
    return null;
  }
}

export type DepositResult = {
  ok: boolean;
  reason?: string;
  moved?: number;
};

function isLogItemName(name: string): boolean {
  return (
    name.endsWith("_log") ||
    name.endsWith("_stem") ||
    name === "crimson_stem" ||
    name === "warped_stem" ||
    name === "mushroom_stem"
  );
}

async function depositFilteredItems(
  bot: Bot,
  targets: Block[],
  filter: (name: string) => boolean,
  requireEmpty: boolean
): Promise<DepositResult> {
  const items = bot.inventory.items().filter((i) => filter(i.name));
  if (items.length === 0) {
    return { ok: false, reason: "Nothing to deposit." };
  }

  for (const chestBlock of targets) {
    const reached = await pathNearBlock(bot, chestBlock);
    if (!reached) {
      console.log(`[chest] could not reach chest at (${chestBlock.position.x},${chestBlock.position.y},${chestBlock.position.z})`);
      continue;
    }

    const container = await openChestSafely(bot, chestBlock);
    if (!container) {
      continue;
    }

    try {
      if (!isDoubleChestWindow(container)) {
        console.log("[chest] opened chest but it is single — need a double chest");
        continue;
      }
      if (requireEmpty && !chestSlotsEmpty(container)) {
        console.log("[chest] double chest is not empty — trying another");
        continue;
      }

      let moved = 0;
      for (const item of [...bot.inventory.items()].filter((i) => filter(i.name))) {
        try {
          await container.deposit(item.type, null, item.count);
          moved += item.count;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.log(`[chest] skip ${item.name}: ${msg}`);
        }
      }

      if (moved > 0) {
        const pos = chestBlock.position;
        console.log(`[chest] stored ${moved} items at (${pos.x}, ${pos.y}, ${pos.z})`);
        return { ok: true, moved, reason: `stored ${moved} items in double chest` };
      }
    } finally {
      await container.close();
    }
  }

  return {
    ok: false,
    reason: requireEmpty
      ? "Found chests but none were empty double chests with space."
      : "Found chests but could not deposit (full or could not open)."
  };
}

async function resolveDoubleChests(bot: Bot, maxDistance: number): Promise<Block[]> {
  const chests = await discoverChests(bot, maxDistance);
  if (chests.length === 0) {
    return [];
  }
  return findDoubleChestPairs(bot, chests);
}

/** Any chest nearby — doubles first, then singles (for taking tools). */
async function resolveChestsNear(bot: Bot, maxDistance: number): Promise<Block[]> {
  const chests = await discoverChests(bot, maxDistance);
  if (chests.length === 0) {
    return [];
  }
  const doubles = findDoubleChestPairs(bot, chests);
  const used = new Set(doubles.map((c) => posKey(c.position)));
  const singles = chests.filter((c) => !used.has(posKey(c.position)));
  const botPos = bot.entity.position;
  singles.sort((a, b) => botPos.distanceTo(a.position) - botPos.distanceTo(b.position));
  return [...doubles, ...singles];
}

function chestHasNamedItem(container: ChestWindow, names: string[]): string | null {
  for (let i = 0; i < container.inventoryStart; i++) {
    const slot = container.slots[i];
    if (slot?.name && names.includes(slot.name)) {
      return slot.name;
    }
  }
  return null;
}

/** Take one pickaxe or axe from a nearby chest and equip it. */
export async function takeToolFromNearbyChest(
  bot: Bot,
  tool: "pickaxe" | "axe",
  maxDistance?: number
): Promise<DepositResult> {
  const radius = maxDistance ?? (Number(process.env.MC_CHEST_SEARCH_RADIUS ?? "48") || 48);
  const category = tool;
  const names = tool === "pickaxe" ? PICKAXE_ITEM_NAMES : AXE_ITEM_NAMES;

  if (hasToolCategory(bot, category)) {
    const held = bot.inventory.items().find((i) => names.includes(i.name));
    return {
      ok: true,
      reason: `already have ${held?.name?.replace(/_/g, " ") ?? tool}`
    };
  }

  const chests = await resolveChestsNear(bot, radius);
  if (chests.length === 0) {
    return { ok: false, reason: `No chest within ${radius} blocks.` };
  }

  for (const chestBlock of chests) {
    const reached = await pathNearBlock(bot, chestBlock);
    if (!reached) {
      continue;
    }

    const container = await openChestSafely(bot, chestBlock);
    if (!container) {
      continue;
    }

    try {
      for (const name of names) {
        if (!chestHasNamedItem(container, [name])) {
          continue;
        }
        const itemId = bot.registry.itemsByName[name]?.id;
        if (itemId == null) {
          continue;
        }
        try {
          await container.withdraw(itemId, null, 1);
          await equipToolCategory(bot, category);
          const label = name.replace(/_/g, " ");
          console.log(`[chest] took ${label} from (${chestBlock.position.x},${chestBlock.position.y},${chestBlock.position.z})`);
          return { ok: true, moved: 1, reason: `took ${label}` };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.log(`[chest] withdraw ${name} failed: ${msg}`);
        }
      }
    } finally {
      await container.close();
    }
  }

  return {
    ok: false,
    reason: `No ${tool} in nearby chests — put one in the chest first.`
  };
}

/**
 * Find a nearby double chest (walks around to refresh chunks), open it, deposit all items.
 */
export async function depositAllToEmptyDoubleChest(
  bot: Bot,
  maxDistance?: number
): Promise<DepositResult> {
  const radius = maxDistance ?? (Number(process.env.MC_CHEST_SEARCH_RADIUS ?? "48") || 48);
  const requireEmpty = process.env.MC_CHEST_REQUIRE_EMPTY !== "false";

  const inv = bot.inventory.items();
  if (inv.length === 0) {
    return { ok: false, reason: "My inventory is already empty." };
  }

  const pairs = await resolveDoubleChests(bot, radius);
  if (pairs.length === 0) {
    return {
      ok: false,
      reason: `No double chest within ${radius} blocks — place two chests side by side.`
    };
  }

  return depositFilteredItems(bot, pairs, () => true, requireEmpty);
}

/** Deposit log items into the nearest double chest. */
export async function depositLogsToNearestDoubleChest(
  bot: Bot,
  maxDistance?: number
): Promise<DepositResult> {
  const radius = maxDistance ?? (Number(process.env.MC_CHEST_SEARCH_RADIUS ?? "48") || 48);
  const pairs = await resolveDoubleChests(bot, radius);
  if (pairs.length === 0) {
    return { ok: false, reason: `No double chest within ${radius} blocks.` };
  }
  return depositFilteredItems(bot, pairs, isLogItemName, false);
}

function isFarmHarvestItem(name: string): boolean {
  return name === "wheat" || name === "wheat_seeds";
}

/** Deposit wheat (and spare seeds) into the nearest double chest. */
export async function depositFarmItemsToNearestDoubleChest(
  bot: Bot,
  maxDistance?: number
): Promise<DepositResult> {
  const radius = maxDistance ?? (Number(process.env.MC_CHEST_SEARCH_RADIUS ?? "48") || 48);
  const pairs = await resolveDoubleChests(bot, radius);
  if (pairs.length === 0) {
    return { ok: false, reason: `No double chest within ${radius} blocks.` };
  }
  return depositFilteredItems(bot, pairs, isFarmHarvestItem, false);
}

function isWheatOnly(name: string): boolean {
  return name === "wheat";
}

/** Deposit harvested wheat only — keeps seeds in inventory for replanting. */
export async function depositWheatToNearestDoubleChest(
  bot: Bot,
  maxDistance?: number
): Promise<DepositResult> {
  const radius = maxDistance ?? (Number(process.env.MC_CHEST_SEARCH_RADIUS ?? "48") || 48);
  const pairs = await resolveDoubleChests(bot, radius);
  if (pairs.length === 0) {
    return { ok: false, reason: `No double chest within ${radius} blocks.` };
  }
  return depositFilteredItems(bot, pairs, isWheatOnly, false);
}

function chestItemCount(container: ChestWindow, itemName: string): number {
  let total = 0;
  for (let i = 0; i < container.inventoryStart; i++) {
    const slot = container.slots[i];
    if (slot?.name === itemName) {
      total += slot.count;
    }
  }
  return total;
}

/** Withdraw wheat seeds from a nearby chest (doubles or singles). */
export async function takeWheatSeedsFromNearbyChest(
  bot: Bot,
  count: number,
  maxDistance?: number
): Promise<DepositResult> {
  const needed = Math.max(1, Math.floor(count));
  const radius = maxDistance ?? (Number(process.env.MC_CHEST_SEARCH_RADIUS ?? "48") || 48);
  const inInv = bot.inventory.items().filter((i) => i.name === "wheat_seeds").reduce((n, i) => n + i.count, 0);
  if (inInv >= needed) {
    return { ok: true, moved: 0, reason: `already have ${inInv} wheat seeds` };
  }

  let stillNeed = needed - inInv;
  const chests = await resolveChestsNear(bot, radius);
  if (chests.length === 0) {
    return { ok: false, reason: `No chest within ${radius} blocks.` };
  }

  const itemId = bot.registry.itemsByName.wheat_seeds?.id;
  if (itemId == null) {
    return { ok: false, reason: "wheat_seeds item not in registry." };
  }

  let withdrawn = 0;
  for (const chestBlock of chests) {
    if (stillNeed <= 0) {
      break;
    }
    const reached = await pathNearBlock(bot, chestBlock);
    if (!reached) {
      continue;
    }

    const container = await openChestSafely(bot, chestBlock);
    if (!container) {
      continue;
    }

    try {
      const available = chestItemCount(container, "wheat_seeds");
      if (available <= 0) {
        continue;
      }
      const take = Math.min(stillNeed, available);
      try {
        await container.withdraw(itemId, null, take);
        withdrawn += take;
        stillNeed -= take;
        console.log(
          `[chest] took ${take} wheat seed(s) from (${chestBlock.position.x},${chestBlock.position.y},${chestBlock.position.z})`
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`[chest] withdraw wheat_seeds failed: ${msg}`);
      }
    } finally {
      await container.close();
    }
  }

  const total = bot.inventory.items().filter((i) => i.name === "wheat_seeds").reduce((n, i) => n + i.count, 0);
  if (withdrawn > 0 || total >= needed) {
    return { ok: true, moved: withdrawn, reason: `took ${withdrawn || total} wheat seed(s)` };
  }

  return {
    ok: false,
    reason: `No wheat seeds in nearby chests — put seeds in the chest first.`
  };
}
