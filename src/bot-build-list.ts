import { Bot } from "mineflayer";
import { Block } from "prismarine-block";
import { goals, Movements } from "mineflayer-pathfinder";
import { Vec3 } from "vec3";
import {
  craftAllPlanksFromLogs,
  countPlanks,
  countSticks,
  craftItem,
  craftSticksFromPlanks,
  ensureCraftingTable
} from "./bot-craft";
import { HousePlan } from "./house-blueprint";
import { isSleepRoutineActive } from "./bot-sleep";

/** Mineflayer / 1.21 sign line limit */
const SIGN_LINE_MAX = 45;
const MAX_LIST_SIGNS = 4;

let listSignPositions = new Map<string, Vec3[]>();

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function posKey(pos: Vec3): string {
  return `${pos.x},${pos.y},${pos.z}`;
}

function buildAnchorKey(plan: HousePlan): string {
  return posKey(plan.signPos);
}

function isSignBlockName(name: string): boolean {
  return name.endsWith("_sign");
}

function countItem(bot: Bot, name: string): number {
  return bot.inventory.items().filter((i) => i.name === name).reduce((n, i) => n + i.count, 0);
}

export function countSignItems(bot: Bot): number {
  return bot.inventory
    .items()
    .filter((i) => isSignItemName(i.name))
    .reduce((n, i) => n + i.count, 0);
}

export function isSignItemName(name: string): boolean {
  return name.endsWith("_sign") && !name.includes("hanging");
}

function searchOrigin(bot: Bot): Vec3 {
  const ownerName = (process.env.MC_OWNER ?? "").trim();
  const owner = ownerName ? bot.players[ownerName]?.entity : undefined;
  return owner?.position ?? bot.entity.position;
}

function isReplaceableForSign(block: Block | null): boolean {
  if (!block || block.name === "air") {
    return true;
  }
  return (
    block.boundingBox === "empty" ||
    block.name.includes("grass") ||
    block.name === "tall_grass" ||
    block.name === "fern" ||
    block.name === "snow"
  );
}

function isSolidSupport(block: Block | null): boolean {
  if (!block || block.name === "air" || block.boundingBox === "empty") {
    return false;
  }
  if (isSignBlockName(block.name)) {
    return false;
  }
  return true;
}

export function findStandingSignSpot(bot: Bot, near: Vec3, radius = 4): Vec3 | null {
  const base = near.floored();
  const candidates: Vec3[] = [];

  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dy = -2; dy <= 2; dy++) {
        const signPos = base.offset(dx, dy, dz);
        const support = bot.blockAt(signPos.offset(0, -1, 0));
        const space = bot.blockAt(signPos);
        if (!isSolidSupport(support)) {
          continue;
        }
        if (space && isSignBlockName(space.name)) {
          candidates.push(signPos);
          continue;
        }
        if (isReplaceableForSign(space)) {
          candidates.push(signPos);
        }
      }
    }
  }

  candidates.sort(
    (a, b) =>
      base.distanceTo(a.offset(0.5, 0.5, 0.5)) - base.distanceTo(b.offset(0.5, 0.5, 0.5))
  );
  return candidates[0] ?? null;
}

/** Pick up sign items the owner threw on the ground. */
export async function pickupNearbySignItems(bot: Bot): Promise<number> {
  const before = countSignItems(bot);

  for (let round = 0; round < 15; round++) {
    if (countSignItems(bot) > before) {
      console.log(`[build] picked up ${countSignItems(bot) - before} sign(s) from the ground`);
      return countSignItems(bot) - before;
    }

    const drop = bot.nearestEntity((entity) => {
      if (!entity.position || entity === bot.entity || entity.name !== "item") {
        return false;
      }
      return entity.position.distanceTo(bot.entity.position) <= 10;
    });

    if (!drop?.position) {
      await delay(400);
      continue;
    }

    const dist = bot.entity.position.distanceTo(drop.position);
    if (dist > 1.6) {
      const movements = new Movements(bot);
      movements.canDig = false;
      bot.pathfinder.setMovements(movements);
      bot.pathfinder.setGoal(
        new goals.GoalNear(drop.position.x, drop.position.y, drop.position.z, 0.7)
      );
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            bot.pathfinder.setGoal(null);
            reject(new Error("timeout"));
          }, 5000);
          const onGoal = () => {
            clearTimeout(timer);
            bot.removeListener("goal_reached", onGoal);
            resolve();
          };
          bot.on("goal_reached", onGoal);
        });
      } catch {
        // keep trying
      }
      bot.pathfinder.setGoal(null);
    }
    await delay(350);
  }

  const after = countSignItems(bot);
  if (after > before) {
    console.log(`[build] picked up ${after - before} sign(s) from the ground`);
  }
  return after - before;
}

/** Readable material name for sign lines. */
export function shortMaterialLabel(name: string): string {
  return name.replace(/_/g, " ");
}

function clampLine(text: string): string {
  return text.slice(0, SIGN_LINE_MAX);
}

export function missingMaterialNeeds(bot: Bot, needs: Map<string, number>): Map<string, number> {
  const missing = new Map<string, number>();
  for (const [name, need] of needs) {
    const still = need - countItem(bot, name);
    if (still > 0) {
      missing.set(name, still);
    }
  }
  return missing;
}

/** Split missing materials into 4-line sign pages. */
export function formatBuildListPages(missing: Map<string, number>): string[][] {
  if (missing.size === 0) {
    return [["Build list", "all set!", "", ""]];
  }

  const pages: string[][] = [];
  let page: string[] = [clampLine("-- need list --")];
  const sorted = [...missing.entries()].sort((a, b) => b[1] - a[1]);

  for (const [name, count] of sorted) {
    const line = clampLine(`${count} ${shortMaterialLabel(name)}`);
    if (page.length >= 4) {
      pages.push(page);
      page = [clampLine("-- need list --")];
    }
    page.push(line);
  }

  while (page.length < 4) {
    page.push("");
  }
  pages.push(page);
  return pages.slice(0, MAX_LIST_SIGNS);
}

/**
 * Right-click the sign (like a player) then send the edit packet.
 * mineflayer updateSign expects newline-separated text, not an array.
 */
async function writeSignLines(bot: Bot, block: Block, lines: string[]): Promise<void> {
  const padded = [lines[0] ?? "", lines[1] ?? "", lines[2] ?? "", lines[3] ?? ""].map(clampLine);
  const text = padded.join("\n");

  if (!bot.updateSign) {
    console.warn("[build] bot.updateSign missing — cannot write sign");
    return;
  }

  try {
    await bot.unequip("hand");
  } catch {
    // empty hand not required but helps avoid accidental place
  }

  await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true);

  try {
    await bot.activateBlock(block);
    await delay(300);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[build] sign right-click: ${msg}`);
  }

  bot.updateSign(block, text, false);
  await delay(200);
}

async function pathNear(bot: Bot, pos: Vec3): Promise<boolean> {
  const movements = new Movements(bot);
  movements.canDig = false;
  bot.pathfinder.setMovements(movements);
  bot.pathfinder.setGoal(new goals.GoalNear(pos.x, pos.y, pos.z, 2.5));
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        bot.pathfinder.setGoal(null);
        reject(new Error("timeout"));
      }, 10_000);
      const onGoal = () => {
        clearTimeout(timer);
        bot.removeListener("goal_reached", onGoal);
        resolve();
      };
      bot.on("goal_reached", onGoal);
    });
    bot.pathfinder.setGoal(null);
    return true;
  } catch {
    bot.pathfinder.setGoal(null);
    return false;
  }
}

function listSignSlots(plan: HousePlan, count: number): Vec3[] {
  const slots: Vec3[] = [];
  const baseX = plan.signPos.x + 2;
  const y = plan.floorY + 1;
  const z = plan.signPos.z;
  for (let i = 0; i < count; i++) {
    slots.push(new Vec3(baseX + i, y, z));
  }
  return slots;
}

function pickPlanksForSign(bot: Bot): string | null {
  const stacks = bot.inventory
    .items()
    .filter((i) => i.name.endsWith("_planks"))
    .sort((a, b) => b.count - a.count);
  return stacks[0]?.name ?? null;
}

function signItemForPlanks(planksName: string): string {
  if (planksName.endsWith("_planks")) {
    return planksName.replace("_planks", "_sign");
  }
  return "oak_sign";
}

/** Craft signs only when inventory has none (after optional ground pickup). */
export async function craftSignsFromSupplies(bot: Bot, maxDistance: number): Promise<boolean> {
  if (countSignItems(bot) > 0) {
    return true;
  }

  await pickupNearbySignItems(bot);
  if (countSignItems(bot) > 0) {
    return true;
  }

  await craftAllPlanksFromLogs(bot);

  if (countSticks(bot) < 1 && countPlanks(bot) >= 2) {
    await craftSticksFromPlanks(bot, 4);
  }

  const planksType = pickPlanksForSign(bot);
  if (!planksType || countPlanks(bot) < 6 || countSticks(bot) < 1) {
    return false;
  }

  const table = await ensureCraftingTable(bot, maxDistance);
  if (!table) {
    return false;
  }

  let signName = signItemForPlanks(planksType);
  if (!bot.registry.itemsByName[signName]) {
    signName = "oak_sign";
  }

  const ok = await craftItem(bot, signName, 1, table);
  if (!ok && signName !== "oak_sign") {
    await craftItem(bot, "oak_sign", 1, table);
  }

  return countSignItems(bot) > 0;
}

function findSignBlockAt(bot: Bot, signPos: Vec3): Block | null {
  const direct = bot.blockAt(signPos);
  if (direct && isSignBlockName(direct.name)) {
    return direct;
  }
  for (const off of [
    new Vec3(0, 0, 0),
    new Vec3(1, 0, 0),
    new Vec3(-1, 0, 0),
    new Vec3(0, 0, 1),
    new Vec3(0, 0, -1)
  ]) {
    const block = bot.blockAt(signPos.plus(off));
    if (block && isSignBlockName(block.name)) {
      return block;
    }
  }
  return null;
}

async function placeStandingSign(bot: Bot, signPos: Vec3): Promise<Block | null> {
  const existing = findSignBlockAt(bot, signPos);
  if (existing) {
    return existing;
  }

  const support = bot.blockAt(signPos.offset(0, -1, 0));
  if (!isSolidSupport(support)) {
    return null;
  }

  const stacks = bot.inventory.items().filter((i) => isSignItemName(i.name));
  if (stacks.length === 0) {
    return null;
  }

  for (const stack of stacks) {
    await bot.equip(stack, "hand");
    await delay(80);

    try {
      await bot.lookAt(support!.position.offset(0.5, 0.5, 0.5), true);
      await bot.placeBlock(support!, new Vec3(0, 1, 0));
      await delay(400);
      const placed = findSignBlockAt(bot, signPos);
      if (placed) {
        return placed;
      }
    } catch {
      // try next stack
    }
  }
  return null;
}

/** Place a build-center marker sign near the owner and label it. */
export async function placeBuildMarkerSign(
  bot: Bot,
  maxDistance = 48
): Promise<Block | null> {
  if (countSignItems(bot) === 0) {
    await craftSignsFromSupplies(bot, maxDistance);
  }
  if (countSignItems(bot) === 0) {
    return null;
  }

  const origin = searchOrigin(bot);
  await pathNear(bot, origin.offset(0.5, 1, 0.5));

  let spot = findStandingSignSpot(bot, origin);
  if (!spot) {
    spot = findStandingSignSpot(bot, bot.entity.position);
  }
  if (!spot) {
    console.log("[build] no flat spot to place a sign");
    return null;
  }

  const block = await placeStandingSign(bot, spot);
  if (!block) {
    return null;
  }

  await writeSignLines(bot, block, ["Cottage", "center", "", ""]);
  console.log(
    `[build] placed build marker sign at (${block.position.x},${block.position.y},${block.position.z})`
  );
  return block;
}

/**
 * Find a world sign, or pick up / place one from inventory.
 */
export async function resolveBuildSign(
  bot: Bot,
  findPlaced: (maxDistance: number) => Block | null,
  maxDistance: number
): Promise<Block | null> {
  let sign = findPlaced(maxDistance);
  if (sign) {
    return sign;
  }

  if (countSignItems(bot) === 0) {
    await pickupNearbySignItems(bot);
    if (countSignItems(bot) === 0) {
      await craftSignsFromSupplies(bot, maxDistance);
    }
  }

  if (countSignItems(bot) > 0) {
    sign = await placeBuildMarkerSign(bot, maxDistance);
    if (sign) {
      return sign;
    }
  }

  return findPlaced(maxDistance);
}

/**
 * Place or update signs beside the build marker with a shopping list.
 */
export async function postBuildMaterialList(
  bot: Bot,
  plan: HousePlan,
  needs: Map<string, number>,
  maxDistance: number
): Promise<boolean> {
  if (isSleepRoutineActive()) {
    return false;
  }

  const missing = missingMaterialNeeds(bot, needs);
  const pages = formatBuildListPages(missing);
  if (pages.length === 0) {
    return false;
  }

  const anchor = buildAnchorKey(plan);
  const slots = listSignSlots(plan, pages.length);
  const known = listSignPositions.get(anchor) ?? [];

  await pathNear(bot, plan.signPos.offset(0.5, 1, 0.5));

  if (countSignItems(bot) === 0) {
    await pickupNearbySignItems(bot);
    if (countSignItems(bot) === 0) {
      await craftSignsFromSupplies(bot, maxDistance);
    }
  }
  if (countSignItems(bot) === 0) {
    return false;
  }

  const placed: Vec3[] = [];
  for (let i = 0; i < pages.length; i++) {
    const slot = slots[i]!;
    let block: Block | null = bot.blockAt(slot);
    if (!block || !isSignBlockName(block.name)) {
      block = await placeStandingSign(bot, slot);
    }
    if (!block || !isSignBlockName(block.name)) {
      const alt = findStandingSignSpot(bot, slot, 2);
      if (alt) {
        block = await placeStandingSign(bot, alt);
      }
    }
    if (!block || !isSignBlockName(block.name)) {
      continue;
    }
    await writeSignLines(bot, block, pages[i]!);
    placed.push(block.position.clone());
    await delay(250);
  }

  if (placed.length > 0) {
    listSignPositions.set(anchor, placed);
    const summary = [...missing.entries()]
      .map(([n, c]) => `${c} ${shortMaterialLabel(n)}`)
      .join(", ");
    console.log(`[build] material list on ${placed.length} sign(s): ${summary || "all set"}`);
    return true;
  }

  if (known.length > 0) {
    for (let i = 0; i < Math.min(known.length, pages.length); i++) {
      const block = bot.blockAt(known[i]!);
      if (block && isSignBlockName(block.name)) {
        await writeSignLines(bot, block, pages[i]!);
      }
    }
    return true;
  }

  return false;
}

export function buildListSignHint(plan: HousePlan): string {
  return `Check the signs east of the build marker (${plan.signPos.x + 2},${plan.floorY + 1},${plan.signPos.z}) for what I still need.`;
}

export function clearBuildListSigns(plan: HousePlan): void {
  listSignPositions.delete(buildAnchorKey(plan));
}
