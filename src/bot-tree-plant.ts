import { Bot } from "mineflayer";
import { Block } from "prismarine-block";
import { goals, Movements } from "mineflayer-pathfinder";
import { Vec3 } from "vec3";
import { takeSaplingsFromNearbyChest } from "./bot-chest";
import { abortActiveMining } from "./bot-gather";
import { equipToolCategory } from "./bot-inventory";
import { refuseProtectedDig } from "./bot-protect";
import { isSleepRoutineActive } from "./bot-sleep";
import {
  DetectedTree,
  saplingItemForTree,
  saplingsNeededForTree,
  treePlantSites
} from "./tree-knowledge";

const MAX_PLANT_REACH = 4.5;

const SAPLING_GROUND_NAMES = [
  "dirt",
  "grass_block",
  "podzol",
  "moss_block",
  "coarse_dirt",
  "rooted_dirt",
  "mud",
  "mycelium"
];

const CLEAR_BEFORE_PLANT = new Set([
  "snow",
  "short_grass",
  "tall_grass",
  "fern",
  "large_fern",
  "vine",
  "dead_bush"
]);

export type ReplantTreeResult = {
  ok: boolean;
  reason?: string;
  planted?: number;
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function blockCenter(pos: Vec3): Vec3 {
  return pos.offset(0.5, 0.5, 0.5);
}

function isInPlantReach(bot: Bot, pos: Vec3): boolean {
  return bot.entity.position.distanceTo(blockCenter(pos)) <= MAX_PLANT_REACH;
}

function countSaplings(bot: Bot, saplingName: string): number {
  return bot.inventory.items().filter((i) => i.name === saplingName).reduce((n, i) => n + i.count, 0);
}

function isSaplingBlock(name: string, saplingName: string): boolean {
  return name === saplingName || name.endsWith("_sapling") || name === "mangrove_propagule";
}

function isValidSaplingGround(block: Block | null): boolean {
  return !!block && SAPLING_GROUND_NAMES.includes(block.name);
}

function configurePlantMovements(bot: Bot): void {
  const movements = new Movements(bot);
  movements.canDig = true;
  movements.allowSprinting = true;
  bot.pathfinder.setMovements(movements);
}

async function pathNearPlantSite(bot: Bot, pos: Vec3, timeoutMs: number): Promise<boolean> {
  if (isInPlantReach(bot, pos)) {
    return true;
  }
  configurePlantMovements(bot);
  const goal = new goals.GoalGetToBlock(pos.x, pos.y, pos.z);
  bot.pathfinder.setGoal(goal);
  try {
    await Promise.race([
      bot.pathfinder.goto(goal),
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs))
    ]);
    bot.pathfinder.setGoal(null);
    return isInPlantReach(bot, pos);
  } catch {
    bot.pathfinder.setGoal(null);
    return isInPlantReach(bot, pos);
  }
}

async function equipSapling(bot: Bot, saplingName: string): Promise<boolean> {
  if (bot.heldItem?.name === saplingName) {
    return true;
  }
  const stack = bot.inventory.items().find((i) => i.name === saplingName);
  if (!stack) {
    return false;
  }
  await bot.equip(stack, "hand");
  return bot.heldItem?.name === saplingName;
}

async function clearPlantObstruction(bot: Bot, pos: Vec3): Promise<void> {
  const block = bot.blockAt(pos);
  if (!block || block.name === "air") {
    return;
  }
  if (refuseProtectedDig(block, "sapling plant")) {
    return;
  }
  if (!CLEAR_BEFORE_PLANT.has(block.name) && !block.name.endsWith("_leaves")) {
    return;
  }
  if (!isInPlantReach(bot, pos)) {
    return;
  }
  const tool = block.name === "snow" ? "shovel" : "axe";
  if (!(await equipToolCategory(bot, tool))) {
    return;
  }
  try {
    await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true);
    await bot.dig(block);
    await delay(80);
  } catch {
    // non-fatal
  }
}

function isPlantableSite(bot: Bot, sitePos: Vec3, saplingName: string): boolean {
  const ground = bot.blockAt(sitePos.offset(0, -1, 0));
  if (!isValidSaplingGround(ground)) {
    return false;
  }
  const above = bot.blockAt(sitePos);
  if (!above) {
    return false;
  }
  if (above.name === "air" || CLEAR_BEFORE_PLANT.has(above.name) || above.name.endsWith("_leaves")) {
    return true;
  }
  return isSaplingBlock(above.name, saplingName);
}

async function plantSaplingAtSite(bot: Bot, sitePos: Vec3, saplingName: string): Promise<boolean> {
  if (!isPlantableSite(bot, sitePos, saplingName) || countSaplings(bot, saplingName) === 0) {
    return false;
  }
  if (!isInPlantReach(bot, sitePos)) {
    return false;
  }

  await clearPlantObstruction(bot, sitePos);
  if (!isPlantableSite(bot, sitePos, saplingName)) {
    return false;
  }
  if (!(await equipSapling(bot, saplingName))) {
    return false;
  }

  const ground = bot.blockAt(sitePos.offset(0, -1, 0));
  if (!ground || !isValidSaplingGround(ground)) {
    return false;
  }

  await bot.lookAt(ground.position.offset(0.5, 1, 0.5), true);
  try {
    await bot.placeBlock(ground, new Vec3(0, 1, 0));
    const placed = bot.blockAt(sitePos);
    return !!placed && isSaplingBlock(placed.name, saplingName);
  } catch {
    return false;
  }
}

async function plantSaplingsBatch(
  bot: Bot,
  sites: Vec3[],
  saplingName: string,
  deadline: number
): Promise<number> {
  const remaining = [...sites];
  let planted = 0;
  let skipStreak = 0;

  if (!(await equipSapling(bot, saplingName))) {
    return 0;
  }

  while (remaining.length > 0 && Date.now() < deadline && !isSleepRoutineActive()) {
    let plantedThisRound = 0;

    for (let i = remaining.length - 1; i >= 0; i--) {
      const site = remaining[i]!;
      if (countSaplings(bot, saplingName) === 0) {
        return planted;
      }
      if (await plantSaplingAtSite(bot, site, saplingName)) {
        planted += 1;
        plantedThisRound += 1;
        remaining.splice(i, 1);
        console.log(`[tree] planted ${saplingName.replace(/_/g, " ")} at (${site.x},${site.y},${site.z})`);
      }
    }

    if (plantedThisRound > 0) {
      skipStreak = 0;
      continue;
    }

    remaining.sort(
      (a, b) =>
        bot.entity.position.distanceTo(blockCenter(a)) - bot.entity.position.distanceTo(blockCenter(b))
    );
    const next = remaining[0]!;
    if (!isPlantableSite(bot, next, saplingName)) {
      remaining.shift();
      continue;
    }
    if (!(await pathNearPlantSite(bot, next, 8000))) {
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
 * Take saplings from chest and replant at the chopped tree's trunk base (like wheat replanting).
 */
export async function replantTreeFromChest(
  bot: Bot,
  tree: DetectedTree,
  maxDistance = 48,
  deadline = Date.now() + 90_000
): Promise<ReplantTreeResult> {
  if (isSleepRoutineActive()) {
    return { ok: false, reason: "paused — owner is sleeping" };
  }

  const saplingName = saplingItemForTree(tree);
  if (!saplingName) {
    return { ok: false, reason: `No sapling type for ${tree.profile.label} — skipping replant.` };
  }

  abortActiveMining(bot);
  bot.pathfinder.setGoal(null);

  const sites = treePlantSites(tree);
  const needed = Math.min(saplingsNeededForTree(tree), sites.length);
  const saplingResult = await takeSaplingsFromNearbyChest(bot, saplingName, needed, maxDistance);
  const have = countSaplings(bot, saplingName);
  if (have === 0) {
    return { ok: false, reason: saplingResult.reason ?? `No ${saplingName.replace(/_/g, " ")} in chest.` };
  }

  console.log(
    `[tree] replanting ${tree.profile.label} — ${sites.length} site(s), ${have} sapling(s) in inventory`
  );

  const planted = await plantSaplingsBatch(bot, sites, saplingName, deadline);
  if (planted === 0) {
    return { ok: false, reason: "Could not plant saplings — stand closer to the stump or clear snow/leaves." };
  }

  const label = saplingName.replace(/_/g, " ");
  const msg = `Planted ${planted} ${label}${planted > 1 ? "s" : ""} at the ${tree.profile.label.toLowerCase()} stump.`;
  console.log(`[tree] ${msg}`);
  return { ok: true, planted, reason: msg };
}
