import { Bot } from "mineflayer";
import { Block } from "prismarine-block";
import { goals, Movements } from "mineflayer-pathfinder";
import { Vec3 } from "vec3";
import { depositLogsToNearestDoubleChest } from "./bot-chest";
import { abortActiveMining, digBlockInReach } from "./bot-gather";
import { equipToolCategory, ToolCategory } from "./bot-inventory";
import { addProtectedBlocksToMovements, blockInFrontOfBot, isProtectedFromBreaking, refuseProtectedDig } from "./bot-protect";
import { replantTreeFromChest } from "./bot-tree-plant";
import { isSleepRoutineActive } from "./bot-sleep";
import {
  AXE_REACH_BLOCKS,
  analyzeTreeCanopy,
  countLeavesNear,
  detectTree,
  DetectedTree,
  effectiveLogScanTopY,
  findLogsViaLeafSupport,
  isLogBlockName,
  preferredStandColumn,
  SCAN_ABOVE_AXE_REACH,
  isTrunkFoliageBlock,
  scanTreeLogs,
  scanTrunkLeaves
} from "./tree-knowledge";
import {
  countScaffoldBlocks,
  ensureScaffoldSupplies,
  isScaffoldBlockName,
  placeScaffoldStep
} from "./bot-scaffold";
import { getTreeChopRL, TreeChopSession } from "./tree-rl";

const MAX_DIG_REACH = 4.5;

export type TreeChopResult = {
  ok: boolean;
  reason?: string;
  logsCut?: number;
  stashed?: number;
  planted?: number;
  treeType?: string;
  treeDescription?: string;
  rlPoints?: number;
};

function isLogBlock(block: Block | null): block is Block {
  return !!block && block.name !== "air" && isLogBlockName(block.name);
}

export function isLogItemName(name: string): boolean {
  return isLogBlockName(name);
}

export type LogInventorySummary = {
  total: number;
  stacks: { name: string; count: number }[];
  canPillar: boolean;
  message: string;
};

export function summarizeLogInventory(
  items: { name: string; count: number }[]
): LogInventorySummary {
  const stacks = items
    .filter((i) => isLogItemName(i.name))
    .sort((a, b) => b.count - a.count);
  const total = stacks.reduce((n, i) => n + i.count, 0);
  const canPillar = total >= 1;

  if (total === 0) {
    return {
      total: 0,
      stacks: [],
      canPillar: false,
      message: "No logs in inventory — pick up drops on the ground or chop a tree first."
    };
  }

  const detail = stacks.map((i) => `${i.count} ${i.name.replace(/_/g, " ")}`).join(", ");
  return {
    total,
    stacks,
    canPillar,
    message: `${total} log(s): ${detail}. ${canPillar ? "Enough to pillar up." : ""}`.trim()
  };
}

export function summarizeBotLogInventory(bot: Bot): LogInventorySummary {
  return summarizeLogInventory(
    bot.inventory.items().map((i) => ({ name: i.name, count: i.count }))
  );
}

function distToBlock(bot: Bot, pos: Vec3): number {
  if (!bot.entity?.position) {
    return Infinity;
  }
  const d = bot.entity.position.distanceTo(pos.offset(0.5, 0.5, 0.5));
  return Number.isFinite(d) ? d : Infinity;
}

/** Y of the solid block the bot is standing on. */
function feetBlockY(bot: Bot): number {
  return Math.floor(bot.entity.position.y - 0.01) - 1;
}

function isOnColumn(bot: Bot, columnX: number, columnZ: number): boolean {
  const pos = bot.entity.position;
  return Math.abs(pos.x - (columnX + 0.5)) <= 0.55 && Math.abs(pos.z - (columnZ + 0.5)) <= 0.55;
}

function horizontalDistToColumn(bot: Bot, columnX: number, columnZ: number): number {
  const pos = bot.entity.position;
  return Math.hypot(pos.x - (columnX + 0.5), pos.z - (columnZ + 0.5));
}

function isStandingOnBlock(bot: Bot, blockPos: Vec3): boolean {
  return (
    isOnColumn(bot, blockPos.x, blockPos.z) &&
    feetBlockY(bot) === blockPos.y
  );
}

function highestSolidInColumn(bot: Bot, columnX: number, columnZ: number, minY: number, maxY: number): number {
  let highest = minY - 1;
  for (let y = minY; y <= maxY; y++) {
    const block = bot.blockAt(new Vec3(columnX, y, columnZ));
    if (block && block.name !== "air" && isSolidGround(block)) {
      highest = y;
    }
  }
  return highest;
}

/** Any trunk log within dig reach — used while standing under the tree. */
function canReachLog(bot: Bot, logPos: Vec3): boolean {
  if (!bot.entity?.position) {
    return false;
  }
  return bot.entity.position.distanceTo(logPos.offset(0.5, 0.5, 0.5)) <= MAX_DIG_REACH;
}

function canReachTrunkLog(bot: Bot, logPos: Vec3, columnX: number, columnZ: number): boolean {
  if (!bot.entity?.position) {
    return false;
  }
  const eye = bot.entity.position;
  if (Math.abs(eye.x - (columnX + 0.5)) > 1.1 || Math.abs(eye.z - (columnZ + 0.5)) > 1.1) {
    return false;
  }
  return canReachLog(bot, logPos);
}

function feetStandColumn(bot: Bot): { x: number; z: number } {
  const pos = bot.entity.position;
  return { x: Math.floor(pos.x), z: Math.floor(pos.z) };
}

function isElevatedOnTree(bot: Bot, anchorY: number): boolean {
  return bot.entity.position.y > anchorY + 1.5;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stopPathfinding(bot: Bot): void {
  try {
    bot.pathfinder.setGoal(null);
    bot.pathfinder.stop();
  } catch {
    // ignore
  }
  bot.clearControlStates();
}

function configureTreeMovements(bot: Bot): void {
  const movements = new Movements(bot);
  movements.canDig = false;
  movements.allow1by1towers = false;
  movements.allowSprinting = true;
  movements.scafoldingBlocks = [];
  addProtectedBlocksToMovements(bot, movements);
  bot.pathfinder.setMovements(movements);
}

/** Walk straight to trunk column — face target first, then forward (not world-axis strafe). */
async function centerOnColumn(
  bot: Bot,
  columnX: number,
  columnZ: number,
  session?: TreeChopSession
): Promise<void> {
  if (isOnColumn(bot, columnX, columnZ)) {
    return;
  }
  stopPathfinding(bot);

  const front = blockInFrontOfBot(bot);
  if (front && isProtectedFromBreaking(front)) {
    console.log(
      `[protect] ${front.name.replace(/_/g, " ")} in front at (${front.position.x},${front.position.y},${front.position.z}) — pathing around`
    );
    configureTreeMovements(bot);
    bot.pathfinder.setGoal(
      new goals.GoalNear(columnX, bot.entity.position.y, columnZ, 0.9)
    );
    try {
      await waitForGoal(bot, 10_000);
    } catch {
      // partial path still helps
    }
    stopPathfinding(bot);
    if (isOnColumn(bot, columnX, columnZ)) {
      return;
    }
  }

  const targetX = columnX + 0.5;
  const targetZ = columnZ + 0.5;

  for (let step = 0; step < 40; step++) {
    const pos = bot.entity.position;
    const dx = targetX - pos.x;
    const dz = targetZ - pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist <= 0.4) {
      break;
    }

    await bot.lookAt(new Vec3(targetX, pos.y + 0.5, targetZ), true);
    bot.setControlState("forward", dist > 0.45);
    bot.setControlState("sprint", dist > 2.5);
    await delay(100);
    bot.clearControlStates();
  }
  bot.clearControlStates();
  session?.noteWalkNear(bot, new Vec3(columnX, bot.entity.position.floored().y, columnZ));
}

/** Wait until upward velocity peaks (best moment to place under feet). */
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

/** Jump onto an existing pillar block (empty hand). */
async function jumpUpOntoBlock(
  bot: Bot,
  stepPos: Vec3,
  session?: TreeChopSession
): Promise<boolean> {
  if (isStandingOnBlock(bot, stepPos)) {
    return true;
  }

  const feetBefore = feetBlockY(bot);
  const rl = getTreeChopRL();
  const top = stepPos.offset(0.5, 1.02, 0.5);

  stopPathfinding(bot);
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
      session?.notePillarMount(stepPos);
      rl.adaptTiming("mount", true, rl.getTimings());
      return true;
    }
    bot.setControlState("jump", true);
    await delay(160);
    bot.setControlState("jump", false);
    await delay(120);
    if (isStandingOnBlock(bot, stepPos)) {
      session?.notePillarMount(stepPos);
      rl.adaptTiming("mount", true, rl.getTimings());
      return true;
    }
  }

  bot.clearControlStates();
  if (feetBlockY(bot) <= feetBefore) {
    session?.noteEmptyJumps(3, stepPos);
  }
  return false;
}

/**
 * Jump, place a log in the trunk column at jump height (on ground under feet), land on it.
 */
async function jumpPlaceLogStep(
  bot: Bot,
  columnX: number,
  columnZ: number,
  groundPos: Vec3,
  stepPos: Vec3,
  logType: string,
  placedSteps: Vec3[],
  session?: TreeChopSession
): Promise<boolean> {
  const feetBefore = feetBlockY(bot);
  const rl = getTreeChopRL();

  if (isStandingOnBlock(bot, stepPos)) {
    return true;
  }

  const existing = bot.blockAt(stepPos);
  if (existing && existing.name !== "air" && isOurPlacedStep(stepPos, placedSteps)) {
    console.log(`[tree] jump up onto placed log at (${stepPos.x},${stepPos.y},${stepPos.z})`);
    if (await jumpUpOntoBlock(bot, stepPos, session)) {
      return true;
    }
  }

  if (!(await equipLogInHand(bot, logType))) {
    return false;
  }

  const ground = bot.blockAt(groundPos);
  if (!ground || !isSolidGround(ground)) {
    return false;
  }

  console.log(
    `[tree] jump + place log under feet at (${stepPos.x},${stepPos.y},${stepPos.z})`
  );

  for (let attempt = 0; attempt < 6; attempt++) {
    await centerOnColumn(bot, columnX, columnZ, session);
    await bot.lookAt(ground.position.offset(0.5, 1, 0.5), true);
    bot.clearControlStates();
    bot.setControlState("jump", true);
    await delay(80 + attempt * 10);
    await waitForJumpApex(bot, 350);

    const stepBlock = bot.blockAt(stepPos);
    if (!stepBlock || stepBlock.name === "air") {
      try {
        await bot.placeBlock(ground, new Vec3(0, 1, 0));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`[tree] jump-place failed: ${msg}`);
      }
    }

    await delay(40);
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
        session?.notePillarPlace(stepPos);
        rl.adaptTiming("place", true, rl.getTimings());
      }
      session?.notePillarMount(stepPos);
      rl.adaptTiming("mount", true, rl.getTimings());
      return true;
    }

    if (feetBlockY(bot) > feetBefore) {
      return true;
    }
  }

  session?.noteJumpNoPlace(stepPos, "jump-place failed");
  return feetBlockY(bot) > feetBefore;
}

/** Jump up one block — must gain height standing ON the block. */
async function mountPillarBlock(
  bot: Bot,
  pillarPos: Vec3,
  session?: TreeChopSession,
  requireGain = true
): Promise<boolean> {
  const feetBefore = feetBlockY(bot);
  if (isStandingOnBlock(bot, pillarPos)) {
    return !requireGain;
  }
  await jumpUpOntoBlock(bot, pillarPos, session);
  await delay(80);
  const gained = feetBlockY(bot) > feetBefore;
  return requireGain ? gained : gained || isStandingOnBlock(bot, pillarPos);
}

const SURFACE_SCAN_RADIUS = 4;
const SURFACE_MAX_HOPS = 12;

/** Scan ground around Luna for dirt/cobble/logs one block above her feet. */
function scanSurfaceStepBlocks(
  bot: Bot,
  columnX: number,
  columnZ: number,
  _targetLogY?: number
): Vec3[] {
  const feetY = feetBlockY(bot);
  const stepY = feetY + 1;
  const botX = Math.floor(bot.entity.position.x);
  const botZ = Math.floor(bot.entity.position.z);
  const seen = new Set<string>();
  const ranked: { pos: Vec3; score: number }[] = [];

  const consider = (x: number, z: number) => {
    const key = `${x},${stepY},${z}`;
    if (seen.has(key) || isStandingOnBlock(bot, new Vec3(x, stepY, z))) {
      return;
    }
    const block = bot.blockAt(new Vec3(x, stepY, z));
    if (!isClimbStepBlock(block)) {
      return;
    }
    const below = bot.blockAt(new Vec3(x, stepY - 1, z));
    if (!below || below.name === "air" || below.boundingBox === "empty") {
      return;
    }
    seen.add(key);
    const distTrunk = Math.hypot(x - columnX, z - columnZ);
    if (distTrunk > SURFACE_SCAN_RADIUS + 1) {
      return;
    }
    const distBot = Math.hypot(bot.entity.position.x - (x + 0.5), bot.entity.position.z - (z + 0.5));
    const preferScaffold = block && isScaffoldBlockName(block.name) ? -4 : 0;
    const onColumn = x === columnX && z === columnZ ? -3 : 0;
    ranked.push({
      pos: new Vec3(x, stepY, z),
      score: distTrunk * 8 + distBot + preferScaffold + onColumn
    });
  };

  for (let dx = -SURFACE_SCAN_RADIUS; dx <= SURFACE_SCAN_RADIUS; dx++) {
    for (let dz = -SURFACE_SCAN_RADIUS; dz <= SURFACE_SCAN_RADIUS; dz++) {
      consider(columnX + dx, columnZ + dz);
      consider(botX + dx, botZ + dz);
    }
  }

  ranked.sort((a, b) => a.score - b.score);
  return ranked.map((r) => r.pos);
}

/** Walk up existing dirt/cobble/logs around the trunk (multi-hop). */
async function tryClimbSurfaceNearTrunk(
  bot: Bot,
  columnX: number,
  columnZ: number,
  session?: TreeChopSession,
  targetLogY?: number
): Promise<boolean> {
  const startFeet = feetBlockY(bot);
  let hops = 0;

  while (hops < SURFACE_MAX_HOPS) {
    const feetBefore = feetBlockY(bot);
    const steps = scanSurfaceStepBlocks(bot, columnX, columnZ, targetLogY);
    if (steps.length === 0) {
      break;
    }

    let gained = false;
    for (const pos of steps) {
      const block = bot.blockAt(pos);
      if (!block || block.name === "air") {
        continue;
      }
      if (await mountPillarBlock(bot, pos, session, true)) {
        console.log(`[tree] stepped onto ${block.name} at (${pos.x},${pos.y},${pos.z})`);
        gained = true;
        hops += 1;
        break;
      }
    }

    if (!gained) {
      break;
    }
    if (targetLogY !== undefined && feetBlockY(bot) + MAX_DIG_REACH >= targetLogY + 0.5) {
      break;
    }
    if (feetBlockY(bot) <= feetBefore) {
      break;
    }
  }

  if (feetBlockY(bot) > startFeet) {
    console.log(`[tree] surface climb — feet y=${startFeet} → ${feetBlockY(bot)}`);
  }
  return feetBlockY(bot) > startFeet;
}

function nextStepCandidates(bot: Bot, columnX: number, columnZ: number): Vec3[] {
  return scanSurfaceStepBlocks(bot, columnX, columnZ);
}

/** Jump onto dirt/logs/stone beside the trunk to get higher. */
async function tryStepUpNearTrunk(
  bot: Bot,
  columnX: number,
  columnZ: number,
  session?: TreeChopSession,
  targetLogY?: number
): Promise<boolean> {
  return tryClimbSurfaceNearTrunk(bot, columnX, columnZ, session, targetLogY);
}

/** Walk up leftover steps in the trunk column or beside it (dirt, logs, etc.). */
async function climbExistingColumn(
  bot: Bot,
  columnX: number,
  columnZ: number,
  targetLogY: number,
  _anchorY: number,
  session?: TreeChopSession
): Promise<boolean> {
  let progressed = false;
  const maxY = targetLogY + 1;

  for (let guard = 0; guard < 12; guard++) {
    if (canReachTrunkLog(bot, new Vec3(columnX, targetLogY, columnZ), columnX, columnZ)) {
      return true;
    }
    if (feetBlockY(bot) + 1 > maxY) {
      break;
    }

    const feetY = feetBlockY(bot);
    const highest = highestSolidInColumn(bot, columnX, columnZ, feetY, maxY);
    for (let y = feetY + 1; y <= highest; y++) {
      const pos = new Vec3(columnX, y, columnZ);
      const block = bot.blockAt(pos);
      if (!isClimbStepBlock(block) || isStandingOnBlock(bot, pos)) {
        continue;
      }
      if (await mountPillarBlock(bot, pos, session)) {
        progressed = true;
      }
    }

    if (canReachTrunkLog(bot, new Vec3(columnX, targetLogY, columnZ), columnX, columnZ)) {
      return true;
    }

    if (logCount(bot) === 0 && (await tryStepUpNearTrunk(bot, columnX, columnZ, session))) {
      progressed = true;
      continue;
    }
    break;
  }

  return progressed;
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
    };

    bot.on("goal_reached", onGoal);
  });
}

const TRUNK_APPROACH_HORIZ_M = 2.5;

const GROUND_COVER_NAMES = [
  "short_grass",
  "tall_grass",
  "fern",
  "large_fern",
  "dead_bush",
  "vine",
  "snow"
];

type ApproachObstacleKind = "foliage" | "snow" | "side_log" | "pile";

function isTrunkColumnAt(tree: DetectedTree, x: number, z: number): boolean {
  return tree.trunkColumns.some((c) => c.x === x && c.z === z);
}

function isTrunkColumnLogBlock(block: Block, tree: DetectedTree): boolean {
  if (!tree.profile.logNames.includes(block.name)) {
    return false;
  }
  return isTrunkColumnAt(tree, block.position.x, block.position.z);
}

function classifyApproachObstacle(block: Block | null, tree: DetectedTree): ApproachObstacleKind | null {
  if (!block || block.name === "air") {
    return null;
  }
  if (isProtectedFromBreaking(block)) {
    return null;
  }
  if (isTrunkColumnLogBlock(block, tree)) {
    return null;
  }
  if (isSnowFoliageBlock(block) || block.name === "snow") {
    return "snow";
  }
  if (isTrunkFoliageBlock(block, tree)) {
    return "foliage";
  }
  if (tree.profile.logNames.includes(block.name)) {
    return "side_log";
  }
  if (GROUND_COVER_NAMES.includes(block.name) || block.name.endsWith("_leaves")) {
    return "foliage";
  }
  if (block.boundingBox !== "empty") {
    return "pile";
  }
  return null;
}

function obstacleDigTool(block: Block, kind: ApproachObstacleKind): ToolCategory {
  if (kind === "snow") {
    return "shovel";
  }
  if (kind === "foliage" || kind === "side_log") {
    return "axe";
  }
  if (
    ["dirt", "grass_block", "gravel", "sand", "coarse_dirt", "rooted_dirt", "podzol"].includes(
      block.name
    )
  ) {
    return "shovel";
  }
  if (
    ["cobblestone", "stone", "andesite", "diorite", "granite", "deepslate", "tuff"].includes(
      block.name
    )
  ) {
    return "pickaxe";
  }
  return "axe";
}

/** Workstations/storage beside the trunk — never break these when approaching. */
function scanProtectedBesideTrunk(
  bot: Bot,
  tree: DetectedTree,
  columnX: number,
  columnZ: number
): Block[] {
  const minY = tree.trunk.y - 1;
  const maxY = tree.trunk.y + 2;
  const found: Block[] = [];
  const seen = new Set<string>();

  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      for (let y = minY; y <= maxY; y++) {
        const block = bot.blockAt(new Vec3(columnX + dx, y, columnZ + dz));
        if (!block || !isProtectedFromBreaking(block)) {
          continue;
        }
        const key = posKeyVec(block.position);
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        found.push(block);
      }
    }
  }
  return found;
}

/** Tiles within trunk approach range, closest to the column first. */
function approachStandCandidates(columnX: number, columnZ: number): Vec3[] {
  const out: Vec3[] = [];
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      if (Math.hypot(dx, dz) > 2.5) {
        continue;
      }
      out.push(new Vec3(columnX + dx, 0, columnZ + dz));
    }
  }
  out.sort((a, b) => {
    const da = Math.hypot(a.x - columnX, a.z - columnZ);
    const db = Math.hypot(b.x - columnX, b.z - columnZ);
    return da - db;
  });
  return out;
}

/** Floor, body-height foliage, snow, and side logs around the trunk and on the walk-in path. */
function scanApproachObstacles(
  bot: Bot,
  tree: DetectedTree,
  columnX: number,
  columnZ: number
): Vec3[] {
  const anchorY = tree.trunk.y;
  const minY = anchorY;
  const maxY = anchorY + 3;
  const radius = Math.max(3, tree.scanRadius + 1);
  const seen = new Set<string>();
  const ranked: { pos: Vec3; priority: number }[] = [];

  const consider = (pos: Vec3, priority: number) => {
    const key = posKeyVec(pos);
    if (seen.has(key)) {
      return;
    }
    const block = bot.blockAt(pos);
    if (!classifyApproachObstacle(block, tree)) {
      return;
    }
    seen.add(key);
    ranked.push({ pos: pos.clone(), priority });
  };

  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      if (Math.hypot(dx, dz) > radius + 0.5) {
        continue;
      }
      for (let y = minY; y <= maxY; y++) {
        consider(new Vec3(columnX + dx, y, columnZ + dz), 20 + y);
      }
    }
  }

  const botFeet = bot.entity.position.floored();
  const steps = Math.max(Math.abs(columnX - botFeet.x), Math.abs(columnZ - botFeet.z), 1);
  for (let i = 0; i <= steps; i++) {
    const t = steps === 0 ? 0 : i / steps;
    const x = Math.round(botFeet.x + t * (columnX - botFeet.x));
    const z = Math.round(botFeet.z + t * (columnZ - botFeet.z));
    for (let y = minY; y <= maxY; y++) {
      consider(new Vec3(x, y, z), 5 + y);
    }
  }

  ranked.sort(
    (a, b) =>
      a.priority - b.priority || distToBlock(bot, a.pos) - distToBlock(bot, b.pos)
  );
  return ranked.map((entry) => entry.pos);
}

async function digApproachObstacle(bot: Bot, block: Block, tree: DetectedTree): Promise<boolean> {
  if (refuseProtectedDig(block, "approach obstacle")) {
    return false;
  }
  const kind = classifyApproachObstacle(block, tree);
  if (!kind) {
    return false;
  }
  if (kind === "foliage" || kind === "snow") {
    return digBlockingFoliage(bot, block);
  }
  if (distToBlock(bot, block.position) > MAX_DIG_REACH) {
    return false;
  }
  const tool = obstacleDigTool(block, kind);
  if (!(await equipToolCategory(bot, tool))) {
    return false;
  }
  try {
    await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true);
    await bot.dig(block);
    return foliageCleared(bot, block.position);
  } catch {
    return false;
  }
}

async function pathNearStandTile(
  bot: Bot,
  tileX: number,
  tileZ: number,
  groundY: number
): Promise<void> {
  configureTreeMovements(bot);
  bot.pathfinder.setGoal(new goals.GoalNear(tileX, groundY + 0.5, tileZ, 0.7));
  try {
    await waitForGoal(bot, 15_000);
  } catch {
    // partial path still helps
  }
  stopPathfinding(bot);
}

async function clearApproachObstacles(
  bot: Bot,
  tree: DetectedTree,
  columnX: number,
  columnZ: number,
  maxBreaks = 16
): Promise<number> {
  let targets = scanApproachObstacles(bot, tree, columnX, columnZ);
  if (targets.length === 0) {
    return 0;
  }

  const sample = targets
    .slice(0, 4)
    .map((pos) => {
      const block = bot.blockAt(pos);
      return block ? `${block.name}@(${pos.x},${pos.y},${pos.z})` : `?@(${pos.x},${pos.y},${pos.z})`;
    })
    .join(", ");
  console.log(
    `[tree] approach scan: ${targets.length} blocker(s) on floor/tree near trunk — ${sample}${
      targets.length > 4 ? "…" : ""
    }`
  );

  const inReach = targets.filter((pos) => distToBlock(bot, pos) <= MAX_DIG_REACH);
  if (inReach.length === 0) {
    await pathNearStandTile(bot, columnX, columnZ, tree.trunk.y);
    targets = scanApproachObstacles(bot, tree, columnX, columnZ);
  }

  let cleared = 0;
  for (const pos of targets) {
    if (cleared >= maxBreaks) {
      break;
    }
    const block = bot.blockAt(pos);
    if (!block || !classifyApproachObstacle(block, tree)) {
      continue;
    }
    if (distToBlock(bot, pos) > MAX_DIG_REACH) {
      continue;
    }
    if (await digApproachObstacle(bot, block, tree)) {
      console.log(`[tree] cleared approach blocker ${block.name} at (${pos.x},${pos.y},${pos.z})`);
      cleared += 1;
      await delay(50);
    }
  }
  return cleared;
}

/** Prefer trees near the owner when they are in-world (e.g. after tp to me). */
function treeSearchOrigin(bot: Bot): Vec3 {
  const ownerName = (process.env.MC_OWNER ?? "").trim();
  const owner = ownerName ? bot.players[ownerName]?.entity : undefined;
  return owner?.position ?? bot.entity.position;
}

/** Walk to the trunk once, stop pathfinder, then face the tree. */
export async function approachTrunk(
  bot: Bot,
  column: Vec3,
  anchorY: number,
  tree?: DetectedTree
): Promise<boolean> {
  stopPathfinding(bot);
  const columnX = column.x;
  const columnZ = column.z;
  const atTrunk = (): boolean =>
    horizontalDistToColumn(bot, columnX, columnZ) <= TRUNK_APPROACH_HORIZ_M;

  if (atTrunk()) {
    await centerOnColumn(bot, columnX, columnZ);
    await bot.lookAt(column.offset(0.5, anchorY + 0.5, 0.5), true);
    return true;
  }

  if (tree) {
    const workstations = scanProtectedBesideTrunk(bot, tree, columnX, columnZ);
    if (workstations.length > 0) {
      const sample = workstations
        .slice(0, 3)
        .map((b) => `${b.name.replace(/_/g, " ")}@(${b.position.x},${b.position.y},${b.position.z})`)
        .join(", ");
      console.log(
        `[protect] workstation(s) beside trunk — will walk around, not break: ${sample}${
          workstations.length > 3 ? "…" : ""
        }`
      );
    }

    for (let phase = 0; phase < 5 && !atTrunk(); phase++) {
      const cleared = await clearApproachObstacles(bot, tree, columnX, columnZ, 14);
      if (atTrunk()) {
        break;
      }

      await pathNearStandTile(bot, columnX, columnZ, anchorY);
      if (atTrunk()) {
        break;
      }

      await centerOnColumn(bot, columnX, columnZ);
      if (atTrunk()) {
        break;
      }

      for (const tile of approachStandCandidates(columnX, columnZ)) {
        if (atTrunk()) {
          break;
        }
        await pathNearStandTile(bot, tile.x, tile.z, anchorY);
        await clearApproachObstacles(bot, tree, columnX, columnZ, 6);
        await centerOnColumn(bot, columnX, columnZ);
      }

      if (cleared === 0 && phase >= 2) {
        break;
      }
    }
  } else {
    configureTreeMovements(bot);
    for (let attempt = 0; attempt < 2; attempt++) {
      const y = bot.entity.position.y;
      bot.pathfinder.setGoal(new goals.GoalNear(columnX, y, columnZ, 1.2));
      try {
        await waitForGoal(bot, 20_000);
      } catch {
        // partial path still helps
      }
      stopPathfinding(bot);
      if (atTrunk()) {
        break;
      }
    }
    await centerOnColumn(bot, columnX, columnZ);
  }

  await bot.lookAt(column.offset(0.5, anchorY + 0.5, 0.5), true);

  const dist = horizontalDistToColumn(bot, columnX, columnZ);
  if (dist <= TRUNK_APPROACH_HORIZ_M) {
    console.log(`[tree] at trunk (${columnX},${columnZ}) — ${dist.toFixed(1)}m away`);
    return true;
  }

  console.log(
    `[tree] cannot approach trunk at (${columnX},${columnZ}) — ${dist.toFixed(1)}m away (need ≤${TRUNK_APPROACH_HORIZ_M}m)`
  );
  return false;
}

async function lookStraightUp(
  bot: Bot,
  tree: DetectedTree,
  session?: TreeChopSession
): Promise<void> {
  const eye = bot.entity.position;
  const lookY = Math.min(effectiveLogScanTopY(bot, tree), eye.y + 24);
  await bot.lookAt(new Vec3(eye.x, lookY, eye.z), true);
  session?.noteLookUp();
}

function scanLogBlocks(bot: Bot, maxDistance: number): Block[] {
  const center = bot.entity.position.floored();
  const r = Math.min(Math.max(8, maxDistance), 64);
  const maxYAbove = Math.ceil(AXE_REACH_BLOCKS) + SCAN_ABOVE_AXE_REACH + 8;
  const logs: Block[] = [];
  const seen = new Set<string>();

  for (let x = -r; x <= r; x++) {
    for (let y = -2; y <= maxYAbove; y++) {
      for (let z = -r; z <= r; z++) {
        const offset = new Vec3(x, y, z);
        if (offset.distanceTo(new Vec3(0, 0, 0)) > maxDistance) {
          continue;
        }
        const block = bot.blockAt(center.plus(offset));
        if (!isLogBlock(block)) {
          continue;
        }
        const key = `${block.position.x},${block.position.y},${block.position.z}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        logs.push(block);
      }
    }
  }
  return logs;
}

function logsAboveFeet(bot: Bot, tree: DetectedTree): Vec3[] {
  const feetY = feetBlockY(bot);
  return scanTreeLogs(bot, tree).filter((p) => p.y > feetY);
}

export function findNearestTree(bot: Bot, maxDistance: number): DetectedTree | null {
  const candidates = scanLogBlocks(bot, maxDistance);
  if (candidates.length === 0) {
    return null;
  }

  const origin = treeSearchOrigin(bot);
  const tried = new Set<string>();
  const ranked: { tree: DetectedTree; dist: number; logCount: number }[] = [];

  for (const block of candidates) {
    const colKey = `${block.position.x},${block.position.z}`;
    if (tried.has(colKey)) {
      continue;
    }
    tried.add(colKey);

    const tree = detectTree(bot, block);
    if (!tree) {
      continue;
    }

    const logs = scanTreeLogs(bot, tree);
    if (logs.length === 0) {
      continue;
    }

    const base = logs[0]!;
    const dist = origin.distanceTo(base.offset(0.5, 0.5, 0.5));
    ranked.push({ tree, dist, logCount: logs.length });
  }

  if (ranked.length === 0) {
    return null;
  }

  ranked.sort((a, b) => a.dist - b.dist || b.logCount - a.logCount);
  const pick = ranked[0]!;
  console.log(
    `[tree] picked ${pick.tree.profile.label} at (${pick.tree.trunk.x},${pick.tree.trunk.y},${pick.tree.trunk.z}) — ` +
      `${pick.logCount} log(s), ${pick.dist.toFixed(0)}m from ${process.env.MC_OWNER ? "owner" : "Luna"}`
  );
  return pick.tree;
}

function logCount(bot: Bot): number {
  return bot.inventory.items().filter((i) => isLogItemName(i.name)).reduce((n, i) => n + i.count, 0);
}

function findLogStack(bot: Bot, preferredName?: string) {
  return (
    bot.inventory.items().find((i) => i.name === preferredName && isLogItemName(i.name)) ??
    bot.inventory.items().find((i) => isLogItemName(i.name))
  );
}

const LOG_HAND_SETTLE_MS = 120;

/** Switch from axe/tool to a log stack before pillar placement. */
async function equipLogInHand(bot: Bot, logType?: string): Promise<boolean> {
  const stack = findLogStack(bot, logType);
  if (!stack) {
    return false;
  }
  await bot.equip(stack, "hand");
  await delay(LOG_HAND_SETTLE_MS);
  const held = bot.heldItem;
  if (held && isLogItemName(held.name)) {
    return true;
  }
  await bot.equip(stack, "hand");
  await delay(LOG_HAND_SETTLE_MS);
  return !!bot.heldItem && isLogItemName(bot.heldItem.name);
}

/** Step up existing solids in the trunk column and nearby surface stacks. */
async function mountColumnStack(
  bot: Bot,
  columnX: number,
  columnZ: number,
  session?: TreeChopSession,
  maxFeetY?: number
): Promise<boolean> {
  const startFeet = feetBlockY(bot);
  if (await tryClimbSurfaceNearTrunk(bot, columnX, columnZ, session, maxFeetY)) {
    return true;
  }

  const ceiling = maxFeetY ?? startFeet + 14;
  const highest = highestSolidInColumn(bot, columnX, columnZ, startFeet + 1, ceiling + 1);
  if (highest <= startFeet) {
    return false;
  }

  let progressed = false;
  for (let y = startFeet + 1; y <= highest; y++) {
    if (maxFeetY !== undefined && y > maxFeetY) {
      break;
    }
    const pos = new Vec3(columnX, y, columnZ);
    if (isStandingOnBlock(bot, pos)) {
      progressed = true;
      continue;
    }
    const block = bot.blockAt(pos);
    if (!block || block.name === "air" || !isClimbStepBlock(block)) {
      break;
    }
    if (!(await mountPillarBlock(bot, pos, session, true))) {
      break;
    }
    progressed = true;
  }

  return progressed || feetBlockY(bot) > startFeet;
}

/** Walk to dropped log items and pick them up. */
async function pickupLogsNear(
  bot: Bot,
  near: Vec3,
  logType?: string,
  allowShuffle = true,
  session?: TreeChopSession
): Promise<number> {
  const before = logCount(bot);

  const itemEntity = bot.nearestEntity((entity) => {
    if (!entity.position || entity === bot.entity || entity.name !== "item") {
      return false;
    }
    return entity.position.distanceTo(near.offset(0.5, 0.5, 0.5)) <= 4;
  });

  if (allowShuffle && itemEntity?.position) {
    const t = itemEntity.position;
    const dist = bot.entity.position.distanceTo(t);
    if (dist > 1.5) {
      await delay(400);
    } else {
      await bot.lookAt(t, true);
      bot.setControlState("forward", dist > 0.8);
      await delay(250);
      bot.clearControlStates();
    }
    await delay(200);
  } else {
    await delay(350);
  }

  session?.noteWalkNear(bot, near);

  const gained = logCount(bot) - before;
  if (gained > 0) {
    console.log(`[tree] picked up ${gained} log(s)${logType ? ` (${logType})` : ""}`);
  } else if (itemEntity) {
    console.log(`[tree] log item on ground at (${near.x},${near.y},${near.z}) — walk closer to pick up`);
  }
  return gained;
}

function isSolidGround(block: Block | null): boolean {
  return !!block && block.name !== "air" && block.boundingBox !== "empty";
}

function isPillarReplaceable(block: Block | null): boolean {
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

/** Blocks Luna can jump onto to get higher (dirt, logs, stone — not leaves). */
function isClimbStepBlock(block: Block | null): boolean {
  if (!block || block.name === "air" || block.boundingBox === "empty") {
    return false;
  }
  return !isPillarReplaceable(block);
}

/** Only mount existing log steps — not dirt/grass terrain beside the trunk. */
function isPillarLogStep(block: Block | null): boolean {
  return !!block && block.name !== "air" && isLogBlockName(block.name);
}

function posKeyVec(pos: Vec3): string {
  return `${pos.x},${pos.y},${pos.z}`;
}

function isOurPlacedStep(pos: Vec3, placedSteps: Vec3[]): boolean {
  return placedSteps.some((p) => p.x === pos.x && p.y === pos.y && p.z === pos.z);
}

/**
 * Pillar stack goes in the trunk column Luna is climbing — same X/Z as the target log,
 * not an arbitrary corner of a 2×2 giant trunk.
 */
function pickTrunkPillarColumn(
  tree: DetectedTree,
  targetLog?: Vec3,
  bot?: Bot
): { x: number; z: number } {
  if (targetLog) {
    const exact = tree.trunkColumns.find((c) => c.x === targetLog.x && c.z === targetLog.z);
    if (exact) {
      return { x: exact.x, z: exact.z };
    }
    if (tree.trunkColumns.length > 0) {
      const nearest = tree.trunkColumns.reduce((best, col) => {
        const d = Math.hypot(col.x - targetLog.x, col.z - targetLog.z);
        const bd = Math.hypot(best.x - targetLog.x, best.z - targetLog.z);
        return d < bd ? col : best;
      });
      return { x: nearest.x, z: nearest.z };
    }
    return { x: targetLog.x, z: targetLog.z };
  }

  if (bot && tree.trunkColumns.length > 0) {
    const pos = bot.entity.position;
    const nearest = tree.trunkColumns.reduce((best, col) => {
      const d = Math.hypot(pos.x - (col.x + 0.5), pos.z - (col.z + 0.5));
      const bd = Math.hypot(pos.x - (best.x + 0.5), pos.z - (best.z + 0.5));
      return d < bd ? col : best;
    });
    return { x: nearest.x, z: nearest.z };
  }

  const trunk = preferredStandColumn(tree);
  return { x: trunk.x, z: trunk.z };
}

export type TreeClimbGap = {
  feetY: number;
  targetLogY: number;
  topLogY: number;
  /** Raw height from feet to highest trunk log. */
  verticalBlocksToTop: number;
  pillarColumn: { x: number; z: number };
  /** Log blocks to stack in the trunk column before the top log is in axe reach. */
  pillarLogsNeeded: number;
  logsAvailable: number;
  enoughLogs: boolean;
  logsShortBy: number;
};

/** Simulate axe reach from the trunk pillar column at a given feet height. */
function reachFromPillar(feetY: number, columnX: number, columnZ: number, logPos: Vec3): number {
  const eye = new Vec3(columnX + 0.5, feetY + 1.62, columnZ + 0.5);
  return eye.distanceTo(logPos.offset(0.5, 0.5, 0.5));
}

/** How many +1Y pillar steps until `logPos` is within dig reach from the trunk column. */
function pillarLogsToReach(
  feetY: number,
  columnX: number,
  columnZ: number,
  logPos: Vec3,
  maxSteps = 24
): number {
  for (let steps = 0; steps <= maxSteps; steps++) {
    if (reachFromPillar(feetY + steps, columnX, columnZ, logPos) <= MAX_DIG_REACH) {
      return steps;
    }
  }
  return maxSteps + 1;
}

export function measureClimbGap(
  bot: Bot,
  tree: DetectedTree,
  targetLog: Vec3,
  topLog: Vec3,
  placedSteps: Vec3[]
): TreeClimbGap {
  const feetY = feetBlockY(bot);
  const pillar = pickTrunkPillarColumn(tree, targetLog, bot);
  const topLogY = Math.max(targetLog.y, topLog.y);
  const forTarget = pillarLogsToReach(feetY, pillar.x, pillar.z, targetLog);
  const forTop = pillarLogsToReach(feetY, pillar.x, pillar.z, topLog);
  const pillarLogsNeeded = Math.max(forTarget, forTop);
  const logsAvailable = logCount(bot);
  const logsShortBy = Math.max(0, pillarLogsNeeded - logsAvailable);

  return {
    feetY,
    targetLogY: targetLog.y,
    topLogY,
    verticalBlocksToTop: topLogY - feetY,
    pillarColumn: pillar,
    pillarLogsNeeded,
    logsAvailable,
    enoughLogs: logsShortBy === 0,
    logsShortBy
  };
}

function formatClimbGap(plan: TreeClimbGap): string {
  const col = `(${plan.pillarColumn.x}, ${plan.pillarColumn.z})`;
  const logsLine = plan.enoughLogs
    ? `have ${plan.logsAvailable} log(s)`
    : `have ${plan.logsAvailable} log(s), need ${plan.logsShortBy} more for pillar`;
  return (
    `${plan.verticalBlocksToTop} block(s) up to tree top y=${plan.topLogY} ` +
    `(feet y=${plan.feetY}, next log y=${plan.targetLogY}) — ` +
    `stack ${plan.pillarLogsNeeded} log(s) in trunk column ${col}; ${logsLine}`
  );
}

function scanChoppableLogs(bot: Bot, tree: DetectedTree, placedSteps: Vec3[]): Vec3[] {
  const skip = new Set(placedSteps.map(posKeyVec));
  const seen = new Set<string>();
  const logs: Vec3[] = [];

  const add = (p: Vec3) => {
    const key = posKeyVec(p);
    if (skip.has(key) || seen.has(key)) {
      return;
    }
    const block = bot.blockAt(p);
    if (!block || !isLogBlockName(block.name)) {
      return;
    }
    seen.add(key);
    logs.push(p.clone());
  };

  for (const p of scanTreeLogs(bot, tree)) {
    add(p);
  }
  for (const p of findLogsViaLeafSupport(bot, tree)) {
    add(p);
  }

  return logs.sort((a, b) => a.y - b.y || a.x - b.x || a.z - b.z);
}

/** When column scan is empty, use own vs foreign leaves to find remaining wood. */
function resolveLogsFromCanopy(
  bot: Bot,
  tree: DetectedTree,
  placedSteps: Vec3[]
): { logs: Vec3[]; analysis: ReturnType<typeof analyzeTreeCanopy> } {
  const analysis = analyzeTreeCanopy(bot, tree);
  const skip = new Set(placedSteps.map(posKeyVec));
  const logs = scanChoppableLogs(bot, tree, placedSteps);

  if (logs.length > 0) {
    return { logs, analysis };
  }

  const hinted = analysis.hintedLogPositions.filter((p) => !skip.has(posKeyVec(p)));
  if (hinted.length > 0) {
    console.log(
      `[tree] canopy hunt: ${analysis.supportedHints.length} own leaf(s) still supported ` +
        `(${analysis.foreignLeaves.length} foreign ignored) — ${hinted.length} log hint(s)`
    );
  } else if (analysis.supportedHints.length > 0) {
    console.log(
      `[tree] canopy: ${analysis.supportedHints.length} own leaf(s) still supported but no log found yet ` +
        `(${analysis.foreignLeaves.length} foreign leaf blocks ignored)`
    );
  } else if (analysis.foreignLeaves.length > 0) {
    console.log(
      `[tree] canopy unsupported — ${analysis.foreignLeaves.length} leaf block(s) belong to neighboring tree(s)`
    );
  }

  return { logs: hinted, analysis };
}

function isSnowFoliageBlock(block: Block | null): boolean {
  return !!block && (block.name === "snow" || block.name === "snow_block");
}

function foliageDigTool(block: Block): "axe" | "shovel" {
  return isSnowFoliageBlock(block) ? "shovel" : "axe";
}

function foliageCleared(bot: Bot, pos: Vec3): boolean {
  const block = bot.blockAt(pos);
  return !block || block.name === "air";
}

/** Break snow or leaves in reach — direct dig (raycast often fails on snowy canopy). */
async function digBlockingFoliage(bot: Bot, block: Block): Promise<boolean> {
  if (refuseProtectedDig(block, "foliage clear")) {
    return false;
  }
  if (distToBlock(bot, block.position) > MAX_DIG_REACH) {
    return false;
  }
  const tool = foliageDigTool(block);
  if (!(await equipToolCategory(bot, tool))) {
    return false;
  }
  try {
    await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true);
    await bot.dig(block);
    return foliageCleared(bot, block.position);
  } catch {
    return false;
  }
}

/** Break reachable leaves and snow on/beside the trunk so logs are accessible. */
function scanReachableTreeLeaves(
  bot: Bot,
  tree: DetectedTree,
  columnX: number,
  columnZ: number
): Vec3[] {
  const feetY = feetBlockY(bot);
  const minY = Math.max(tree.trunk.y - 1, feetY - 1);
  const maxY = effectiveLogScanTopY(bot, tree);
  const pad = tree.trunkShape === "2x2" ? 2 : 2;
  const seen = new Set<string>();
  const foliage: Vec3[] = [];

  for (let dx = -pad; dx <= pad; dx++) {
    for (let dz = -pad; dz <= pad; dz++) {
      for (let y = minY; y <= maxY; y++) {
        const pos = new Vec3(columnX + dx, y, columnZ + dz);
        const key = posKeyVec(pos);
        if (seen.has(key) || distToBlock(bot, pos) > MAX_DIG_REACH) {
          continue;
        }
        const block = bot.blockAt(pos);
        if (!block || !isTrunkFoliageBlock(block, tree)) {
          continue;
        }
        seen.add(key);
        foliage.push(pos.clone());
      }
    }
  }

  foliage.sort(
    (a, b) => b.y - a.y || distToBlock(bot, a) - distToBlock(bot, b)
  );
  return foliage;
}

async function clearTrunkLeaves(
  bot: Bot,
  tree: DetectedTree,
  maxBreaks = 12,
  column?: { x: number; z: number }
): Promise<number> {
  const targets = column
    ? scanReachableTreeLeaves(bot, tree, column.x, column.z)
    : scanTrunkLeaves(bot, tree).filter((p) => distToBlock(bot, p) <= MAX_DIG_REACH);
  let cleared = 0;

  for (const pos of targets) {
    if (cleared >= maxBreaks) {
      break;
    }
    const block = bot.blockAt(pos);
    if (!block || !isTrunkFoliageBlock(block, tree)) {
      continue;
    }
    if (await digBlockingFoliage(bot, block)) {
      const label = isSnowFoliageBlock(block) ? "snow" : "leaf";
      console.log(`[tree] cut ${label} ${block.name} at (${pos.x},${pos.y},${pos.z})`);
      cleared += 1;
      await delay(50);
    }
  }

  if (cleared > 0) {
    console.log(`[tree] cut ${cleared} block(s) blocking the trunk`);
  }
  return cleared;
}

async function clearPillarObstruction(bot: Bot, pos: Vec3): Promise<void> {
  const block = bot.blockAt(pos);
  if (!block || block.name === "air" || isLogBlockName(block.name) || !isPillarReplaceable(block)) {
    return;
  }
  if (refuseProtectedDig(block, "pillar step")) {
    return;
  }
  if (distToBlock(bot, pos) > MAX_DIG_REACH) {
    return;
  }
  const cleared =
    isSnowFoliageBlock(block) || block.name.endsWith("_leaves")
      ? await digBlockingFoliage(bot, block)
      : await (async () => {
          try {
            await equipToolCategory(bot, "axe");
            await digBlockInReach(bot, block, { tool: "axe" });
            return foliageCleared(bot, pos);
          } catch {
            return false;
          }
        })();
  if (cleared) {
    console.log(`[tree] cleared ${block.name} at (${pos.x},${pos.y},${pos.z}) for pillar`);
    await delay(150);
  }
}

async function ensureClimbLogs(bot: Bot, logType: string, near: Vec3): Promise<LogInventorySummary> {
  let summary = summarizeBotLogInventory(bot);
  if (summary.canPillar) {
    return summary;
  }
  await pickupLogsNear(bot, near, logType);
  summary = summarizeBotLogInventory(bot);
  return summary;
}

/** Stand directly under a trunk log before climbing or chopping it. */
async function standUnderLog(bot: Bot, logPos: Vec3, session?: TreeChopSession): Promise<void> {
  stopPathfinding(bot);
  await centerOnColumn(bot, logPos.x, logPos.z, session);
}

/**
 * Next pillar step in the trunk column: place on the block under Luna's feet,
 * or on top of the highest log she already stacked there.
 */
function trunkPillarAnchor(
  bot: Bot,
  columnX: number,
  columnZ: number,
  placedSteps: Vec3[],
  targetStepY?: number
): { groundPos: Vec3; stepPos: Vec3 } | null {
  if (targetStepY !== undefined) {
    const groundPos = new Vec3(columnX, targetStepY - 1, columnZ);
    const ground = bot.blockAt(groundPos);
    if (!ground || ground.name === "air" || !isSolidGround(ground)) {
      return null;
    }
    return { groundPos, stepPos: new Vec3(columnX, targetStepY, columnZ) };
  }

  const feetY = feetBlockY(bot);

  if (isOnColumn(bot, columnX, columnZ) && isStandingOnBlock(bot, new Vec3(columnX, feetY, columnZ))) {
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

  const solidY = highestSolidInColumn(bot, columnX, columnZ, feetY - 10, feetY + 2);
  if (solidY >= feetY - 10) {
    const groundPos = new Vec3(columnX, solidY, columnZ);
    const ground = bot.blockAt(groundPos);
    if (ground && isSolidGround(ground)) {
      return { groundPos, stepPos: new Vec3(columnX, solidY + 1, columnZ) };
    }
  }

  return null;
}

/** Clear leaves/grass or dig terrain blocking the next pillar step. */
async function clearStepForPlace(bot: Bot, stepPos: Vec3): Promise<void> {
  const block = bot.blockAt(stepPos);
  if (!block || block.name === "air") {
    return;
  }
  if (isPillarReplaceable(block)) {
    await clearPillarObstruction(bot, stepPos);
    return;
  }
  if (isPillarLogStep(block)) {
    return;
  }
  if (distToBlock(bot, stepPos) <= MAX_DIG_REACH) {
    if (block && refuseProtectedDig(block, "pillar step")) {
      return;
    }
    await equipToolCategory(bot, "axe");
    try {
      await digBlockInReach(bot, block, { tool: "axe" });
      console.log(`[tree] cleared ${block.name} at (${stepPos.x},${stepPos.y},${stepPos.z}) for pillar`);
      await delay(120);
    } catch {
      // may be out of reach after moving
    }
  }
}

/**
 * One trunk pillar step: equip log → place in tree column → stand on it.
 */
export async function placeLogPillarStep(
  bot: Bot,
  columnX: number,
  columnZ: number,
  logType: string,
  placedSteps: Vec3[],
  session?: TreeChopSession,
  targetStepY?: number
): Promise<boolean> {
  if (logCount(bot) === 0) {
    return false;
  }

  stopPathfinding(bot);
  await centerOnColumn(bot, columnX, columnZ, session);

  const feetBefore = feetBlockY(bot);
  let anchor = trunkPillarAnchor(bot, columnX, columnZ, placedSteps, targetStepY);
  if (!anchor) {
    console.log(`[tree] no pillar base in trunk column (${columnX},?,${columnZ})`);
    return false;
  }

  let { groundPos, stepPos } = anchor;
  let stepBlock = bot.blockAt(stepPos);

  if (!isStandingOnBlock(bot, groundPos)) {
    if (isOurPlacedStep(groundPos, placedSteps) && (await mountPillarBlock(bot, groundPos, session))) {
      anchor = trunkPillarAnchor(bot, columnX, columnZ, placedSteps, targetStepY);
      if (!anchor) {
        return feetBlockY(bot) > feetBefore;
      }
      groundPos = anchor.groundPos;
      stepPos = anchor.stepPos;
      stepBlock = bot.blockAt(stepPos);
    } else {
      await centerOnColumn(bot, columnX, columnZ, session);
      anchor = trunkPillarAnchor(bot, columnX, columnZ, placedSteps, targetStepY);
      if (!anchor || !isStandingOnBlock(bot, anchor.groundPos)) {
        console.log(
          `[tree] not standing on pillar base at (${columnX},?,${columnZ}) — feet y=${feetBlockY(bot)}`
        );
        return false;
      }
      groundPos = anchor.groundPos;
      stepPos = anchor.stepPos;
      stepBlock = bot.blockAt(stepPos);
    }
  }

  if (stepBlock && stepBlock.name !== "air") {
    if (!isOurPlacedStep(stepPos, placedSteps)) {
      if (isPillarLogStep(stepBlock) && canReachLog(bot, stepPos)) {
        await equipToolCategory(bot, "axe");
        await breakLogInPlace(bot, stepPos, logType, undefined, session);
        stepBlock = bot.blockAt(stepPos);
      }
      if (stepBlock && stepBlock.name !== "air") {
        await clearStepForPlace(bot, stepPos);
        stepBlock = bot.blockAt(stepPos);
        if (stepBlock && stepBlock.name !== "air") {
          return false;
        }
        anchor = trunkPillarAnchor(bot, columnX, columnZ, placedSteps, targetStepY);
        if (!anchor) {
          return false;
        }
        groundPos = anchor.groundPos;
        stepPos = anchor.stepPos;
      }
    }
  }

  return jumpPlaceLogStep(
    bot,
    columnX,
    columnZ,
    groundPos,
    stepPos,
    logType,
    placedSteps,
    session
  );
}

/**
 * One climb action: step on dirt beside trunk, place dirt under feet, then logs if needed.
 */
async function pillarOneStep(
  bot: Bot,
  columnX: number,
  columnZ: number,
  logType: string,
  placedSteps: Vec3[],
  session?: TreeChopSession,
  maxDistance = 48,
  targetLogY?: number
): Promise<boolean> {
  stopPathfinding(bot);
  const feetBefore = feetBlockY(bot);

  if (await tryStepUpNearTrunk(bot, columnX, columnZ, session, targetLogY)) {
    return feetBlockY(bot) > feetBefore;
  }

  if (await mountColumnStack(bot, columnX, columnZ, session, targetLogY)) {
    return feetBlockY(bot) > feetBefore;
  }

  if (countScaffoldBlocks(bot) < 1) {
    await ensureScaffoldSupplies(bot, 4, maxDistance, { x: columnX, z: columnZ });
  }

  if (countScaffoldBlocks(bot) > 0) {
    if (await placeScaffoldStep(bot, columnX, columnZ, placedSteps, "tree")) {
      return feetBlockY(bot) > feetBefore;
    }
  }

  await ensureClimbLogs(bot, logType, new Vec3(columnX, bot.entity.position.y, columnZ));

  if (logCount(bot) > 0) {
    if (await placeLogPillarStep(bot, columnX, columnZ, logType, placedSteps, session)) {
      return feetBlockY(bot) > feetBefore;
    }
  }

  const stepPos = new Vec3(columnX, feetBlockY(bot) + 1, columnZ);
  const stepBlock = bot.blockAt(stepPos);
  if (isClimbStepBlock(stepBlock) && !isStandingOnBlock(bot, stepPos)) {
    if (await mountPillarBlock(bot, stepPos, session)) {
      return feetBlockY(bot) > feetBefore;
    }
  }

  return false;
}

/**
 * Climb the trunk: dirt steps first (like house building), then logs if needed.
 */
async function climbTowardLog(
  bot: Bot,
  target: Vec3,
  topLog: Vec3,
  tree: DetectedTree,
  placedSteps: Vec3[],
  session: TreeChopSession,
  _anchorY: number,
  maxDistance = 48
): Promise<boolean> {
  await standUnderLog(bot, target, session);

  let plan = measureClimbGap(bot, tree, target, topLog, placedSteps);
  const scaffoldHave = countScaffoldBlocks(bot);
  console.log(
    `[tree] climb plan: ${formatClimbGap(plan)}` +
      (scaffoldHave > 0 ? `; ${scaffoldHave} dirt/cobble for steps` : "")
  );

  if (!plan.enoughLogs && scaffoldHave < plan.pillarLogsNeeded) {
    await ensureClimbLogs(bot, tree.logType, target);
    plan = measureClimbGap(bot, tree, target, topLog, placedSteps);
    const scaffoldNow = countScaffoldBlocks(bot);
    if (!plan.enoughLogs && scaffoldNow === 0 && logCount(bot) === 0) {
      console.log(
        `[tree] cannot climb — need ${plan.pillarLogsNeeded} step(s); have dirt/cobble or logs`
      );
      return false;
    }
  }

  const column = plan.pillarColumn;
  const startFeet = feetBlockY(bot);
  const maxSteps = Math.min(
    effectiveLogScanTopY(bot, tree) - feetBlockY(bot) + 2,
    plan.pillarLogsNeeded + 6
  );

  console.log(
    `[tree] climbing trunk column (${column.x},${column.z}) — dirt steps first, then logs`
  );

  await centerOnColumn(bot, column.x, column.z, session);

  for (let step = 0; step < maxSteps; step++) {
    if (canReachLog(bot, target)) {
      await equipToolCategory(bot, "axe");
      return true;
    }

    const feetBefore = feetBlockY(bot);
    const progressed = await pillarOneStep(
      bot,
      column.x,
      column.z,
      tree.logType,
      placedSteps,
      session,
      maxDistance,
      target.y
    );

    if (canReachLog(bot, target)) {
      await equipToolCategory(bot, "axe");
      return true;
    }

    if (!progressed && feetBlockY(bot) <= feetBefore) {
      console.log(`[tree] climb stalled at y=${feetBlockY(bot)}`);
      return false;
    }
  }

  const reached = canReachLog(bot, target);
  if (reached) {
    await equipToolCategory(bot, "axe");
  }
  return reached || feetBlockY(bot) > startFeet;
}

function inventoryTight(bot: Bot): boolean {
  return bot.inventory.emptySlotCount() <= 1 || logCount(bot) >= 28;
}

async function maybeStashLogs(bot: Bot, maxDistance: number, keepForClimb = 6): Promise<number> {
  if (logCount(bot) <= keepForClimb || logCount(bot) === 0) {
    return 0;
  }
  if (!inventoryTight(bot)) {
    return 0;
  }
  const result = await depositLogsToNearestDoubleChest(bot, maxDistance);
  return result.moved ?? 0;
}

async function breakLogInPlace(
  bot: Bot,
  pos: Vec3,
  logType?: string,
  anchorY?: number,
  session?: TreeChopSession
): Promise<boolean> {
  const block = bot.blockAt(pos);
  if (!isLogBlock(block)) {
    return false;
  }
  if (refuseProtectedDig(block, "log chop")) {
    return false;
  }
  try {
    stopPathfinding(bot);
    await equipToolCategory(bot, "axe");
    await digBlockInReach(bot, block, { tool: "axe" });
    console.log(`[tree] broke ${block.name} at (${pos.x},${pos.y},${pos.z})`);
    session?.noteBreak(bot, pos);
    await pickupLogsNear(bot, pos, logType ?? block.name, false, session);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[tree] failed ${block.name}: ${msg}`);
    return false;
  }
}

/**
 * Chop a tree: identify type, break low logs, look up, keep cutting upward
 * until no log blocks remain (leaves decay on their own).
 */
export async function chopTreeAndStash(
  bot: Bot,
  maxDistance = 48,
  deadline = Date.now() + 300_000
): Promise<TreeChopResult> {
  if (isSleepRoutineActive()) {
    return { ok: false, reason: "paused — owner is sleeping" };
  }

  abortActiveMining(bot);
  bot.pathfinder.setGoal(null);
  await equipToolCategory(bot, "axe");

  const tree = findNearestTree(bot, maxDistance);
  if (!tree) {
    return { ok: false, reason: `No tree within ${maxDistance} blocks.` };
  }

  const anchor = tree.trunk;
  const placedSteps: Vec3[] = [];
  let logsCut = 0;
  let stashed = 0;

  console.log(`[tree] ${tree.description}`);
  console.log(
    `[tree] chopping ${tree.profile.label} at (${anchor.x}, ${anchor.y}, ${anchor.z}) — ` +
      `${tree.trunkShape} trunk, ~${tree.estimatedLogs} logs, scan r${tree.scanRadius} h${tree.maxScanHeight}`
  );

  const rl = getTreeChopRL();
  const session = rl.startSession();

  let climbStuckPasses = 0;

  let liveAtStart = scanChoppableLogs(bot, tree, placedSteps);
  if (liveAtStart.length === 0) {
    rl.finishSession(session);
    console.log(`[tree] no trunk logs left at (${anchor.x},${anchor.y},${anchor.z}) — try another tree`);
    return {
      ok: false,
      reason: `That ${tree.profile.label.toLowerCase()} has no trunk logs left — point me at a full tree or say gather wood again.`,
      treeType: tree.profile.label,
      treeDescription: tree.description,
      rlPoints: session.points
    };
  }

  const firstLog = liveAtStart[0]!;
  const startPillar = pickTrunkPillarColumn(tree, firstLog, bot);
  const columnX = startPillar.x;
  const columnZ = startPillar.z;
  const column = new Vec3(columnX, anchor.y, columnZ);
  const columnLock = { x: columnX, z: columnZ };

  if (!(await approachTrunk(bot, column, anchor.y, tree))) {
    rl.finishSession(session);
    return {
      ok: false,
      reason: `Could not reach the ${tree.profile.label.toLowerCase()} tree — tp me next to it or clear blocks around the trunk.`,
      treeType: tree.profile.label,
      treeDescription: tree.description,
      rlPoints: session.points
    };
  }

  await clearTrunkLeaves(bot, tree, 32, columnLock);

  const topY = liveAtStart[liveAtStart.length - 1]!.y;
  const gap = measureClimbGap(bot, tree, firstLog, liveAtStart[liveAtStart.length - 1]!, placedSteps);
  console.log(
    `[tree] locked trunk column (${columnX},${columnZ}) — ${liveAtStart.length} log(s) y=${firstLog.y}–${topY}; ${formatClimbGap(gap)}`
  );

  while (Date.now() < deadline) {
    if (isSleepRoutineActive()) {
      break;
    }

    stopPathfinding(bot);
    await equipToolCategory(bot, "axe");
    await centerOnColumn(bot, columnX, columnZ, session);

    let { logs: liveLogs, analysis: canopy } = resolveLogsFromCanopy(bot, tree, placedSteps);
    if (liveLogs.length === 0) {
      await clearTrunkLeaves(bot, tree, 20, columnLock);
      ({ logs: liveLogs, analysis: canopy } = resolveLogsFromCanopy(bot, tree, placedSteps));
      if (liveLogs.length === 0) {
        if (canopy.canopyUnsupported) {
          console.log("[tree] no own logs left — canopy unsupported (neighbor leaves ignored)");
        } else {
          console.log(
            `[tree] no logs found but ${canopy.supportedHints.length} own leaf(s) still supported — stopping`
          );
        }
        break;
      }
    }

    await clearTrunkLeaves(bot, tree, 16, columnLock);

    const reachable = liveLogs.filter((p) => canReachLog(bot, p)).sort((a, b) => a.y - b.y);
    if (reachable.length > 0) {
      climbStuckPasses = 0;
      for (const pos of reachable) {
        if (await breakLogInPlace(bot, pos, tree.logType, anchor.y, session)) {
          logsCut += 1;
          stashed += await maybeStashLogs(bot, maxDistance);
        }
      }
      continue;
    }

    const huntTarget = liveLogs[0]!;
    if (huntTarget.x !== columnX || huntTarget.z !== columnZ) {
      const huntCol = pickTrunkPillarColumn(tree, huntTarget, bot);
      if (huntCol.x !== columnX || huntCol.z !== columnZ) {
        console.log(
          `[tree] leaf-support hunt → log at (${huntTarget.x},${huntTarget.y},${huntTarget.z})`
        );
        await centerOnColumn(bot, huntTarget.x, huntTarget.z, session);
      }
    }

    const nextLogY = huntTarget.y;
    if (await tryClimbSurfaceNearTrunk(bot, huntTarget.x, huntTarget.z, session, nextLogY)) {
      climbStuckPasses = 0;
      continue;
    }

    const leavesCleared = await clearTrunkLeaves(bot, tree, 24, {
      x: huntTarget.x,
      z: huntTarget.z
    });
    if (leavesCleared > 0) {
      const afterLeaves = liveLogs.filter((p) => canReachLog(bot, p)).sort((a, b) => a.y - b.y);
      if (afterLeaves.length > 0) {
        climbStuckPasses = 0;
        for (const pos of afterLeaves) {
          if (await breakLogInPlace(bot, pos, tree.logType, anchor.y, session)) {
            logsCut += 1;
            stashed += await maybeStashLogs(bot, maxDistance);
          }
        }
        continue;
      }
    }

    await lookStraightUp(bot, tree, session);
    const feetBefore = feetBlockY(bot);
    const climbCol = pickTrunkPillarColumn(tree, huntTarget, bot);
    const stepped = await pillarOneStep(
      bot,
      climbCol.x,
      climbCol.z,
      tree.logType,
      placedSteps,
      session,
      maxDistance,
      nextLogY
    );

    if (stepped && feetBlockY(bot) > feetBefore) {
      climbStuckPasses = 0;
      continue;
    }

    climbStuckPasses += 1;
    console.log(
      `[tree] cannot reach higher logs — feet y=${feetBlockY(bot)} ` +
        `(dirt/cobble=${countScaffoldBlocks(bot)}, logs=${logCount(bot)}, ` +
        `ownLeavesSupported=${canopy.supportedHints.length})`
    );
    if (climbStuckPasses >= 4) {
      break;
    }
    await delay(200);
  }

  placedSteps.sort((a, b) => b.y - a.y);
  for (const pos of placedSteps) {
    const block = bot.blockAt(pos);
    if (!block || block.name === "air") {
      continue;
    }
    const blockName = block.name;
    if (isLogBlock(block) || isScaffoldBlockName(blockName)) {
      await breakLogInPlace(bot, pos, tree.logType, anchor.y, session);
      if (isLogBlockName(blockName)) {
        logsCut += 1;
      }
    }
    stashed += await maybeStashLogs(bot, maxDistance);
  }

  if (logCount(bot) > 0) {
    const final = await depositLogsToNearestDoubleChest(bot, maxDistance);
    stashed += final.moved ?? 0;
  }

  rl.finishSession(session);

  if (logsCut === 0) {
    return {
      ok: false,
      reason: `Could not cut any ${tree.profile.label.toLowerCase()} logs — tp me beside the trunk or clear old pillar blocks.`,
      treeType: tree.profile.label,
      treeDescription: tree.description,
      rlPoints: session.points
    };
  }

  const finalCanopy = analyzeTreeCanopy(bot, tree);
  const left = scanChoppableLogs(bot, tree, placedSteps).length;
  const leavesLeft = countLeavesNear(bot, tree);
  const done = left === 0 && finalCanopy.canopyUnsupported;
  const pts = session.points > 0 ? `; +${session.points} RL pts` : "";

  let planted = 0;
  let plantMsg = "";
  if (done) {
    const plantResult = await replantTreeFromChest(bot, tree, maxDistance, deadline);
    planted = plantResult.planted ?? 0;
    plantMsg = plantResult.ok
      ? ` ${plantResult.reason}`
      : plantResult.reason
        ? ` ${plantResult.reason}`
        : "";
  }

  const foreignNote =
    finalCanopy.foreignLeaves.length > 0
      ? `, ${finalCanopy.foreignLeaves.length} neighbor leaf(s) ignored`
      : "";
  const msg = done
    ? `${tree.profile.label} tree done (${logsCut} logs, own canopy unsupported); stashed ${stashed}${planted > 0 ? `, planted ${planted} sapling(s)` : ""}${foreignNote}${pts}${planted === 0 ? plantMsg : ""}`
    : `${tree.profile.label}: cut ${logsCut} logs (${left} trunk left, ${leavesLeft} own leaf blocks, ${finalCanopy.supportedHints.length} still supported${foreignNote}); stashed ${stashed}${pts}`;

  console.log(`[tree] ${msg}`);
  return {
    ok: done || logsCut > 0,
    logsCut,
    stashed,
    planted,
    reason: msg,
    treeType: tree.profile.label,
    treeDescription: tree.description,
    rlPoints: session.points
  };
}
