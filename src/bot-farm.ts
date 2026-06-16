import { Bot } from "mineflayer";
import { Block } from "prismarine-block";
import { goals, Movements } from "mineflayer-pathfinder";
import { Vec3 } from "vec3";
import {
  depositFarmItemsToNearestDoubleChest,
  depositWheatToNearestDoubleChest,
  takeWheatSeedsFromNearbyChest
} from "./bot-chest";
import { abortActiveMining } from "./bot-gather";
import { isSleepRoutineActive } from "./bot-sleep";

const WHEAT_AGE_MATURE = 7;
const MAX_HARVEST_REACH = 4.5;
const MAX_WHEAT_SCAN = 512;
const HARVEST_LOG_EVERY = 8;
const STASH_WHEAT_AT = 32;
const PATH_ATTEMPTS_PER_PLOT = 3;

export type CollectWheatResult = {
  ok: boolean;
  reason?: string;
  harvested?: number;
  stashed?: number;
  planted?: number;
};

/** Plots where wheat was harvested this session (air above farmland). */
let lastHarvestedPlots: Vec3[] = [];

export function getLastHarvestedPlots(): Vec3[] {
  return lastHarvestedPlots.map((p) => p.clone());
}

function posKey(pos: Vec3): string {
  return `${pos.x},${pos.y},${pos.z}`;
}

function cropAge(block: Block): number {
  const props = (block as Block & { _properties?: Record<string, string | number> })._properties;
  if (props?.age != null) {
    return Number(props.age);
  }
  return block.metadata ?? 0;
}

export function isMatureWheat(block: Block | null): block is Block {
  return !!block && block.name === "wheat" && cropAge(block) >= WHEAT_AGE_MATURE;
}

function wheatSearchOrigin(bot: Bot): Vec3 {
  const ownerName = (process.env.MC_OWNER ?? "").trim();
  const owner = ownerName ? bot.players[ownerName]?.entity : undefined;
  return owner?.position ?? bot.entity.position;
}

function countWheatItems(bot: Bot): number {
  return bot.inventory.items().filter((i) => i.name === "wheat").reduce((n, i) => n + i.count, 0);
}

function countSeedsInInventory(bot: Bot): number {
  return bot.inventory.items().filter((i) => i.name === "wheat_seeds").reduce((n, i) => n + i.count, 0);
}

function blockCenter(pos: Vec3): Vec3 {
  return pos.offset(0.5, 0.5, 0.5);
}

function isInHarvestReach(bot: Bot, pos: Vec3): boolean {
  return bot.entity.position.distanceTo(blockCenter(pos)) <= MAX_HARVEST_REACH;
}

function configureFarmMovements(bot: Bot): void {
  const movements = new Movements(bot);
  movements.canDig = true;
  movements.allowSprinting = true;
  bot.pathfinder.setMovements(movements);
}

async function waitForGoal(bot: Bot, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
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
    };

    bot.on("goal_reached", onGoal);
  });
}

async function pathNearBlock(bot: Bot, pos: Vec3, timeoutMs: number): Promise<boolean> {
  if (isInHarvestReach(bot, pos)) {
    return true;
  }
  configureFarmMovements(bot);
  const goal = new goals.GoalGetToBlock(pos.x, pos.y, pos.z);
  bot.pathfinder.setGoal(goal);
  try {
    await Promise.race([
      bot.pathfinder.goto(goal),
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs))
    ]);
    bot.pathfinder.setGoal(null);
    return isInHarvestReach(bot, pos);
  } catch {
    bot.pathfinder.setGoal(null);
    return isInHarvestReach(bot, pos);
  }
}

async function pickupFarmDrops(bot: Bot, maxDistance: number, deadline: number): Promise<void> {
  for (let round = 0; round < 24 && Date.now() < deadline; round++) {
    const drop = bot.nearestEntity((entity) => {
      if (entity.name !== "item" || !entity.position || entity === bot.entity) {
        return false;
      }
      return entity.position.distanceTo(bot.entity.position) <= maxDistance;
    });
    if (!drop?.position) {
      return;
    }
    if (bot.entity.position.distanceTo(drop.position) <= 1.8) {
      await delay(250);
      continue;
    }
    configureFarmMovements(bot);
    bot.pathfinder.setGoal(new goals.GoalNear(drop.position.x, drop.position.y, drop.position.z, 0.6));
    try {
      await waitForGoal(bot, 4000);
    } catch {
      // may still pick up while moving
    }
    bot.pathfinder.setGoal(null);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function quickHarvestWheatAt(bot: Bot, pos: Vec3): Promise<boolean> {
  const current = bot.blockAt(pos);
  if (!isMatureWheat(current)) {
    return false;
  }

  try {
    await bot.lookAt(current.position.offset(0.5, 0.5, 0.5), true);
    await bot.dig(current);
    return !isMatureWheat(bot.blockAt(pos));
  } catch {
    return false;
  }
}

function sortPositionsByDistance(positions: Vec3[], from: Vec3): void {
  positions.sort(
    (a, b) => from.distanceTo(blockCenter(a)) - from.distanceTo(blockCenter(b))
  );
}

function mergeMatureWheatTargets(
  bot: Bot,
  maxDistance: number,
  queue: Vec3[],
  harvested: Set<string>,
  queued: Set<string>
): number {
  const found = findMatureWheatPositions(bot, maxDistance);
  let added = 0;
  for (const pos of found) {
    const key = posKey(pos);
    if (harvested.has(key) || queued.has(key)) {
      continue;
    }
    if (!isMatureWheat(bot.blockAt(pos))) {
      continue;
    }
    queue.push(pos.clone());
    queued.add(key);
    added += 1;
  }
  return added;
}

async function maybeStashHarvestedWheat(bot: Bot, maxDistance: number): Promise<void> {
  if (countWheatItems(bot) < STASH_WHEAT_AT) {
    return;
  }
  const deposit = await depositWheatToNearestDoubleChest(bot, maxDistance);
  if ((deposit.moved ?? 0) > 0) {
    console.log(`[farm] stashed ${deposit.moved} wheat mid-harvest`);
  }
}

async function harvestMatureWheatBatch(
  bot: Bot,
  maxDistance: number,
  deadline: number
): Promise<{ blocksBroken: number; harvestedPlots: Vec3[]; lastError: string }> {
  const harvested = new Set<string>();
  const queued = new Set<string>();
  const pathAttempts = new Map<string, number>();
  const positions: Vec3[] = [];
  const harvestedPlots: Vec3[] = [];
  let blocksBroken = 0;
  let lastError = "";

  let added = mergeMatureWheatTargets(bot, maxDistance, positions, harvested, queued);
  console.log(`[farm] found ${added} mature wheat plant(s) to harvest`);

  while (Date.now() < deadline && !isSleepRoutineActive()) {
    if (positions.length === 0) {
      added = mergeMatureWheatTargets(bot, maxDistance, positions, harvested, queued);
      if (added === 0) {
        break;
      }
      console.log(`[farm] found ${added} more mature wheat plant(s)`);
    }

    sortPositionsByDistance(positions, bot.entity.position);
    let harvestedThisRound = 0;

    for (let i = positions.length - 1; i >= 0; i--) {
      const pos = positions[i]!;
      if (!isInHarvestReach(bot, pos)) {
        continue;
      }
      if (await quickHarvestWheatAt(bot, pos)) {
        const key = posKey(pos);
        blocksBroken += 1;
        harvestedThisRound += 1;
        harvestedPlots.push(pos.clone());
        harvested.add(key);
        queued.delete(key);
        positions.splice(i, 1);
        if (blocksBroken % HARVEST_LOG_EVERY === 0) {
          console.log(`[farm] harvested ${blocksBroken} wheat plant(s)…`);
        }
        await maybeStashHarvestedWheat(bot, maxDistance);
      }
    }

    if (harvestedThisRound > 0) {
      continue;
    }

    const next = positions[0];
    if (!next) {
      continue;
    }

    if (!isMatureWheat(bot.blockAt(next))) {
      const key = posKey(next);
      harvested.add(key);
      queued.delete(key);
      positions.shift();
      continue;
    }

    const key = posKey(next);
    if (!(await pathNearBlock(bot, next, 8000))) {
      lastError = `Could not reach wheat at (${next.x},${next.y},${next.z})`;
      const tries = (pathAttempts.get(key) ?? 0) + 1;
      pathAttempts.set(key, tries);
      if (tries >= PATH_ATTEMPTS_PER_PLOT) {
        harvested.add(key);
        queued.delete(key);
        positions.shift();
      } else {
        positions.push(positions.shift()!);
      }
      continue;
    }
    pathAttempts.delete(key);
  }

  await pickupFarmDrops(bot, maxDistance, deadline);

  return { blocksBroken, harvestedPlots, lastError };
}

function findMatureWheatPositions(bot: Bot, maxDistance: number): Vec3[] {
  const findBlocks = (bot as Bot & { findBlocks?: (opts: object) => Vec3[] }).findBlocks;
  if (!findBlocks) {
    const single = bot.findBlock({ matching: isMatureWheat, maxDistance, count: 1 });
    return single ? [single.position] : [];
  }
  return findBlocks.call(bot, {
    matching: isMatureWheat,
    maxDistance,
    count: MAX_WHEAT_SCAN
  });
}

function isPlantablePlot(bot: Bot, plotPos: Vec3): boolean {
  const farmland = bot.blockAt(plotPos.offset(0, -1, 0));
  if (!farmland || farmland.name !== "farmland") {
    return false;
  }
  const above = bot.blockAt(plotPos);
  return !above || above.name === "air";
}

function findEmptyFarmlandPlots(bot: Bot, maxDistance: number, origin: Vec3): Vec3[] {
  const findBlocks = (bot as Bot & { findBlocks?: (opts: object) => Vec3[] }).findBlocks;
  const farmlandMatcher = (block: Block) => block.name === "farmland";
  let positions: Vec3[] = [];

  if (findBlocks) {
    positions = findBlocks.call(bot, { matching: farmlandMatcher, maxDistance, count: 256 });
  } else {
    const single = bot.findBlock({ matching: farmlandMatcher, maxDistance, count: 1 });
    if (single) {
      positions = [single.position];
    }
  }

  const plots: Vec3[] = [];
  const seen = new Set<string>();
  for (const pos of positions) {
    const plot = pos.offset(0, 1, 0);
    const key = posKey(plot);
    if (seen.has(key) || !isPlantablePlot(bot, plot)) {
      continue;
    }
    seen.add(key);
    plots.push(plot);
  }

  plots.sort((a, b) => {
    const da = origin.distanceTo(a.offset(0.5, 0.5, 0.5));
    const db = origin.distanceTo(b.offset(0.5, 0.5, 0.5));
    return da - db;
  });
  return plots;
}

function dedupePlots(plots: Vec3[]): Vec3[] {
  const seen = new Set<string>();
  const out: Vec3[] = [];
  for (const p of plots) {
    const key = posKey(p);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(p.clone());
  }
  return out;
}

async function equipWheatSeeds(bot: Bot): Promise<boolean> {
  if (bot.heldItem?.name === "wheat_seeds") {
    return true;
  }
  const stack = bot.inventory.items().find((i) => i.name === "wheat_seeds");
  if (!stack) {
    return false;
  }
  await bot.equip(stack, "hand");
  return bot.heldItem?.name === "wheat_seeds";
}

async function plantSeedInReach(bot: Bot, plotPos: Vec3): Promise<boolean> {
  if (!isPlantablePlot(bot, plotPos) || countSeedsInInventory(bot) === 0) {
    return false;
  }
  if (!isInHarvestReach(bot, plotPos)) {
    return false;
  }
  if (bot.heldItem?.name !== "wheat_seeds" && !(await equipWheatSeeds(bot))) {
    return false;
  }

  const farmland = bot.blockAt(plotPos.offset(0, -1, 0));
  if (!farmland || farmland.name !== "farmland") {
    return false;
  }

  const air = bot.blockAt(plotPos);
  if (!air || air.name !== "air") {
    return false;
  }

  await bot.lookAt(farmland.position.offset(0.5, 1, 0.5), true);
  try {
    await bot.placeBlock(farmland, new Vec3(0, 1, 0));
    return bot.blockAt(plotPos)?.name === "wheat";
  } catch {
    return false;
  }
}

async function plantSeedsBatch(bot: Bot, plots: Vec3[], deadline: number): Promise<number> {
  const remaining = [...plots];
  let planted = 0;
  let skipStreak = 0;

  if (!(await equipWheatSeeds(bot))) {
    return 0;
  }

  while (remaining.length > 0 && Date.now() < deadline && !isSleepRoutineActive()) {
    let plantedThisRound = 0;

    for (let i = remaining.length - 1; i >= 0; i--) {
      const plot = remaining[i]!;
      if (countSeedsInInventory(bot) === 0) {
        return planted;
      }
      if (await plantSeedInReach(bot, plot)) {
        planted += 1;
        plantedThisRound += 1;
        remaining.splice(i, 1);
      }
    }

    if (plantedThisRound > 0) {
      skipStreak = 0;
      continue;
    }

    sortPositionsByDistance(remaining, bot.entity.position);
    const next = remaining[0]!;
    if (!isPlantablePlot(bot, next)) {
      remaining.shift();
      continue;
    }
    if (!(await pathNearBlock(bot, next, 6000))) {
      skipStreak += 1;
      remaining.shift();
      if (skipStreak >= 4) {
        break;
      }
      continue;
    }
    skipStreak = 0;
  }

  return planted;
}

/**
 * Take wheat seeds from chest and plant on harvested farm plots (or empty farmland nearby).
 */
export async function plantWheatAtFarm(
  bot: Bot,
  maxDistance = 48,
  deadline = Date.now() + 120_000
): Promise<CollectWheatResult> {
  if (isSleepRoutineActive()) {
    return { ok: false, reason: "paused — owner is sleeping" };
  }

  abortActiveMining(bot);
  bot.pathfinder.setGoal(null);

  const origin = wheatSearchOrigin(bot);
  let plots = dedupePlots(lastHarvestedPlots).filter((p) => isPlantablePlot(bot, p));
  if (plots.length === 0) {
    plots = findEmptyFarmlandPlots(bot, maxDistance, origin);
  }
  if (plots.length === 0) {
    return { ok: false, reason: "No empty farmland to plant — harvest wheat first or clear the plots." };
  }

  const seedsNeeded = plots.length;
  const seedsResult = await takeWheatSeedsFromNearbyChest(bot, seedsNeeded, maxDistance);
  const seedsHave = countSeedsInInventory(bot);
  if (seedsHave === 0) {
    return { ok: false, reason: seedsResult.reason ?? "No wheat seeds in chest." };
  }

  console.log(`[farm] planting on ${plots.length} plot(s) — ${seedsHave} seed(s) in inventory`);

  const planted = await plantSeedsBatch(bot, plots, deadline);

  if (planted === 0) {
    return { ok: false, reason: "Could not plant wheat — stand closer to the farm." };
  }

  const msg = `Planted ${planted} wheat seed(s) at the farm.`;
  console.log(`[farm] ${msg}`);
  return { ok: true, planted, reason: msg };
}

/**
 * Harvest mature wheat, stash in chest, then replant from chest seeds on those same plots.
 */
export async function collectWheatAndStash(
  bot: Bot,
  maxDistance = 64,
  deadline = Date.now() + 300_000
): Promise<CollectWheatResult> {
  if (isSleepRoutineActive()) {
    return { ok: false, reason: "paused — owner is sleeping" };
  }

  abortActiveMining(bot);
  bot.pathfinder.setGoal(null);

  console.log(`[farm] collecting mature wheat within ${maxDistance}m`);

  const harvestDeadline = deadline - 60_000;

  const { blocksBroken, harvestedPlots, lastError } = await harvestMatureWheatBatch(
    bot,
    maxDistance,
    harvestDeadline
  );

  if (blocksBroken > 0) {
    console.log(`[farm] harvested ${blocksBroken} wheat plant(s)`);
  }

  lastHarvestedPlots = dedupePlots(harvestedPlots);

  const wheatHeld = countWheatItems(bot);
  if (blocksBroken === 0 && wheatHeld === 0) {
    return {
      ok: false,
      reason: lastError || `No grown wheat within ${maxDistance} blocks.`
    };
  }

  let stashed = 0;
  if (wheatHeld > 0 || countSeedsInInventory(bot) > 0) {
    const deposit = await depositFarmItemsToNearestDoubleChest(bot, maxDistance);
    stashed = deposit.moved ?? 0;
    if (!deposit.ok && blocksBroken > 0 && wheatHeld > 0) {
      return {
        ok: true,
        harvested: wheatHeld,
        stashed: 0,
        reason: `Harvested ${blocksBroken} wheat but could not stash: ${deposit.reason}`
      };
    }
  }

  let planted = 0;
  let plantMsg = "";
  if (lastHarvestedPlots.length > 0 && Date.now() < deadline) {
    const plantResult = await plantWheatAtFarm(bot, maxDistance, deadline);
    planted = plantResult.planted ?? 0;
    plantMsg = plantResult.ok ? ` ${plantResult.reason}` : plantResult.reason ? ` ${plantResult.reason}` : "";
  }

  const msg =
    stashed > 0 && planted > 0
      ? `Collected ${stashed} wheat, stashed in chest, planted ${planted} seeds.`
      : stashed > 0
        ? `Collected ${stashed} wheat and put it in the chest.${plantMsg}`
        : blocksBroken > 0
          ? `Harvested ${blocksBroken} wheat plant(s).${plantMsg}`
          : `No grown wheat to collect.${plantMsg}`;

  console.log(`[farm] ${msg}`);
  return {
    ok: blocksBroken > 0 || stashed > 0 || planted > 0,
    harvested: wheatHeld,
    stashed,
    planted,
    reason: msg
  };
}
