import type { Bot } from "mineflayer";
import type { Block } from "prismarine-block";
import { goals, Movements } from "mineflayer-pathfinder";
import { Vec3 as Vec3Class } from "vec3";
import { abortActiveMining } from "./bot-gather";
import {
  craftSpecificItem,
  placeBlockBesideBot,
  placeBlockNearAnchor
} from "./bot-craft";

type BedBot = Bot & {
  isABed: (block: Block | null) => boolean;
  isSleeping: boolean;
  sleep: (bedBlock: Block) => Promise<void>;
  wake: () => Promise<void>;
  _lunaDefaultMovements?: Movements;
};

export type SleepSyncState = {
  ownerSleeping: boolean;
  lunaSleeping: boolean;
};

let syncState: SleepSyncState = {
  ownerSleeping: false,
  lunaSleeping: false
};

let sleepRoutineActive = false;

export function getSleepSyncState(): SleepSyncState {
  return { ...syncState };
}

/** True while you are in bed or Luna is walking to / using hers. */
export function isSleepRoutineActive(): boolean {
  return sleepRoutineActive || syncState.ownerSleeping;
}

export function isBedBlockName(name: string | undefined): boolean {
  if (!name) {
    return false;
  }
  return name === "bed" || name.endsWith("_bed");
}

export function isBedBlock(block: Block | null): boolean {
  return block != null && isBedBlockName(block.name);
}

export function registerDefaultMovements(bot: Bot, movements: Movements): void {
  (bot as BedBot)._lunaDefaultMovements = movements;
}

function syncEnabled(): boolean {
  return process.env.MC_SYNC_OWNER_SLEEP !== "false";
}

function searchRadius(): number {
  return Number(process.env.MC_SLEEP_SEARCH_RADIUS ?? "48") || 48;
}

function sayGoodnight(bot: Bot): void {
  if (process.env.MC_SLEEP_GOODNIGHT === "false") {
    return;
  }
  bot.chat("Good night!");
}

function addBedsToCantBreak(movements: Movements, bot: Bot): void {
  for (const name of Object.keys(bot.registry.blocksByName)) {
    if (isBedBlockName(name)) {
      movements.blocksCantBreak.add(bot.registry.blocksByName[name].id);
    }
  }
}

function applySleepMovements(bot: BedBot): void {
  const movements = new Movements(bot);
  movements.canDig = false;
  movements.allowSprinting = true;
  addBedsToCantBreak(movements, bot);
  bot.pathfinder.setMovements(movements);
}

function restoreDefaultMovements(bot: BedBot): void {
  if (bot._lunaDefaultMovements) {
    bot.pathfinder.setMovements(bot._lunaDefaultMovements);
  }
}

function scanBeds(bot: BedBot, center: Vec3Class, radius: number): Block[] {
  const beds: Block[] = [];
  const c = center.floored();
  const r = Math.min(Math.max(4, radius), 32);
  const seen = new Set<string>();

  for (let x = -r; x <= r; x++) {
    for (let y = -4; y <= 4; y++) {
      for (let z = -r; z <= r; z++) {
        const block = bot.blockAt(c.offset(x, y, z));
        if (!block || !bot.isABed(block)) {
          continue;
        }
        const key = `${block.position.x},${block.position.y},${block.position.z}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        beds.push(block);
      }
    }
  }
  return beds;
}

function distSq(a: Vec3Class, b: { x: number; y: number; z: number }): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

function pickBedForLuna(
  bot: BedBot,
  beds: Block[],
  ownerBedPos: Vec3Class | null
): Block | null {
  if (!beds.length) {
    return null;
  }
  const botPos = bot.entity.position;
  const separate =
    ownerBedPos != null
      ? beds.filter((b) => distSq(b.position, ownerBedPos) > 4)
      : beds;
  const pool = separate.length > 0 ? separate : beds;
  pool.sort((a, b) => distSq(botPos, a.position) - distSq(botPos, b.position));
  return pool[0] ?? null;
}

/** Stand beside the bed — never on the bed block (pathfinder would dig it). */
function findStandBesideBed(bot: Bot, bed: Block): Vec3Class | null {
  const bedPos = bed.position;
  const offsets = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 0, 1],
    [0, 0, -1],
    [1, 0, 1],
    [1, 0, -1],
    [-1, 0, 1],
    [-1, 0, -1]
  ];
  let best: { pos: Vec3Class; dist: number } | null = null;
  const botPos = bot.entity.position;

  for (const [dx, dy, dz] of offsets) {
    const stand = bedPos.offset(dx, dy, dz);
    const feet = bot.blockAt(stand);
    const ground = bot.blockAt(stand.offset(0, -1, 0));
    if (!feet || feet.name !== "air" || isBedBlock(feet)) {
      continue;
    }
    if (!ground || ground.name === "air" || isBedBlock(ground)) {
      continue;
    }
    const dist = botPos.distanceTo(stand.offset(0.5, 0.5, 0.5));
    if (!best || dist < best.dist) {
      best = { pos: stand, dist };
    }
  }
  return best?.pos ?? null;
}

function bedInInventory(bot: Bot): string | null {
  const stack = bot.inventory.items().find((i) => isBedBlockName(i.name));
  return stack?.name ?? null;
}

async function walkNearOwnerForBed(bot: BedBot, ownerUsername: string): Promise<Vec3Class | null> {
  const owner = bot.players[ownerUsername]?.entity;
  if (!owner) {
    return null;
  }
  const ownerPos = owner.position.floored();
  const GoalNear = goals.GoalNear;
  const stand = ownerPos.offset(3, 0, 2);
  bot.pathfinder.setGoal(new GoalNear(stand.x, stand.y, stand.z, 2));
  try {
    await waitForGoal(bot, 45_000);
  } catch {
    bot.pathfinder.setGoal(null);
  }
  return ownerPos;
}

/** Place a bed from inventory near you / beside Luna, then return that block. */
async function placeBedFromInventory(
  bot: BedBot,
  ownerUsername: string
): Promise<Block | null> {
  const bedName = bedInInventory(bot);
  if (!bedName) {
    return null;
  }

  const ownerPos = await walkNearOwnerForBed(bot, ownerUsername);
  let placed = await placeBlockBesideBot(bot, bedName);
  if (!placed && ownerPos) {
    placed = await placeBlockNearAnchor(bot, bedName, ownerPos);
  }
  if (!placed) {
    console.log("[sleep] carrying a bed but no room to place it.");
    return null;
  }

  console.log(`[sleep] placed ${bedName.replace(/_/g, " ")} from inventory.`);
  await delay(400);
  const beds = scanBeds(bot, bot.entity.position, searchRadius());
  return pickBedForLuna(bot, beds, ownerPos);
}

async function ensureLunaBed(bot: BedBot, ownerUsername: string): Promise<Block | null> {
  if (bedInInventory(bot)) {
    return placeBedFromInventory(bot, ownerUsername);
  }

  const crafted = await craftSpecificItem(bot, "bed");
  if (!crafted.ok) {
    console.log(`[sleep] no bed nearby and craft failed: ${crafted.reason ?? "unknown"}`);
    return null;
  }

  return placeBedFromInventory(bot, ownerUsername);
}

function needsOwnBed(bed: Block | null, ownerBedPos: Vec3Class | null): boolean {
  if (!bed) {
    return true;
  }
  if (!ownerBedPos) {
    return false;
  }
  return distSq(bed.position, ownerBedPos) <= 4;
}

async function pathBesideBed(bot: BedBot, bed: Block): Promise<boolean> {
  const stand = findStandBesideBed(bot, bed);
  if (!stand) {
    console.log("[sleep] no walkable spot beside bed.");
    return false;
  }

  const GoalNear = goals.GoalNear;
  bot.pathfinder.setGoal(new GoalNear(stand.x, stand.y, stand.z, 1));
  try {
    await waitForGoal(bot, 60_000);
    bot.pathfinder.setGoal(null);
    return true;
  } catch {
    bot.pathfinder.setGoal(null);
    return false;
  }
}

async function lunaGoToSleep(bot: BedBot, ownerUsername: string): Promise<void> {
  if (bot.isSleeping) {
    return;
  }

  sleepRoutineActive = true;
  abortActiveMining(bot);
  bot.pathfinder.setGoal(null);
  applySleepMovements(bot);

  try {
    const owner = bot.players[ownerUsername]?.entity;
    const ownerBedPos = owner ? owner.position.floored() : null;
    const beds = scanBeds(bot, bot.entity.position, searchRadius());
    let bed = pickBedForLuna(bot, beds, ownerBedPos);

    if (needsOwnBed(bed, ownerBedPos)) {
      if (bedInInventory(bot)) {
        bed = await placeBedFromInventory(bot, ownerUsername);
      }
      if (needsOwnBed(bed, ownerBedPos)) {
        bed = await ensureLunaBed(bot, ownerUsername);
      }
    }

    if (!bed) {
      console.log("[sleep] no bed for Luna — place one nearby or give me wool + planks.");
      return;
    }

    const reached = await pathBesideBed(bot, bed);
    if (!reached) {
      console.log("[sleep] could not reach bed in time.");
      return;
    }

    const fresh = bot.blockAt(bed.position);
    if (!fresh || !bot.isABed(fresh)) {
      console.log("[sleep] bed block missing — was it broken?");
      return;
    }

    try {
      await bot.sleep(fresh);
      syncState.lunaSleeping = true;
      sayGoodnight(bot);
      console.log("[sleep] Luna is in bed.");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[sleep] could not sleep: ${msg}`);
    }
  } finally {
    sleepRoutineActive = false;
    restoreDefaultMovements(bot);
    bot.pathfinder.setGoal(null);
  }
}

async function wakeLunaIfNeeded(bot: BedBot): Promise<void> {
  if (!bot.isSleeping) {
    syncState.lunaSleeping = false;
    return;
  }
  try {
    await bot.wake();
    syncState.lunaSleeping = false;
    if (process.env.MC_SLEEP_GOODNIGHT !== "false") {
      bot.chat("Morning!");
    }
    console.log("[sleep] Luna woke up with you.");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[sleep] wake failed: ${msg}`);
  }
}

export function setupOwnerBedSync(bot: Bot, ownerUsername: string): void {
  if (!syncEnabled()) {
    return;
  }

  const bedBot = bot as BedBot;
  let goingToBed = false;

  const ownerEntity = () => bot.players[ownerUsername]?.entity;

  bot.on("entitySleep", (entity) => {
    if (entity !== ownerEntity() || goingToBed) {
      return;
    }
    syncState.ownerSleeping = true;
    sleepRoutineActive = true;
    abortActiveMining(bot);
    bot.pathfinder.setGoal(null);
    console.log("[sleep] you went to bed — Luna is heading to hers.");
    goingToBed = true;
    void lunaGoToSleep(bedBot, ownerUsername).finally(() => {
      goingToBed = false;
    });
  });

  bot.on("entityWake", (entity) => {
    if (entity !== ownerEntity()) {
      return;
    }
    syncState.ownerSleeping = false;
    sleepRoutineActive = false;
    void wakeLunaIfNeeded(bedBot);
  });

  bot.on("sleep", () => {
    syncState.lunaSleeping = true;
  });

  bot.on("wake", () => {
    syncState.lunaSleeping = false;
  });

  bot.on("end", () => {
    syncState = { ownerSleeping: false, lunaSleeping: false };
    sleepRoutineActive = false;
  });
}

function waitForGoal(bot: Bot, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
