import { Bot } from "mineflayer";
import { Block } from "prismarine-block";
import { goals, Movements } from "mineflayer-pathfinder";
import { Vec3 } from "vec3";
import { depositLogsToNearestDoubleChest } from "./bot-chest";
import { abortActiveMining, digBlockInReach } from "./bot-gather";
import { equipToolCategory } from "./bot-inventory";
import { isSleepRoutineActive } from "./bot-sleep";
import {
  countLeavesNear,
  detectTree,
  DetectedTree,
  isLogBlockName,
  preferredStandColumn,
  scanTreeLogs,
  scanTrunkLeaves
} from "./tree-knowledge";
import { getTreeChopRL, TreeChopSession } from "./tree-rl";

const MAX_DIG_REACH = 4.5;

export type TreeChopResult = {
  ok: boolean;
  reason?: string;
  logsCut?: number;
  stashed?: number;
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

/** Jump up one block — must end standing ON the block, not just a tiny hop. */
async function mountPillarBlock(
  bot: Bot,
  pillarPos: Vec3,
  session?: TreeChopSession
): Promise<boolean> {
  if (isStandingOnBlock(bot, pillarPos)) {
    return true;
  }

  const rl = getTreeChopRL();
  const timings = rl.getTimings();
  const feetBefore = feetBlockY(bot);

  stopPathfinding(bot);
  bot.clearControlStates();
  await centerOnColumn(bot, pillarPos.x, pillarPos.z, session);
  const top = pillarPos.offset(0.5, 1.01, 0.5);

  const mountJumpMs = Math.min(timings.mountJumpMs, 280);

  for (let attempt = 0; attempt < 8; attempt++) {
    await bot.lookAt(top, true);
    bot.clearControlStates();
    bot.setControlState("jump", true);
    await delay(mountJumpMs + attempt * 50);
    bot.setControlState("jump", false);
    await delay(timings.mountLandMs + 80);
    if (isStandingOnBlock(bot, pillarPos)) {
      bot.clearControlStates();
      session?.notePillarMount(pillarPos);
      rl.adaptTiming("mount", true, timings);
      return true;
    }
  }
  bot.clearControlStates();

  if (feetBlockY(bot) <= feetBefore) {
    session?.noteEmptyJumps(5, pillarPos);
  }
  return false;
}

function nextStepCandidates(bot: Bot, columnX: number, columnZ: number): Vec3[] {
  const feetY = feetBlockY(bot);
  const stepY = feetY + 1;
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
    if (!isClimbStepBlock(block) || isStandingOnBlock(bot, pos)) {
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

/** Jump onto dirt/logs/stone beside the trunk to get higher. */
async function tryStepUpNearTrunk(
  bot: Bot,
  columnX: number,
  columnZ: number,
  session?: TreeChopSession
): Promise<boolean> {
  for (const pos of nextStepCandidates(bot, columnX, columnZ)) {
    const block = bot.blockAt(pos);
    if (!block) {
      continue;
    }
    console.log(`[tree] stepping onto ${block.name} at (${pos.x},${pos.y},${pos.z})`);
    if (await mountPillarBlock(bot, pos, session)) {
      return true;
    }
  }
  return false;
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

/** Prefer trees near the owner when they are in-world (e.g. after tp to me). */
function treeSearchOrigin(bot: Bot): Vec3 {
  const ownerName = (process.env.MC_OWNER ?? "").trim();
  const owner = ownerName ? bot.players[ownerName]?.entity : undefined;
  return owner?.position ?? bot.entity.position;
}

/** Walk to the trunk once, stop pathfinder, then face the tree. */
export async function approachTrunk(bot: Bot, column: Vec3, anchorY: number): Promise<boolean> {
  stopPathfinding(bot);

  if (horizontalDistToColumn(bot, column.x, column.z) <= TRUNK_APPROACH_HORIZ_M) {
    await centerOnColumn(bot, column.x, column.z);
    await bot.lookAt(column.offset(0.5, anchorY + 0.5, 0.5), true);
    return true;
  }

  configureTreeMovements(bot);
  for (let attempt = 0; attempt < 2; attempt++) {
    const y = bot.entity.position.y;
    bot.pathfinder.setGoal(new goals.GoalNear(column.x, y, column.z, 1.2));
    try {
      await waitForGoal(bot, 20_000);
    } catch {
      // partial path still helps
    }
    stopPathfinding(bot);
    if (horizontalDistToColumn(bot, column.x, column.z) <= TRUNK_APPROACH_HORIZ_M) {
      break;
    }
  }

  await centerOnColumn(bot, column.x, column.z);
  await bot.lookAt(column.offset(0.5, anchorY + 0.5, 0.5), true);

  const dist = horizontalDistToColumn(bot, column.x, column.z);
  if (dist <= TRUNK_APPROACH_HORIZ_M) {
    console.log(`[tree] at trunk (${column.x},${column.z}) — ${dist.toFixed(1)}m away`);
    return true;
  }

  console.log(
    `[tree] cannot approach trunk at (${column.x},${column.z}) — ${dist.toFixed(1)}m away (need ≤${TRUNK_APPROACH_HORIZ_M}m)`
  );
  return false;
}

async function lookStraightUp(
  bot: Bot,
  tree: DetectedTree,
  session?: TreeChopSession
): Promise<void> {
  const eye = bot.entity.position;
  const lookY = eye.y + Math.min(tree.maxScanHeight, 20);
  await bot.lookAt(new Vec3(eye.x, lookY, eye.z), true);
  session?.noteLookUp();
}

function scanLogBlocks(bot: Bot, maxDistance: number): Block[] {
  const center = bot.entity.position.floored();
  const r = Math.min(Math.max(8, maxDistance), 64);
  const logs: Block[] = [];
  const seen = new Set<string>();

  for (let x = -r; x <= r; x++) {
    for (let y = -2; y <= 32; y++) {
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

/** Step up existing solids in the trunk column. */
async function mountColumnStack(
  bot: Bot,
  columnX: number,
  columnZ: number,
  session?: TreeChopSession,
  maxFeetY?: number
): Promise<boolean> {
  const startFeet = feetBlockY(bot);
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
    if (!(await mountPillarBlock(bot, pos, session))) {
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
    if (dist > 2) {
      stopPathfinding(bot);
      configureTreeMovements(bot);
      bot.pathfinder.setGoal(new goals.GoalNear(t.x, t.y, t.z, 0.8));
      try {
        await waitForGoal(bot, 5000);
      } catch {
        // may still be in pickup range
      }
      stopPathfinding(bot);
    } else {
      await bot.lookAt(t, true);
      bot.setControlState("forward", dist > 1);
      await delay(300);
      bot.clearControlStates();
    }
    await delay(300);
  } else {
    await delay(500);
  }

  if (allowShuffle && distToBlock(bot, near) <= 3) {
    await centerOnColumn(bot, near.x, near.z, session);
    await delay(200);
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
  return scanTreeLogs(bot, tree).filter((p) => !skip.has(posKeyVec(p)));
}

/** Break reachable leaves on and beside the trunk so logs are accessible. */
async function clearTrunkLeaves(bot: Bot, tree: DetectedTree, maxBreaks = 12): Promise<number> {
  await equipToolCategory(bot, "axe");
  const leaves = scanTrunkLeaves(bot, tree);
  let cleared = 0;

  for (const pos of leaves) {
    if (cleared >= maxBreaks) {
      break;
    }
    if (distToBlock(bot, pos) > MAX_DIG_REACH) {
      continue;
    }
    const block = bot.blockAt(pos);
    if (!block || block.name === "air") {
      continue;
    }
    try {
      await digBlockInReach(bot, block, { tool: "axe" });
      console.log(`[tree] cleared leaf ${block.name} at (${pos.x},${pos.y},${pos.z})`);
      cleared += 1;
      await delay(80);
    } catch {
      // leaf may be out of reach after another break
    }
  }

  if (cleared > 0) {
    console.log(`[tree] cleared ${cleared} leaf block(s) around trunk`);
  }
  return cleared;
}

async function clearPillarObstruction(bot: Bot, pos: Vec3): Promise<void> {
  const block = bot.blockAt(pos);
  if (!block || block.name === "air" || isLogBlockName(block.name) || !isPillarReplaceable(block)) {
    return;
  }
  if (distToBlock(bot, pos) > MAX_DIG_REACH) {
    return;
  }
  try {
    await equipToolCategory(bot, "axe");
    await digBlockInReach(bot, block, { tool: "axe" });
    console.log(`[tree] cleared ${block.name} at (${pos.x},${pos.y},${pos.z}) for pillar`);
    await delay(150);
  } catch {
    // non-fatal
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
    if (isOurPlacedStep(stepPos, placedSteps)) {
      if (isStandingOnBlock(bot, stepPos)) {
        return true;
      }
      if (!(await equipLogInHand(bot, logType))) {
        return false;
      }
      console.log(`[tree] step up pillar at (${stepPos.x},${stepPos.y},${stepPos.z})`);
      return mountPillarBlock(bot, stepPos, session);
    }
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

  if (!(await equipLogInHand(bot, logType))) {
    console.log("[tree] pillar: no log in hand");
    return false;
  }

  const ground = bot.blockAt(groundPos);
  if (!ground || !isSolidGround(ground)) {
    return false;
  }

  console.log(
    `[tree] equip log → place in trunk column at (${stepPos.x},${stepPos.y},${stepPos.z}) on ${ground.name}`
  );

  const rl = getTreeChopRL();
  const timings = rl.getTimings();

  await bot.lookAt(ground.position.offset(0.5, 1, 0.5), true);
  bot.setControlState("jump", true);
  await delay(timings.placeJumpMs);

  try {
    await bot.placeBlock(ground, new Vec3(0, 1, 0));
    bot.setControlState("jump", false);
    await delay(timings.placeSettleMs);
  } catch (err) {
    bot.setControlState("jump", false);
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[tree] place log failed: ${msg}`);
    session?.noteJumpNoPlace(stepPos, "place failed");
    return false;
  }

  const placed = bot.blockAt(stepPos);
  if (!placed || placed.name === "air") {
    session?.noteJumpNoPlace(stepPos, "no block after place");
    return false;
  }

  placedSteps.push(stepPos.clone());
  session?.notePillarPlace(stepPos);
  rl.adaptTiming("place", true, timings);

  if (!(await equipLogInHand(bot, logType))) {
    return false;
  }
  console.log(`[tree] jump onto placed log at (${stepPos.x},${stepPos.y},${stepPos.z})`);
  return mountPillarBlock(bot, stepPos, session);
}

/**
 * One climb action: place a log on the trunk column when possible.
 */
async function pillarOneStep(
  bot: Bot,
  columnX: number,
  columnZ: number,
  logType: string,
  placedSteps: Vec3[],
  session?: TreeChopSession
): Promise<boolean> {
  stopPathfinding(bot);
  const feetBefore = feetBlockY(bot);

  await ensureClimbLogs(bot, logType, new Vec3(columnX, bot.entity.position.y, columnZ));

  if (logCount(bot) > 0) {
    if (await placeLogPillarStep(bot, columnX, columnZ, logType, placedSteps, session)) {
      return feetBlockY(bot) > feetBefore;
    }
    return false;
  }

  const stepPos = new Vec3(columnX, feetBlockY(bot) + 1, columnZ);
  const stepBlock = bot.blockAt(stepPos);
  if (isClimbStepBlock(stepBlock) && !isStandingOnBlock(bot, stepPos)) {
    console.log(`[tree] mounting step at (${stepPos.x},${stepPos.y},${stepPos.z})`);
    if (await mountPillarBlock(bot, stepPos, session)) {
      return feetBlockY(bot) > feetBefore;
    }
  }

  if (await mountColumnStack(bot, columnX, columnZ, session)) {
    return feetBlockY(bot) > feetBefore;
  }

  if (await tryStepUpNearTrunk(bot, columnX, columnZ, session)) {
    return feetBlockY(bot) > feetBefore;
  }

  return false;
}

/**
 * Stack logs in the trunk column until the target log is in reach, then equip axe.
 */
async function climbTowardLog(
  bot: Bot,
  target: Vec3,
  topLog: Vec3,
  tree: DetectedTree,
  placedSteps: Vec3[],
  session: TreeChopSession,
  _anchorY: number
): Promise<boolean> {
  await standUnderLog(bot, target, session);

  let plan = measureClimbGap(bot, tree, target, topLog, placedSteps);
  console.log(`[tree] climb plan: ${formatClimbGap(plan)}`);

  if (!plan.enoughLogs) {
    await ensureClimbLogs(bot, tree.logType, target);
    plan = measureClimbGap(bot, tree, target, topLog, placedSteps);
    console.log(`[tree] after pickup: ${formatClimbGap(plan)}`);
    if (!plan.enoughLogs) {
      console.log(
        `[tree] cannot build pillar — need ${plan.pillarLogsNeeded} logs, have ${plan.logsAvailable}`
      );
      return false;
    }
  }

  const column = plan.pillarColumn;
  const startFeet = feetBlockY(bot);
  const maxSteps = Math.min(tree.maxScanHeight, plan.pillarLogsNeeded + 2);

  console.log(
    `[tree] pillar climb in trunk column (${column.x},${column.z}) — ` +
      `${plan.pillarLogsNeeded} log(s) to reach y=${plan.topLogY}`
  );

  await centerOnColumn(bot, column.x, column.z, session);

  for (let step = 0; step < maxSteps; step++) {
    if (canReachLog(bot, target)) {
      await equipToolCategory(bot, "axe");
      return true;
    }

    const remaining = plan.pillarLogsNeeded - (feetBlockY(bot) - startFeet);
    if (remaining <= 0 && !canReachLog(bot, target)) {
      console.log(`[tree] pillar built but target still out of reach at y=${feetBlockY(bot)}`);
      return false;
    }

    if (logCount(bot) === 0) {
      console.log(`[tree] out of logs with ${remaining} pillar step(s) left`);
      return false;
    }

    const feetBefore = feetBlockY(bot);
    const progressed = await placeLogPillarStep(
      bot,
      column.x,
      column.z,
      tree.logType,
      placedSteps,
      session
    );

    if (canReachLog(bot, target)) {
      await equipToolCategory(bot, "axe");
      return true;
    }

    if (!progressed || feetBlockY(bot) <= feetBefore) {
      console.log(
        `[tree] pillar step failed at y=${feetBlockY(bot)} ` +
          `(${Math.max(0, remaining)} left of ${plan.pillarLogsNeeded})`
      );
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
  try {
    await digBlockInReach(bot, block, { tool: "axe" });
    console.log(`[tree] broke ${block.name} at (${pos.x},${pos.y},${pos.z})`);
    session?.noteBreak(bot, pos);
    const elevated = anchorY != null && isElevatedOnTree(bot, anchorY);
    await pickupLogsNear(bot, pos, logType ?? block.name, !elevated, session);
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
  let idlePasses = 0;

  console.log(`[tree] ${tree.description}`);
  console.log(
    `[tree] chopping ${tree.profile.label} at (${anchor.x}, ${anchor.y}, ${anchor.z}) — ` +
      `${tree.trunkShape} trunk, ~${tree.estimatedLogs} logs, scan r${tree.scanRadius} h${tree.maxScanHeight}`
  );

  const rl = getTreeChopRL();
  const session = rl.startSession();

  let pillarAttempts = 0;
  let climbStuckPasses = 0;

  await clearTrunkLeaves(bot, tree, 24);

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
  let column = new Vec3(startPillar.x, anchor.y, startPillar.z);

  if (!(await approachTrunk(bot, column, anchor.y))) {
    rl.finishSession(session);
    return {
      ok: false,
      reason: `Could not reach the ${tree.profile.label.toLowerCase()} tree — tp me next to it or clear blocks around the trunk.`,
      treeType: tree.profile.label,
      treeDescription: tree.description,
      rlPoints: session.points
    };
  }

  const topY = liveAtStart[liveAtStart.length - 1]!.y;
  const gap = measureClimbGap(bot, tree, firstLog, liveAtStart[liveAtStart.length - 1]!, placedSteps);
  console.log(`[tree] ${liveAtStart.length} trunk log(s) y=${firstLog.y}–${topY}; ${formatClimbGap(gap)}`);

  while (Date.now() < deadline) {
    if (isSleepRoutineActive()) {
      break;
    }

    stopPathfinding(bot);
    await equipToolCategory(bot, "axe");

    await clearTrunkLeaves(bot, tree, 8);

    const elevated = isElevatedOnTree(bot, anchor.y);
    if (!elevated && !isOnColumn(bot, column.x, column.z)) {
      await approachTrunk(bot, column, anchor.y);
    }

    const liveLogs = scanChoppableLogs(bot, tree, placedSteps);
    const focusLog =
      liveLogs.find((p) => !canReachLog(bot, p)) ?? liveLogs[liveLogs.length - 1];
    if (focusLog) {
      const p = pickTrunkPillarColumn(tree, focusLog, bot);
      column = new Vec3(p.x, anchor.y, p.z);
    }

    if (liveLogs.length === 0) {
      const trunkLeavesLeft = scanTrunkLeaves(bot, tree).length;
      if (trunkLeavesLeft > 0) {
        await clearTrunkLeaves(bot, tree, 16);
      }
      const leavesLeft = countLeavesNear(bot, tree);
      console.log(
        `[tree] no logs left — ${trunkLeavesLeft > 0 ? "cleared trunk leaves" : `${leavesLeft} canopy leaves remain`}`
      );
      break;
    }

    const reachable = liveLogs.filter((p) => canReachLog(bot, p)).sort((a, b) => a.y - b.y);

    if (reachable.length > 0) {
      idlePasses = 0;
      pillarAttempts = 0;
      climbStuckPasses = 0;
      for (const pos of reachable) {
        if (await breakLogInPlace(bot, pos, tree.logType, anchor.y, session)) {
          logsCut += 1;
        }
      }
      continue;
    }

    await clearTrunkLeaves(bot, tree, 6);
    await lookStraightUp(bot, tree, session);

    const remaining = liveLogs
      .filter((p) => !canReachLog(bot, p))
      .sort((a, b) => a.y - b.y);

    if (remaining.length === 0) {
      idlePasses += 1;
      if (idlePasses >= 2) {
        break;
      }
      continue;
    }

    const next = remaining[0]!;
    idlePasses = 0;

    if (canReachLog(bot, next)) {
      if (await breakLogInPlace(bot, next, tree.logType, anchor.y, session)) {
        logsCut += 1;
        pillarAttempts = 0;
      }
      continue;
    }

    if (horizontalDistToColumn(bot, next.x, next.z) > 1.2) {
      console.log(`[tree] moving under log at (${next.x},${next.y},${next.z})`);
      await standUnderLog(bot, next, session);
      climbStuckPasses = 0;
      if (canReachLog(bot, next)) {
        continue;
      }
    }

    const maxClimbPasses = logCount(bot) >= 3 ? 10 : 3;
    if (pillarAttempts >= maxClimbPasses || climbStuckPasses >= maxClimbPasses) {
      rl.finishSession(session);
      return {
        ok: logsCut > 0,
        reason:
          logsCut > 0
            ? `${tree.profile.label}: cut ${logsCut} logs but could not climb higher — need more logs for pillar or stand closer`
            : `Could not reach the ${tree.profile.label.toLowerCase()} trunk — move me closer to the tree base`,
        logsCut,
        rlPoints: session.points,
        treeType: tree.profile.label,
        treeDescription: tree.description
      };
    }

    const topLog = remaining[remaining.length - 1] ?? next;
    const climbPlan = measureClimbGap(bot, tree, next, topLog, placedSteps);
    console.log(`[tree] log at (${next.x},${next.y},${next.z}) out of reach`);
    console.log(`[tree] ${formatClimbGap(climbPlan)}`);

    const climbed = await climbTowardLog(bot, next, topLog, tree, placedSteps, session, anchor.y);
    pillarAttempts += 1;

    if (!climbed && !canReachLog(bot, next)) {
      climbStuckPasses += 1;
      console.log(`[tree] climb stuck (${climbStuckPasses}/3) — feet at y=${feetBlockY(bot)}`);
      if (logCount(bot) === 0) {
      rl.finishSession(session);
      return {
        ok: logsCut > 0,
        reason:
          logsCut > 0
            ? `${tree.profile.label}: cut ${logsCut} logs — pick up more logs for pillar (say check logs)`
            : `Need logs in inventory to build pillar — pick up drops or say check logs`,
        logsCut,
        rlPoints: session.points,
        treeType: tree.profile.label,
        treeDescription: tree.description
      };
      }
      await delay(300);
      continue;
    }
    climbStuckPasses = 0;

    await equipToolCategory(bot, "axe");
    await lookStraightUp(bot, tree, session);

    const stillReachable = scanChoppableLogs(bot, tree, placedSteps)
      .filter((p) => canReachLog(bot, p))
      .sort((a, b) => a.y - b.y);
    for (const pos of stillReachable) {
      if (await breakLogInPlace(bot, pos, tree.logType, anchor.y, session)) {
        logsCut += 1;
        pillarAttempts = 0;
      }
    }
  }

  placedSteps.sort((a, b) => b.y - a.y);
  for (const pos of placedSteps) {
    const block = bot.blockAt(pos);
    if (isLogBlock(block)) {
      await breakLogInPlace(bot, pos, tree.logType, anchor.y, session);
      logsCut += 1;
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

  const left = scanChoppableLogs(bot, tree, placedSteps).length;
  const leavesLeft = countLeavesNear(bot, tree);
  const done = left === 0;
  const pts = session.points > 0 ? `; +${session.points} RL pts` : "";
  const msg = done
    ? `${tree.profile.label} tree done (${logsCut} logs, leaves decaying); stashed ${stashed}${pts}`
    : `${tree.profile.label}: cut ${logsCut} logs (${left} trunk left, ${leavesLeft} leaf blocks); stashed ${stashed}${pts}`;

  console.log(`[tree] ${msg}`);
  return {
    ok: done || logsCut > 0,
    logsCut,
    stashed,
    reason: msg,
    treeType: tree.profile.label,
    treeDescription: tree.description,
    rlPoints: session.points
  };
}
