import { Bot } from "mineflayer";
import { Block } from "prismarine-block";
import { goals } from "mineflayer-pathfinder";
import { Vec3 } from "vec3";
import { takeScaffoldFromNearbyChest, takeToolFromNearbyChest } from "./bot-chest";
import { equipToolCategory, hasToolCategory } from "./bot-inventory";
import { refuseProtectedDig } from "./bot-protect";

const SCAFFOLD_BLOCK_NAMES = [
  "dirt",
  "grass_block",
  "coarse_dirt",
  "rooted_dirt",
  "cobblestone",
  "stone"
];

const DIRT_SOURCE_NAMES = ["dirt", "grass_block", "coarse_dirt", "rooted_dirt"];
const MAX_SOIL_DIG_REACH = 4.5;

export function isScaffoldBlockName(name: string): boolean {
  return SCAFFOLD_BLOCK_NAMES.includes(name);
}

export function countScaffoldBlocks(bot: Bot): number {
  return bot.inventory
    .items()
    .filter((i) => isScaffoldBlockName(i.name))
    .reduce((n, i) => n + i.count, 0);
}

function findScaffoldStack(bot: Bot) {
  for (const name of SCAFFOLD_BLOCK_NAMES) {
    const stack = bot.inventory.items().find((i) => i.name === name && i.count > 0);
    if (stack) {
      return stack;
    }
  }
  return undefined;
}

export function feetBlockY(bot: Bot): number {
  return bot.entity.position.floored().y;
}

export function isStandingOnBlock(bot: Bot, blockPos: Vec3): boolean {
  const feet = bot.entity.position.floored();
  return feet.x === blockPos.x && feet.z === blockPos.z && feetBlockY(bot) === blockPos.y;
}

function isSolidGround(block: Block | null): boolean {
  return !!block && block.name !== "air" && block.boundingBox !== "empty";
}

function isReplaceable(block: Block | null): boolean {
  if (!block || block.name === "air") {
    return true;
  }
  return (
    block.name.endsWith("_leaves") ||
    block.name === "short_grass" ||
    block.name === "tall_grass" ||
    block.name === "fern" ||
    block.name === "large_fern" ||
    block.name === "snow" ||
    block.name === "vine"
  );
}

export function isClimbableSolid(block: Block | null): boolean {
  if (!block || block.name === "air" || block.boundingBox === "empty") {
    return false;
  }
  return !isReplaceable(block);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForJumpApex(bot: Bot, maxMs = 450): Promise<void> {
  const start = Date.now();
  let wasRising = false;
  while (Date.now() - start < maxMs) {
    const vy = bot.entity.velocity.y;
    if (vy > 0.08) {
      wasRising = true;
    }
    if (wasRising && vy <= 0.02) {
      return;
    }
    await delay(25);
  }
}

export async function jumpUpOntoBlock(bot: Bot, stepPos: Vec3): Promise<boolean> {
  if (isStandingOnBlock(bot, stepPos)) {
    return true;
  }

  const feetBefore = feetBlockY(bot);
  const top = stepPos.offset(0.5, 1.02, 0.5);

  try {
    await bot.unequip("hand");
  } catch {
    // non-fatal
  }

  for (let attempt = 0; attempt < 6; attempt++) {
    bot.clearControlStates();
    await bot.lookAt(top, true);
    bot.setControlState("jump", true);
    await delay(120 + attempt * 15);
    await waitForJumpApex(bot, 300);
    await delay(30);
    bot.setControlState("jump", false);
    await delay(140);
    if (isStandingOnBlock(bot, stepPos)) {
      return true;
    }
    bot.setControlState("jump", true);
    await delay(160);
    bot.setControlState("jump", false);
    await delay(120);
    if (isStandingOnBlock(bot, stepPos)) {
      return true;
    }
  }

  bot.clearControlStates();
  return feetBlockY(bot) > feetBefore;
}

export function nextStepCandidates(bot: Bot, columnX: number, columnZ: number): Vec3[] {
  const stepY = feetBlockY(bot) + 1;
  const offsets = [
    [0, 0],
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1]
  ];
  const out: Vec3[] = [];

  for (const [dx, dz] of offsets) {
    const pos = new Vec3(columnX + dx, stepY, columnZ + dz);
    const block = bot.blockAt(pos);
    if (!isClimbableSolid(block) || isStandingOnBlock(bot, pos)) {
      continue;
    }
    out.push(pos);
  }

  out.sort((a, b) => {
    const aCenter = a.x === columnX && a.z === columnZ ? 0 : 1;
    const bCenter = b.x === columnX && b.z === columnZ ? 0 : 1;
    return aCenter - bCenter;
  });
  return out;
}

export async function tryMountNearbyStep(bot: Bot, columnX: number, columnZ: number): Promise<boolean> {
  for (const pos of nextStepCandidates(bot, columnX, columnZ)) {
    const block = bot.blockAt(pos);
    if (!block) {
      continue;
    }
    if (await jumpUpOntoBlock(bot, pos)) {
      console.log(`[scaffold] stepped onto ${block.name} at (${pos.x},${pos.y},${pos.z})`);
      return true;
    }
  }
  return false;
}

function isOurPlacedStep(pos: Vec3, placedSteps: Vec3[]): boolean {
  return placedSteps.some((p) => p.x === pos.x && p.y === pos.y && p.z === pos.z);
}

export type ScaffoldAnchor = { groundPos: Vec3; stepPos: Vec3 };

export function pillarAnchorAtColumn(
  bot: Bot,
  columnX: number,
  columnZ: number,
  placedSteps: Vec3[]
): ScaffoldAnchor | null {
  const feetY = feetBlockY(bot);

  if (isStandingOnBlock(bot, new Vec3(columnX, feetY, columnZ))) {
    const groundPos = new Vec3(columnX, feetY, columnZ);
    const ground = bot.blockAt(groundPos);
    if (ground && isSolidGround(ground)) {
      return { groundPos, stepPos: new Vec3(columnX, feetY + 1, columnZ) };
    }
  }

  const stacked = placedSteps
    .filter((p) => p.x === columnX && p.z === columnZ)
    .sort((a, b) => b.y - a.y);
  for (const top of stacked) {
    if (isStandingOnBlock(bot, top)) {
      return { groundPos: top.clone(), stepPos: new Vec3(columnX, top.y + 1, columnZ) };
    }
  }

  return null;
}

async function equipScaffoldBlock(bot: Bot): Promise<boolean> {
  const stack = findScaffoldStack(bot);
  if (!stack) {
    return false;
  }
  await bot.equip(stack, "hand");
  await delay(80);
  return isScaffoldBlockName(bot.heldItem?.name ?? "");
}

/** Jump and place dirt (or cobble) under feet in a pillar column — same as house building. */
export async function placeScaffoldStep(
  bot: Bot,
  columnX: number,
  columnZ: number,
  placedSteps: Vec3[],
  label = "scaffold"
): Promise<boolean> {
  if (countScaffoldBlocks(bot) === 0) {
    return false;
  }

  const feetBefore = feetBlockY(bot);
  const anchor = pillarAnchorAtColumn(bot, columnX, columnZ, placedSteps);
  if (!anchor) {
    return false;
  }

  const { groundPos, stepPos } = anchor;
  const stepBlock = bot.blockAt(stepPos);

  if (stepBlock && stepBlock.name !== "air") {
    if (isClimbableSolid(stepBlock) && !isStandingOnBlock(bot, stepPos)) {
      return jumpUpOntoBlock(bot, stepPos);
    }
    return false;
  }

  if (!(await equipScaffoldBlock(bot))) {
    return false;
  }

  const ground = bot.blockAt(groundPos);
  if (!ground || !isSolidGround(ground)) {
    return false;
  }

  const held = bot.heldItem?.name ?? "dirt";
  console.log(`[${label}] jump + place ${held} under feet at (${stepPos.x},${stepPos.y},${stepPos.z})`);

  for (let attempt = 0; attempt < 6; attempt++) {
    await bot.lookAt(ground.position.offset(0.5, 1, 0.5), true);
    bot.clearControlStates();
    bot.setControlState("jump", true);
    await delay(80 + attempt * 10);
    await waitForJumpApex(bot, 350);

    const current = bot.blockAt(stepPos);
    if (!current || current.name === "air") {
      try {
        await bot.placeBlock(ground, new Vec3(0, 1, 0));
      } catch {
        // retry jump
      }
    }

    bot.setControlState("jump", false);
    await delay(80);

    if (!isStandingOnBlock(bot, stepPos)) {
      bot.setControlState("jump", true);
      await delay(150);
      bot.setControlState("jump", false);
      await delay(120);
    }

    if (isStandingOnBlock(bot, stepPos)) {
      if (!isOurPlacedStep(stepPos, placedSteps)) {
        placedSteps.push(stepPos.clone());
      }
      return true;
    }

    if (feetBlockY(bot) > feetBefore) {
      return true;
    }
  }

  return feetBlockY(bot) > feetBefore;
}

export function distanceToBlockCenter(bot: Bot, pos: Vec3): number {
  return bot.entity.position.distanceTo(pos.offset(0.5, 0.5, 0.5));
}

/** Stack dirt steps until a target block is within placement/dig reach. */
export async function scaffoldUntilReach(
  bot: Bot,
  targetPos: Vec3,
  columnX: number,
  columnZ: number,
  placedSteps: Vec3[],
  maxReach: number,
  maxSteps = 16,
  label = "scaffold",
  maxDistance = 48
): Promise<boolean> {
  const startFeet = feetBlockY(bot);

  for (let step = 0; step < maxSteps; step++) {
    if (distanceToBlockCenter(bot, targetPos) <= maxReach) {
      return true;
    }

    const feetBefore = feetBlockY(bot);

    if (await tryMountNearbyStep(bot, columnX, columnZ)) {
      continue;
    }

    if (countScaffoldBlocks(bot) < 1) {
      await ensureScaffoldSupplies(bot, 4, maxDistance, { x: columnX, z: columnZ });
    }

    if (await placeScaffoldStep(bot, columnX, columnZ, placedSteps, label)) {
      if (feetBlockY(bot) <= feetBefore) {
        return false;
      }
      continue;
    }

    return feetBlockY(bot) > startFeet;
  }

  return distanceToBlockCenter(bot, targetPos) <= maxReach;
}

function isDirtSourceBlock(block: Block): boolean {
  return block.name !== "air" && DIRT_SOURCE_NAMES.includes(block.name);
}

function tooCloseToColumn(pos: Vec3, columnX: number, columnZ: number, pad = 1): boolean {
  return Math.abs(pos.x - columnX) <= pad && Math.abs(pos.z - columnZ) <= pad;
}

async function pathToSoilBlock(bot: Bot, block: Block, timeoutMs = 12_000): Promise<void> {
  const goal = new goals.GoalGetToBlock(block.position.x, block.position.y, block.position.z);
  bot.pathfinder.setGoal(goal);
  try {
    await Promise.race([
      bot.pathfinder.goto(goal),
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs))
    ]);
  } catch {
    // partial path may still be close enough
  }
  bot.pathfinder.setGoal(null);
}

async function digSoilInReach(bot: Bot, block: Block): Promise<boolean> {
  const current = bot.blockAt(block.position);
  if (!current || !isDirtSourceBlock(current)) {
    return false;
  }
  if (refuseProtectedDig(current, "dirt gather")) {
    return false;
  }
  if (!(await equipToolCategory(bot, "shovel"))) {
    return false;
  }
  if (distanceToBlockCenter(bot, current.position) > MAX_SOIL_DIG_REACH) {
    return false;
  }
  try {
    await bot.lookAt(current.position.offset(0.5, 0.5, 0.5), true);
    await bot.dig(current);
    return true;
  } catch {
    return false;
  }
}

/** Dig nearby dirt/grass with a shovel when inventory and chest have none. */
export async function gatherDirtWithShovel(
  bot: Bot,
  need: number,
  maxDistance: number,
  avoidColumn?: { x: number; z: number }
): Promise<number> {
  if (need <= 0) {
    return 0;
  }

  const before = countScaffoldBlocks(bot);
  const deadline = Date.now() + 60_000;
  let fails = 0;

  while (countScaffoldBlocks(bot) < before + need && Date.now() < deadline && fails < 5) {
    const findBlocks = (bot as Bot & { findBlocks?: (opts: object) => Vec3[] }).findBlocks;
    let positions: Vec3[] = [];
    if (findBlocks) {
      positions = findBlocks.call(bot, {
        matching: (b: Block) => isDirtSourceBlock(b),
        maxDistance,
        count: 24
      });
    } else {
      const one = bot.findBlock({
        matching: (b: Block) => isDirtSourceBlock(b),
        maxDistance,
        count: 1
      });
      if (one) {
        positions = [one.position];
      }
    }

    const feetY = feetBlockY(bot);
    positions = positions.filter((pos) => {
      if (avoidColumn && tooCloseToColumn(pos, avoidColumn.x, avoidColumn.z)) {
        return false;
      }
      return pos.y <= feetY + 1;
    });
    positions.sort((a, b) => distanceToBlockCenter(bot, a) - distanceToBlockCenter(bot, b));

    const target = positions[0];
    if (!target) {
      console.log("[scaffold] no dirt blocks nearby to dig");
      break;
    }

    const block = bot.blockAt(target);
    if (!block) {
      fails += 1;
      continue;
    }

    if (distanceToBlockCenter(bot, target) > MAX_SOIL_DIG_REACH) {
      await pathToSoilBlock(bot, block);
    }

    if (await digSoilInReach(bot, block)) {
      fails = 0;
      console.log(`[scaffold] dug ${block.name} at (${target.x},${target.y},${target.z})`);
      await delay(200);
    } else {
      fails += 1;
    }
  }

  const gained = countScaffoldBlocks(bot) - before;
  if (gained > 0) {
    console.log(`[scaffold] gathered ${gained} dirt block(s) with shovel`);
  }
  return gained;
}

/**
 * Ensure scaffold blocks for climbing: inventory → chest → shovel + dig dirt.
 */
export async function ensureScaffoldSupplies(
  bot: Bot,
  minCount: number,
  maxDistance = 48,
  avoidColumn?: { x: number; z: number }
): Promise<boolean> {
  if (countScaffoldBlocks(bot) >= minCount) {
    return true;
  }

  const stillNeed = minCount - countScaffoldBlocks(bot);
  await takeScaffoldFromNearbyChest(bot, stillNeed, maxDistance);
  if (countScaffoldBlocks(bot) >= minCount) {
    return true;
  }

  if (!hasToolCategory(bot, "shovel")) {
    const shovel = await takeToolFromNearbyChest(bot, "shovel", maxDistance);
    if (!shovel.ok && !hasToolCategory(bot, "shovel")) {
      console.log("[scaffold] no shovel in inventory or chest");
    }
  }

  const digRadius = Math.min(maxDistance, Number(process.env.MC_DIRT_GATHER_RADIUS ?? "14") || 14);
  await gatherDirtWithShovel(
    bot,
    minCount - countScaffoldBlocks(bot),
    digRadius,
    avoidColumn
  );

  return countScaffoldBlocks(bot) > 0;
}
