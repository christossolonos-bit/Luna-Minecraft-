import { Bot } from "mineflayer";
import { Block } from "prismarine-block";
import { goals, Movements } from "mineflayer-pathfinder";
import { Vec3 } from "vec3";
import {
  depositFarmItemsToNearestDoubleChest,
  takeWheatSeedsFromNearbyChest
} from "./bot-chest";
import { abortActiveMining } from "./bot-gather";
import { isSleepRoutineActive } from "./bot-sleep";

const WHEAT_AGE_MATURE = 7;
const MAX_HARVEST_REACH = 4.5;

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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function collectBlockPlugin(bot: Bot) {
  return (bot as Bot & { collectBlock?: { collect: (target: Block, options?: object) => Promise<void> } })
    .collectBlock;
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
  if (bot.entity.position.distanceTo(pos.offset(0.5, 0.5, 0.5)) <= MAX_HARVEST_REACH) {
    return true;
  }
  configureFarmMovements(bot);
  bot.pathfinder.setGoal(new goals.GoalNear(pos.x, pos.y, pos.z, 1.2));
  try {
    await waitForGoal(bot, timeoutMs);
    bot.pathfinder.setGoal(null);
    return true;
  } catch {
    bot.pathfinder.setGoal(null);
    return false;
  }
}

async function pickupDropsNear(bot: Bot, near: Vec3): Promise<void> {
  const item = bot.nearestEntity((entity) => {
    if (!entity.position || entity === bot.entity || entity.name !== "item") {
      return false;
    }
    return entity.position.distanceTo(near.offset(0.5, 0.5, 0.5)) <= 4;
  });
  if (!item?.position) {
    return;
  }
  const t = item.position;
  if (bot.entity.position.distanceTo(t) <= 2) {
    return;
  }
  configureFarmMovements(bot);
  bot.pathfinder.setGoal(new goals.GoalNear(t.x, t.y, t.z, 0.8));
  try {
    await waitForGoal(bot, 5000);
  } catch {
    // pickup may still happen while walking
  }
  bot.pathfinder.setGoal(null);
}

async function harvestWheatBlock(bot: Bot, block: Block): Promise<boolean> {
  const collector = collectBlockPlugin(bot);
  if (collector) {
    try {
      abortActiveMining(bot);
      await collector.collect(block, { ignoreNoPath: false, count: 1 });
      return true;
    } catch {
      // fall through to manual dig
    }
  }

  abortActiveMining(bot);
  if (!(await pathNearBlock(bot, block.position, 15_000))) {
    return false;
  }

  const current = bot.blockAt(block.position);
  if (!isMatureWheat(current)) {
    return false;
  }

  try {
    await bot.unequip("hand");
  } catch {
    // non-fatal
  }

  await bot.lookAt(current.position.offset(0.5, 0.5, 0.5), true);
  try {
    await bot.dig(current);
    await delay(200);
    await pickupDropsNear(bot, current.position);
    return true;
  } catch {
    return false;
  }
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
    count: 128
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
  const stack = bot.inventory.items().find((i) => i.name === "wheat_seeds");
  if (!stack) {
    return false;
  }
  await bot.equip(stack, "hand");
  await delay(120);
  return bot.heldItem?.name === "wheat_seeds";
}

async function plantSeedAtPlot(bot: Bot, plotPos: Vec3): Promise<boolean> {
  if (!isPlantablePlot(bot, plotPos)) {
    return false;
  }
  if (countSeedsInInventory(bot) === 0) {
    return false;
  }
  if (!(await equipWheatSeeds(bot))) {
    return false;
  }

  const farmland = bot.blockAt(plotPos.offset(0, -1, 0));
  if (!farmland) {
    return false;
  }

  if (!(await pathNearBlock(bot, farmland.position, 12_000))) {
    return false;
  }

  const ground = bot.blockAt(farmland.position);
  const air = bot.blockAt(plotPos);
  if (!ground || ground.name !== "farmland" || !air || air.name !== "air") {
    return false;
  }

  await bot.lookAt(ground.position.offset(0.5, 1, 0.5), true);
  try {
    await bot.placeBlock(ground, new Vec3(0, 1, 0));
    await delay(100);
    const planted = bot.blockAt(plotPos);
    if (planted?.name === "wheat") {
      console.log(`[farm] planted wheat seeds at (${plotPos.x},${plotPos.y},${plotPos.z})`);
      return true;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[farm] plant failed at (${plotPos.x},${plotPos.y},${plotPos.z}): ${msg}`);
  }
  return false;
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

  let planted = 0;
  for (const plot of plots) {
    if (Date.now() >= deadline || isSleepRoutineActive()) {
      break;
    }
    if (countSeedsInInventory(bot) === 0) {
      break;
    }
    if (await plantSeedAtPlot(bot, plot)) {
      planted += 1;
    }
  }

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
  maxDistance = 48,
  deadline = Date.now() + 120_000
): Promise<CollectWheatResult> {
  if (isSleepRoutineActive()) {
    return { ok: false, reason: "paused — owner is sleeping" };
  }

  abortActiveMining(bot);
  bot.pathfinder.setGoal(null);

  const origin = wheatSearchOrigin(bot);
  const harvestedPlots: Vec3[] = [];
  let blocksBroken = 0;
  let lastError = "";

  console.log(`[farm] collecting mature wheat within ${maxDistance}m`);

  const harvestDeadline = deadline - 30_000;
  while (Date.now() < harvestDeadline) {
    if (isSleepRoutineActive()) {
      break;
    }

    const positions = findMatureWheatPositions(bot, maxDistance);
    if (positions.length === 0) {
      break;
    }

    positions.sort((a, b) => {
      const da = origin.distanceTo(a.offset(0.5, 0.5, 0.5));
      const db = origin.distanceTo(b.offset(0.5, 0.5, 0.5));
      return da - db;
    });

    const pos = positions[0]!;
    const block = bot.blockAt(pos);
    if (!isMatureWheat(block)) {
      break;
    }

    const wheatBefore = countWheatItems(bot);
    if (await harvestWheatBlock(bot, block)) {
      blocksBroken += 1;
      harvestedPlots.push(pos.clone());
      const gained = countWheatItems(bot) - wheatBefore;
      console.log(
        `[farm] harvested wheat at (${pos.x},${pos.y},${pos.z})` +
          (gained > 0 ? ` (+${gained})` : "")
      );
    } else {
      lastError = `Could not reach wheat at (${pos.x},${pos.y},${pos.z})`;
      console.log(`[farm] ${lastError}`);
      break;
    }
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
