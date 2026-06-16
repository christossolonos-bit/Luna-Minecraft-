import { Bot } from "mineflayer";
import { Block } from "prismarine-block";
import { goals, Movements } from "mineflayer-pathfinder";
import { Vec3 } from "vec3";
import {
  craftAllPlanksFromLogs,
  countLogs,
  countPlanks,
  craftItem,
  ensureCraftingTable
} from "./bot-craft";
import { takeHouseSuppliesFromNearbyChest } from "./bot-chest";
import { abortActiveMining, mineBlockReliably } from "./bot-gather";
import { equipToolCategory } from "./bot-inventory";
import { chopTreeAndStash } from "./bot-tree";
import {
  buildListSignHint,
  clearBuildListSigns,
  missingMaterialNeeds,
  postBuildMaterialList,
  resolveBuildSign
} from "./bot-build-list";
import { scaffoldUntilReach } from "./bot-scaffold";
import { isSleepRoutineActive } from "./bot-sleep";
import {
  collectPlaceJobs,
  describeMissingGaps,
  doorForStructure,
  findMissingFromBlueprint,
  HOUSE_MATERIAL_NAMES,
  HOUSE_SIZE,
  HOUSE_STYLE_LABEL,
  isDoorwayBlocked,
  jobStillOpen,
  materialNeeds,
  pickFoundationMaterial,
  pickStructureMaterial,
  pickWindowMaterial,
  PlaceJob,
  planStarterCottage,
  sortPlaceJobs,
  FOUNDATION_MATERIALS,
  summarizeBlueprint
} from "./house-blueprint";

const MAX_PLACE_REACH = 4.5;

export type BuildHouseResult = {
  ok: boolean;
  reason?: string;
  placed?: number;
  needed?: number;
  incomplete?: boolean;
  detail?: "incomplete" | "need_sign";
};

type HouseMaterials = {
  structure: string;
  foundation: string | null;
  window: string;
  door: string;
};

let pendingHouseBuild: {
  signPos: Vec3;
  jobs: PlaceJob[];
  maxDistance: number;
  materials: HouseMaterials;
} | null = null;

export function hasPendingHouseBuild(): boolean {
  return pendingHouseBuild !== null && pendingHouseBuild.jobs.length > 0;
}

export function clearPendingHouseBuild(): void {
  pendingHouseBuild = null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function posKey(pos: Vec3): string {
  return `${pos.x},${pos.y},${pos.z}`;
}

function isSignBlockName(name: string): boolean {
  return name.endsWith("_sign");
}

function searchOrigin(bot: Bot): Vec3 {
  const ownerName = (process.env.MC_OWNER ?? "").trim();
  const owner = ownerName ? bot.players[ownerName]?.entity : undefined;
  return owner?.position ?? bot.entity.position;
}

function findSignBlocks(bot: Bot, maxDistance: number): Block[] {
  const matcher = (block: Block) => isSignBlockName(block.name);
  const findBlocks = (bot as Bot & { findBlocks?: (opts: object) => Vec3[] }).findBlocks;
  let positions: Vec3[] = [];

  if (findBlocks) {
    positions = findBlocks.call(bot, { matching: matcher, maxDistance, count: 64 });
  } else {
    const single = bot.findBlock({ matching: matcher, maxDistance, count: 1 });
    if (single) {
      positions = [single.position];
    }
  }

  const blocks: Block[] = [];
  const seen = new Set<string>();
  for (const pos of positions) {
    const block = bot.blockAt(pos);
    if (!block || !isSignBlockName(block.name)) {
      continue;
    }
    const key = posKey(block.position);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    blocks.push(block);
  }
  return blocks;
}

/** Nearest sign to the owner — marks the center of the cottage. */
export function findBuildSign(bot: Bot, maxDistance = 48): Block | null {
  const signs = findSignBlocks(bot, maxDistance);
  if (signs.length === 0) {
    return null;
  }
  const origin = searchOrigin(bot);
  signs.sort(
    (a, b) =>
      origin.distanceTo(a.position.offset(0.5, 0.5, 0.5)) -
      origin.distanceTo(b.position.offset(0.5, 0.5, 0.5))
  );
  return signs[0]!;
}

function resolveHouseMaterials(bot: Bot): HouseMaterials {
  const structure = pickStructureMaterial(bot);
  return {
    structure,
    foundation: pickFoundationMaterial(bot),
    window: pickWindowMaterial(bot),
    door: doorForStructure(structure)
  };
}

function countItem(bot: Bot, name: string): number {
  return bot.inventory.items().filter((i) => i.name === name).reduce((n, i) => n + i.count, 0);
}

function countHouseSupplies(bot: Bot, needs: Map<string, number>): number {
  let total = 0;
  for (const [name, need] of needs) {
    total += Math.min(countItem(bot, name), need);
  }
  return total;
}

function missingSupplyCount(bot: Bot, needs: Map<string, number>): number {
  let missing = 0;
  for (const [name, need] of needs) {
    missing += Math.max(0, need - countItem(bot, name));
  }
  return missing;
}

function missingByMaterial(bot: Bot, needs: Map<string, number>): Map<string, number> {
  const missing = new Map<string, number>();
  for (const [name, need] of needs) {
    const short = Math.max(0, need - countItem(bot, name));
    if (short > 0) {
      missing.set(name, short);
    }
  }
  return missing;
}

const STONE_MATCH = (block: Block) =>
  block.name === "stone" ||
  block.name === "deepslate" ||
  block.name === "andesite" ||
  block.name === "diorite" ||
  block.name === "granite" ||
  block.name === "tuff" ||
  block.name === "calcite" ||
  block.name === "cobblestone";

const COAL_MATCH = (block: Block) =>
  block.name === "coal_ore" || block.name === "deepslate_coal_ore";

async function gatherStoneBlocks(
  bot: Bot,
  amount: number,
  maxDistance: number,
  deadline: number
): Promise<number> {
  let collected = 0;
  await equipToolCategory(bot, "pickaxe");
  while (collected < amount && Date.now() < deadline && !isSleepRoutineActive()) {
    const block = bot.findBlock({ matching: STONE_MATCH, maxDistance, count: 1 });
    if (!block) {
      break;
    }
    try {
      abortActiveMining(bot);
      await mineBlockReliably(bot, block, {
        tool: "pickaxe",
        pathTimeoutMs: Math.min(20_000, deadline - Date.now())
      });
      collected += 1;
    } catch {
      break;
    }
  }
  return collected;
}

async function gatherCoalBlocks(
  bot: Bot,
  amount: number,
  maxDistance: number,
  deadline: number
): Promise<number> {
  let collected = 0;
  await equipToolCategory(bot, "pickaxe");
  while (collected < amount && Date.now() < deadline && !isSleepRoutineActive()) {
    const block = bot.findBlock({ matching: COAL_MATCH, maxDistance, count: 1 });
    if (!block) {
      break;
    }
    try {
      abortActiveMining(bot);
      await mineBlockReliably(bot, block, {
        tool: "pickaxe",
        pathTimeoutMs: Math.min(20_000, deadline - Date.now())
      });
      collected += 1;
    } catch {
      break;
    }
  }
  return collected;
}

async function gatherWoodForPlanks(
  bot: Bot,
  planksNeeded: number,
  structureMaterial: string,
  maxDistance: number,
  deadline: number
): Promise<boolean> {
  const maxTrees = 4;
  for (let attempt = 0; attempt < maxTrees; attempt++) {
    if (countItem(bot, structureMaterial) >= planksNeeded) {
      return true;
    }
    if (Date.now() >= deadline || isSleepRoutineActive()) {
      break;
    }

    console.log(`[build] gathering wood — need ${planksNeeded} ${structureMaterial.replace(/_/g, " ")}`);
    const chop = await chopTreeAndStash(
      bot,
      maxDistance,
      Math.min(deadline, Date.now() + 240_000)
    );
    await craftAllPlanksFromLogs(bot);

    if (countItem(bot, structureMaterial) >= planksNeeded) {
      return true;
    }
    if (!chop.ok && countLogs(bot) === 0 && countPlanks(bot) === 0) {
      return false;
    }
  }
  return countItem(bot, structureMaterial) > 0;
}

async function tryCraftDoor(
  bot: Bot,
  doorName: string,
  maxDistance: number
): Promise<boolean> {
  if (countItem(bot, doorName) > 0) {
    return true;
  }
  const table = await ensureCraftingTable(bot, maxDistance);
  if (!table) {
    return false;
  }
  return craftItem(bot, doorName, 1, table);
}

/** Chest empty — chop trees, mine stone/coal, craft door/torches. */
async function gatherHouseSupplies(
  bot: Bot,
  needs: Map<string, number>,
  materials: HouseMaterials,
  maxDistance: number,
  deadline: number
): Promise<boolean> {
  const missing = missingByMaterial(bot, needs);
  if (missing.size === 0) {
    return false;
  }

  console.log("[build] not enough in chests — gathering materials for the cottage");
  let didGather = false;

  const planksNeeded = missing.get(materials.structure) ?? 0;
  if (planksNeeded > 0 && countItem(bot, materials.structure) < planksNeeded) {
    if (await gatherWoodForPlanks(bot, planksNeeded, materials.structure, maxDistance, deadline)) {
      didGather = true;
    }
  }

  for (const foundation of FOUNDATION_MATERIALS) {
    const need = missing.get(foundation) ?? 0;
    if (need <= 0 || countItem(bot, foundation) >= need) {
      continue;
    }
    console.log(`[build] mining stone for foundation (${need} ${foundation.replace(/_/g, " ")})`);
    const mined = await gatherStoneBlocks(bot, need - countItem(bot, foundation), maxDistance, deadline);
    if (mined > 0) {
      didGather = true;
    }
    break;
  }

  const doorNeed = missing.get(materials.door) ?? 0;
  if (doorNeed > 0 && countItem(bot, materials.door) < doorNeed) {
    await craftAllPlanksFromLogs(bot);
    if (await tryCraftDoor(bot, materials.door, maxDistance)) {
      didGather = true;
      console.log(`[build] crafted ${materials.door.replace(/_/g, " ")}`);
    }
  }

  const torchNeed = missing.get("torch") ?? 0;
  if (torchNeed > 0 && countItem(bot, "torch") < torchNeed) {
    await tryCraftTorches(bot, torchNeed);
    if (countItem(bot, "torch") < torchNeed) {
      console.log("[build] mining coal for torches");
      if ((await gatherCoalBlocks(bot, 2, maxDistance, deadline)) > 0) {
        didGather = true;
      }
      await tryCraftTorches(bot, torchNeed);
    }
  }

  if (didGather) {
    await craftAllPlanksFromLogs(bot);
    const pull = await takeHouseSuppliesFromNearbyChest(bot, needs, maxDistance);
    if (pull.moved) {
      console.log("[build] took extra supplies from chest after gathering");
    }
  }

  return didGather;
}

async function tryCraftTorches(bot: Bot, need: number): Promise<void> {
  if (countItem(bot, "torch") >= need) {
    return;
  }
  const coal = countItem(bot, "coal") || countItem(bot, "charcoal");
  const sticks = countItem(bot, "stick");
  if (coal >= 1 && sticks >= 1) {
    await craftItem(bot, "torch", Math.max(4, need), null);
  }
}

/** Walk to item drops nearby (e.g. owner threw planks or glass). */
async function pickupThrownSupplies(bot: Bot, needs: Map<string, number>): Promise<number> {
  const before = countHouseSupplies(bot, needs);

  for (let round = 0; round < 12; round++) {
    const now = countHouseSupplies(bot, needs);
    if (now > before) {
      console.log(`[build] picked up house supplies from the ground`);
      return now - before;
    }

    const drop = bot.nearestEntity((entity) => {
      if (!entity.position || entity === bot.entity || entity.name !== "item") {
        return false;
      }
      return entity.position.distanceTo(bot.entity.position) <= 8;
    });

    if (!drop?.position) {
      await delay(400);
      continue;
    }

    const dist = bot.entity.position.distanceTo(drop.position);
    if (dist > 1.6) {
      configureBuildMovements(bot);
      bot.pathfinder.setGoal(
        new goals.GoalNear(drop.position.x, drop.position.y, drop.position.z, 0.7)
      );
      try {
        await waitForGoal(bot, 4000);
      } catch {
        // keep trying
      }
      bot.pathfinder.setGoal(null);
    }
    await delay(350);
  }

  return countHouseSupplies(bot, needs) - before;
}

async function ensureHouseMaterials(
  bot: Bot,
  jobs: PlaceJob[],
  maxDistance: number,
  deadline = Date.now() + 600_000
): Promise<HouseMaterials | null> {
  await craftAllPlanksFromLogs(bot);

  let materials = resolveHouseMaterials(bot);
  const needs = materialNeeds(jobs);

  if ((needs.get("torch") ?? 0) > 0) {
    await tryCraftTorches(bot, needs.get("torch") ?? 1);
  }

  let missing = missingSupplyCount(bot, needs);
  if (missing > 0) {
    await pickupThrownSupplies(bot, needs);
    missing = missingSupplyCount(bot, needs);
  }

  if (missing > 0) {
    const pull = await takeHouseSuppliesFromNearbyChest(bot, needs, maxDistance);
    if (pull.moved) {
      console.log(`[build] pulled supplies from chest for house`);
      missing = missingSupplyCount(bot, needs);
    }
  }

  if (missing > 0) {
    await pickupThrownSupplies(bot, needs);
    missing = missingSupplyCount(bot, needs);
  }

  if (missing > 0) {
    await gatherHouseSupplies(bot, needs, materials, maxDistance, deadline);
    materials = resolveHouseMaterials(bot);
    missing = missingSupplyCount(bot, needs);
  }

  if (!countItem(bot, materials.structure)) {
    return null;
  }

  if (missing > 0) {
    console.log(`[build] still short on supplies (${missing} item(s)) — will build what we can`);
  }

  return materials;
}

function configureBuildMovements(bot: Bot): void {
  const movements = new Movements(bot);
  movements.canDig = false;
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

async function pathNear(bot: Bot, pos: Vec3, timeoutMs = 15_000): Promise<boolean> {
  if (bot.entity.position.distanceTo(pos.offset(0.5, 0.5, 0.5)) <= MAX_PLACE_REACH) {
    return true;
  }
  configureBuildMovements(bot);
  bot.pathfinder.setGoal(new goals.GoalNear(pos.x, pos.y, pos.z, 2));
  try {
    await waitForGoal(bot, timeoutMs);
    bot.pathfinder.setGoal(null);
    return true;
  } catch {
    bot.pathfinder.setGoal(null);
    return false;
  }
}

const PLACE_NEIGHBORS: { off: Vec3; face: Vec3 }[] = [
  { off: new Vec3(0, -1, 0), face: new Vec3(0, 1, 0) },
  { off: new Vec3(0, 0, -1), face: new Vec3(0, 0, 1) },
  { off: new Vec3(0, 0, 1), face: new Vec3(0, 0, -1) },
  { off: new Vec3(-1, 0, 0), face: new Vec3(1, 0, 0) },
  { off: new Vec3(1, 0, 0), face: new Vec3(-1, 0, 0) },
  { off: new Vec3(0, 1, 0), face: new Vec3(0, -1, 0) }
];

async function equipItem(bot: Bot, material: string): Promise<boolean> {
  const stack = bot.inventory.items().find((i) => i.name === material);
  if (!stack) {
    return false;
  }
  await bot.equip(stack, "hand");
  await delay(80);
  return bot.heldItem?.name === material;
}

async function placeBlockAt(bot: Bot, target: Vec3, material: string): Promise<boolean> {
  const current = bot.blockAt(target);
  if (current?.name === material) {
    return true;
  }
  if (current && current.name !== "air" && !current.name.includes("grass")) {
    if (current.boundingBox !== "empty" && !current.name.includes("fern")) {
      return false;
    }
  }

  if (!(await equipItem(bot, material))) {
    return false;
  }

  for (const { off, face } of PLACE_NEIGHBORS) {
    const ref = bot.blockAt(target.plus(off));
    if (!ref || ref.name === "air" || ref.boundingBox === "empty") {
      continue;
    }
    if (isSignBlockName(ref.name)) {
      continue;
    }
    try {
      await bot.lookAt(ref.position.offset(0.5, 0.5, 0.5), true);
      await bot.placeBlock(ref, face);
      await delay(60);
      const placed = bot.blockAt(target);
      if (placed?.name === material) {
        return true;
      }
    } catch {
      // try next neighbor
    }
  }
  return false;
}

async function placeDoorAt(bot: Bot, pos: Vec3, doorMaterial: string): Promise<boolean> {
  const block = bot.blockAt(pos);
  if (block?.name.endsWith("_door")) {
    return true;
  }
  const below = bot.blockAt(pos.offset(0, -1, 0));
  if (!below || below.name === "air") {
    return false;
  }
  if (!(await equipItem(bot, doorMaterial))) {
    return false;
  }
  try {
    await bot.lookAt(below.position.offset(0.5, 0.5, 0.5), true);
    await bot.placeBlock(below, new Vec3(0, 1, 0));
    await delay(120);
    const placed = bot.blockAt(pos);
    return placed?.name.endsWith("_door") ?? false;
  } catch {
    return false;
  }
}

async function placeTorchAt(bot: Bot, pos: Vec3): Promise<boolean> {
  const block = bot.blockAt(pos);
  if (block?.name === "torch" || block?.name === "wall_torch") {
    return true;
  }
  const floor = bot.blockAt(pos.offset(0, -1, 0));
  if (!floor || floor.name === "air") {
    return false;
  }
  if (!(await equipItem(bot, "torch"))) {
    return false;
  }
  try {
    await bot.lookAt(floor.position.offset(0.5, 0.5, 0.5), true);
    await bot.placeBlock(floor, new Vec3(0, 1, 0));
    await delay(80);
    const placed = bot.blockAt(pos);
    return placed?.name === "torch";
  } catch {
    return false;
  }
}

async function placeJob(bot: Bot, job: PlaceJob): Promise<boolean> {
  switch (job.part) {
    case "door":
      return placeDoorAt(bot, job.pos, job.material);
    case "light":
      return placeTorchAt(bot, job.pos);
    case "window":
      return placeBlockAt(bot, job.pos, job.material);
    default:
      return placeBlockAt(bot, job.pos, job.material);
  }
}

/**
 * Build a starter cottage centered on the nearest sign.
 */
export async function buildHouseAroundSign(
  bot: Bot,
  maxDistance = 48,
  deadline = Date.now() + 600_000
): Promise<BuildHouseResult> {
  if (isSleepRoutineActive()) {
    return { ok: false, reason: "paused — owner is sleeping" };
  }

  abortActiveMining(bot);
  bot.pathfinder.setGoal(null);

  let sign: Block | null = null;
  if (pendingHouseBuild) {
    sign = bot.blockAt(pendingHouseBuild.signPos);
    if (!sign || !isSignBlockName(sign.name)) {
      sign = await resolveBuildSign(bot, (d) => findBuildSign(bot, d), pendingHouseBuild.maxDistance);
    }
  }
  if (!sign) {
    sign = await resolveBuildSign(bot, (d) => findBuildSign(bot, d), maxDistance);
  }
  if (!sign) {
    return {
      ok: false,
      detail: "need_sign",
      reason:
        "I need a sign for the cottage center — throw me one or place it nearby, then say build house again."
    };
  }

  const plan = planStarterCottage(sign, bot);
  let materials: HouseMaterials;
  let jobs: PlaceJob[];
  let resuming = false;

  if (pendingHouseBuild && posKey(pendingHouseBuild.signPos) === posKey(plan.signPos)) {
    materials = pendingHouseBuild.materials;
    pendingHouseBuild.jobs = pendingHouseBuild.jobs.filter((j) => jobStillOpen(bot, j));
    if (pendingHouseBuild.jobs.length > 0) {
      jobs = sortPlaceJobs(bot, pendingHouseBuild.jobs);
      resuming = true;
      console.log(
        `[build] resuming cottage at sign (${plan.signPos.x},${plan.signPos.y},${plan.signPos.z}) — ${jobs.length} job(s) left`
      );
    } else {
      pendingHouseBuild = null;
      materials = resolveHouseMaterials(bot);
      jobs = collectPlaceJobs(
        bot,
        plan,
        materials.structure,
        materials.foundation,
        materials.window,
        materials.door
      );
    }
  } else {
    materials = resolveHouseMaterials(bot);
    jobs = collectPlaceJobs(
      bot,
      plan,
      materials.structure,
      materials.foundation,
      materials.window,
      materials.door
    );
  }

  const needed = jobs.length;

  console.log(
    resuming
      ? `[build] continuing ${HOUSE_STYLE_LABEL} — ${needed} job(s) remaining`
      : `[build] ${summarizeBlueprint(plan)} — ${needed} job(s)`
  );

  const fullNeeds = materialNeeds(jobs);
  await postBuildMaterialList(bot, plan, fullNeeds, maxDistance);

  const ensured = await ensureHouseMaterials(bot, jobs, maxDistance, deadline);
  if (!ensured) {
    return {
      ok: false,
      reason:
        "Couldn't get building materials — I tried the chest and gathering wood/stone. Need trees nearby and a pickaxe.",
      needed
    };
  }
  materials = ensured;

  if (missingMaterialNeeds(bot, fullNeeds).size > 0) {
    await postBuildMaterialList(bot, plan, fullNeeds, maxDistance);
  }

  if (!(await pathNear(bot, plan.center.offset(0, 1, 0), 25_000))) {
    return { ok: false, reason: "Could not reach the build site — say tp to me first." };
  }

  const placed = await placeJobList(bot, jobs, maxDistance, deadline, needed);

  if (placed === 0) {
    return { ok: false, reason: "Could not place blocks — stand closer or clear the build area.", needed };
  }

  let remaining = jobs.filter((j) => jobStillOpen(bot, j));
  let inspectionFixed = 0;

  if (remaining.length === 0) {
    let gaps = findMissingFromBlueprint(
      bot,
      plan,
      materials.structure,
      materials.foundation,
      materials.window,
      materials.door
    );
    if (gaps.length > 0) {
      console.log(
        `[build] inspection: ${gaps.length} gap(s) (${describeMissingGaps(gaps)}) — fixing…`
      );
      await ensureHouseMaterials(bot, gaps, maxDistance, deadline);
      inspectionFixed = await placeJobList(bot, gaps, maxDistance, deadline, gaps.length);
      gaps = findMissingFromBlueprint(
        bot,
        plan,
        materials.structure,
        materials.foundation,
        materials.window,
        materials.door
      );
      remaining = gaps;
      if (gaps.length === 0) {
        console.log(`[build] inspection passed — fixed ${inspectionFixed} missing piece(s)`);
      } else {
        console.log(`[build] inspection: still ${gaps.length} gap(s) (${describeMissingGaps(gaps)})`);
      }
    } else {
      console.log("[build] inspection passed — cottage matches blueprint");
    }
  }

  const done = remaining.length === 0;
  if (!done && remaining.length > 0) {
    const stillNeeds = materialNeeds(remaining);
    await postBuildMaterialList(bot, plan, stillNeeds, maxDistance);
    pendingHouseBuild = {
      signPos: plan.signPos.clone(),
      jobs: remaining,
      maxDistance,
      materials
    };
    console.log(`[build] saved ${remaining.length} job(s) — will resume when more supplies arrive`);
  } else {
    await postBuildMaterialList(bot, plan, new Map(), maxDistance);
    clearBuildListSigns(plan);
    pendingHouseBuild = null;
  }

  const matLabel = materials.structure.replace(/_/g, " ");
  const doorwayNote =
    done && isDoorwayBlocked(bot, plan) ? " Doorway is blocked — clear it by hand." : "";
  let msg: string;
  if (done) {
    msg =
      inspectionFixed > 0
        ? `Finished the ${HOUSE_STYLE_LABEL} — inspection fixed ${inspectionFixed} missing piece(s).${doorwayNote}`
        : `Built a ${HOUSE_STYLE_LABEL} (${HOUSE_SIZE}×${HOUSE_SIZE}, porch, windows, peaked roof) — inspection passed.${doorwayNote}`;
  } else {
    msg = `Cottage in progress — ${remaining.length} piece(s) left (${describeMissingGaps(remaining)}). ${buildListSignHint(plan)}`;
  }

  console.log(`[build] ${msg}`);
  return {
    ok: placed > 0 || done,
    placed,
    needed,
    incomplete: !done,
    detail: !done ? "incomplete" : undefined,
    reason: msg
  };
}

async function placeJobList(
  bot: Bot,
  jobs: PlaceJob[],
  maxDistance: number,
  deadline: number,
  logTotal?: number
): Promise<number> {
  let placed = 0;
  let lastPathAt = 0;
  const needs = materialNeeds(jobs);
  const scaffoldSteps: Vec3[] = [];

  for (const job of jobs) {
    if (Date.now() >= deadline || isSleepRoutineActive()) {
      break;
    }

    if (countItem(bot, job.material) === 0 && job.part !== "light") {
      await pickupThrownSupplies(bot, needs);
      await ensureHouseMaterials(bot, jobs.slice(placed), maxDistance, deadline);
    }
    if (job.part === "light" && countItem(bot, "torch") === 0) {
      await tryCraftTorches(bot, 1);
      await ensureHouseMaterials(bot, jobs.slice(placed), maxDistance, deadline);
    }

    const dist = bot.entity.position.distanceTo(job.pos.offset(0.5, 0.5, 0.5));
    if (dist > MAX_PLACE_REACH && Date.now() - lastPathAt > 500) {
      await pathNear(bot, job.pos, 12_000);
      lastPathAt = Date.now();
    }

    if (bot.entity.position.distanceTo(job.pos.offset(0.5, 0.5, 0.5)) > MAX_PLACE_REACH) {
      const feet = bot.entity.position.floored();
      await scaffoldUntilReach(
        bot,
        job.pos,
        feet.x,
        feet.z,
        scaffoldSteps,
        MAX_PLACE_REACH,
        14,
        "build",
        maxDistance
      );
    }

    if (await placeJob(bot, job)) {
      placed += 1;
      if (logTotal && placed % 16 === 0) {
        console.log(`[build] placed ${placed}/${logTotal}`);
      }
    }
  }

  return placed;
}

export { HOUSE_MATERIAL_NAMES };
