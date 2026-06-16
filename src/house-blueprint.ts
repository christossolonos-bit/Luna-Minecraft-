import { Bot } from "mineflayer";
import { Block } from "prismarine-block";
import { Vec3 } from "vec3";

/** Classic Minecraft starter cottage — hollow room, porch, windows, peaked roof, door, torch. */
export const HOUSE_STYLE = "starter_cottage";
export const HOUSE_STYLE_LABEL = "starter cottage";
export const HOUSE_SIZE = 9;
export const WALL_HEIGHT = 4;
export const PORCH_DEPTH = 2;
export const PORCH_WIDTH = 3;

export type HousePart =
  | "foundation"
  | "floor"
  | "porch"
  | "wall"
  | "window"
  | "door"
  | "roof"
  | "light";

export type HousePlan = {
  style: typeof HOUSE_STYLE;
  center: Vec3;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  floorY: number;
  doorX: number;
  doorZ: number;
  doorSide: "north" | "south" | "east" | "west";
  signPos: Vec3;
};

export type PlaceJob = {
  pos: Vec3;
  part: HousePart;
  material: string;
};

export const STRUCTURE_MATERIALS = [
  "oak_planks",
  "spruce_planks",
  "birch_planks",
  "jungle_planks",
  "acacia_planks",
  "dark_oak_planks",
  "mangrove_planks",
  "cherry_planks",
  "bamboo_planks",
  "crimson_planks",
  "warped_planks"
];

export const FOUNDATION_MATERIALS = ["cobblestone", "stone_bricks", "andesite", "diorite", "granite"];

export const HOUSE_MATERIAL_NAMES = [
  ...STRUCTURE_MATERIALS,
  ...FOUNDATION_MATERIALS,
  "glass_pane",
  "glass",
  "oak_door",
  "spruce_door",
  "birch_door",
  "jungle_door",
  "acacia_door",
  "dark_oak_door",
  "mangrove_door",
  "cherry_door",
  "bamboo_door",
  "crimson_door",
  "warped_door",
  "torch"
];

function posKey(pos: Vec3): string {
  return `${pos.x},${pos.y},${pos.z}`;
}

function isSignBlockName(name: string): boolean {
  return name.endsWith("_sign");
}

function signSupportCenter(sign: Block): Vec3 {
  const p = sign.position;
  if (sign.name.includes("wall")) {
    const props = (sign as Block & { _properties?: Record<string, string> })._properties;
    const facing = props?.facing ?? "north";
    const offset =
      facing === "north"
        ? new Vec3(0, 0, 1)
        : facing === "south"
          ? new Vec3(0, 0, -1)
          : facing === "east"
            ? new Vec3(-1, 0, 0)
            : new Vec3(1, 0, 0);
    return p.plus(offset);
  }
  return new Vec3(p.x, p.y - 1, p.z);
}

function pickDoorSide(
  center: Vec3,
  approach: Vec3
): { side: HousePlan["doorSide"]; doorX: number; doorZ: number } {
  const dx = approach.x - (center.x + 0.5);
  const dz = approach.z - (center.z + 0.5);
  const half = Math.floor(HOUSE_SIZE / 2);

  if (Math.abs(dx) > Math.abs(dz)) {
    if (dx > 0) {
      return { side: "east", doorX: center.x + half, doorZ: center.z };
    }
    return { side: "west", doorX: center.x - half, doorZ: center.z };
  }
  if (dz > 0) {
    return { side: "south", doorX: center.x, doorZ: center.z + half };
  }
  return { side: "north", doorX: center.x, doorZ: center.z - half };
}

export function pickStructureMaterial(bot: Bot): string {
  const stacks = bot.inventory
    .items()
    .filter((i) => STRUCTURE_MATERIALS.includes(i.name))
    .sort((a, b) => b.count - a.count);
  return stacks[0]?.name ?? "oak_planks";
}

export function doorForStructure(material: string): string {
  if (material.endsWith("_planks")) {
    return material.replace("_planks", "_door");
  }
  return "oak_door";
}

export function pickFoundationMaterial(bot: Bot): string | null {
  const stacks = bot.inventory
    .items()
    .filter((i) => FOUNDATION_MATERIALS.includes(i.name))
    .sort((a, b) => b.count - a.count);
  return stacks[0]?.name ?? null;
}

export function pickWindowMaterial(bot: Bot): string {
  if (bot.inventory.items().some((i) => i.name === "glass_pane")) {
    return "glass_pane";
  }
  if (bot.inventory.items().some((i) => i.name === "glass")) {
    return "glass";
  }
  return "glass_pane";
}

export function planStarterCottage(sign: Block, bot: Bot): HousePlan {
  const center = signSupportCenter(sign);
  const half = Math.floor(HOUSE_SIZE / 2);
  const door = pickDoorSide(center, bot.entity.position);

  return {
    style: HOUSE_STYLE,
    center,
    minX: center.x - half,
    maxX: center.x + half,
    minZ: center.z - half,
    maxZ: center.z + half,
    floorY: center.y,
    doorX: door.doorX,
    doorZ: door.doorZ,
    doorSide: door.side,
    signPos: sign.position.clone()
  };
}

export function isDoorOpening(plan: HousePlan, x: number, y: number, z: number): boolean {
  if (y !== plan.floorY + 1 && y !== plan.floorY + 2) {
    return false;
  }
  return x === plan.doorX && z === plan.doorZ;
}

function isOnPerimeter(plan: HousePlan, x: number, z: number): boolean {
  return x === plan.minX || x === plan.maxX || z === plan.minZ || z === plan.maxZ;
}

function shouldSkipBlueprintCell(plan: HousePlan, pos: Vec3): boolean {
  return posKey(pos) === posKey(plan.signPos);
}

function porchCells(plan: HousePlan): Vec3[] {
  const cells: Vec3[] = [];
  const halfW = Math.floor(PORCH_WIDTH / 2);
  const y = plan.floorY;

  for (let d = 1; d <= PORCH_DEPTH; d++) {
    for (let w = -halfW; w <= halfW; w++) {
      let x = plan.doorX;
      let z = plan.doorZ;
      if (plan.doorSide === "north") {
        z = plan.minZ - d;
        x = plan.doorX + w;
      } else if (plan.doorSide === "south") {
        z = plan.maxZ + d;
        x = plan.doorX + w;
      } else if (plan.doorSide === "west") {
        x = plan.minX - d;
        z = plan.doorZ + w;
      } else {
        x = plan.maxX + d;
        z = plan.doorZ + w;
      }
      cells.push(new Vec3(x, y, z));
    }
  }
  return cells;
}

function windowPositions(plan: HousePlan, y: number): Vec3[] {
  const positions: Vec3[] = [];

  for (let x = plan.minX + 2; x <= plan.maxX - 2; x += 2) {
    const north = new Vec3(x, y, plan.minZ);
    const south = new Vec3(x, y, plan.maxZ);
    if (!isDoorOpening(plan, x, y, plan.minZ)) {
      positions.push(north);
    }
    if (!isDoorOpening(plan, x, y, plan.maxZ)) {
      positions.push(south);
    }
  }

  for (let z = plan.minZ + 2; z <= plan.maxZ - 2; z += 2) {
    const west = new Vec3(plan.minX, y, z);
    const east = new Vec3(plan.maxX, y, z);
    if (!isDoorOpening(plan, plan.minX, y, z)) {
      positions.push(west);
    }
    if (!isDoorOpening(plan, plan.maxX, y, z)) {
      positions.push(east);
    }
  }

  const seen = new Set<string>();
  return positions.filter((pos) => {
    const key = posKey(pos);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function interiorLightPosition(plan: HousePlan): Vec3 {
  return new Vec3(plan.center.x, plan.floorY + 1, plan.center.z);
}

/** Full cottage blueprint — what a proper Minecraft house should have. */
export function collectBlueprintJobs(
  plan: HousePlan,
  structureMaterial: string,
  foundationMaterial: string | null,
  windowMaterial: string,
  doorMaterial: string
): PlaceJob[] {
  const jobs: PlaceJob[] = [];
  const foundation = foundationMaterial ?? structureMaterial;
  const windowY = plan.floorY + 2;

  for (let x = plan.minX; x <= plan.maxX; x++) {
    for (let z = plan.minZ; z <= plan.maxZ; z++) {
      const pos = new Vec3(x, plan.floorY, z);
      if (shouldSkipBlueprintCell(plan, pos)) {
        continue;
      }
      if (isOnPerimeter(plan, x, z)) {
        jobs.push({ pos, part: "foundation", material: foundation });
      } else {
        jobs.push({ pos, part: "floor", material: structureMaterial });
      }
    }
  }

  for (const pos of porchCells(plan)) {
    jobs.push({ pos, part: "porch", material: structureMaterial });
  }

  for (let h = 1; h <= WALL_HEIGHT; h++) {
    const y = plan.floorY + h;
    for (let x = plan.minX; x <= plan.maxX; x++) {
      for (let z = plan.minZ; z <= plan.maxZ; z++) {
        if (!isOnPerimeter(plan, x, z)) {
          continue;
        }
        if (isDoorOpening(plan, x, y, z)) {
          continue;
        }
        const pos = new Vec3(x, y, z);
        if (shouldSkipBlueprintCell(plan, pos)) {
          continue;
        }
        jobs.push({ pos, part: "wall", material: structureMaterial });
      }
    }
  }

  for (const pos of windowPositions(plan, windowY)) {
    jobs.push({ pos, part: "window", material: windowMaterial });
  }

  jobs.push({
    pos: new Vec3(plan.doorX, plan.floorY + 1, plan.doorZ),
    part: "door",
    material: doorMaterial
  });

  let inset = 0;
  let roofY = plan.floorY + WALL_HEIGHT + 1;
  while (plan.maxX - plan.minX - inset * 2 >= 1 && plan.maxZ - plan.minZ - inset * 2 >= 1) {
    for (let x = plan.minX + inset; x <= plan.maxX - inset; x++) {
      for (let z = plan.minZ + inset; z <= plan.maxZ - inset; z++) {
        jobs.push({
          pos: new Vec3(x, roofY, z),
          part: "roof",
          material: structureMaterial
        });
      }
    }
    inset += 1;
    roofY += 1;
    if (inset > Math.floor(HOUSE_SIZE / 2)) {
      break;
    }
  }

  jobs.push({
    pos: interiorLightPosition(plan),
    part: "light",
    material: "torch"
  });

  return jobs;
}

const PART_ORDER: Record<HousePart, number> = {
  foundation: 0,
  floor: 1,
  porch: 2,
  wall: 3,
  window: 4,
  door: 5,
  roof: 6,
  light: 7
};

export function sortPlaceJobs(bot: Bot, jobs: PlaceJob[]): PlaceJob[] {
  return [...jobs].sort((a, b) => {
    const pa = PART_ORDER[a.part] - PART_ORDER[b.part];
    if (pa !== 0) {
      return pa;
    }
    if (a.pos.y !== b.pos.y) {
      return a.pos.y - b.pos.y;
    }
    const da = bot.entity.position.distanceTo(a.pos.offset(0.5, 0.5, 0.5));
    const db = bot.entity.position.distanceTo(b.pos.offset(0.5, 0.5, 0.5));
    return da - db;
  });
}

export function jobSatisfied(bot: Bot, job: PlaceJob): boolean {
  const block = bot.blockAt(job.pos);
  if (!block || block.name === "air") {
    return false;
  }
  if (job.part === "door") {
    return block.name.endsWith("_door");
  }
  if (job.part === "window") {
    return block.name === "glass_pane" || block.name === "glass";
  }
  if (job.part === "light") {
    return block.name === "torch" || block.name === "wall_torch";
  }
  if (job.part === "foundation") {
    return (
      block.name === job.material ||
      FOUNDATION_MATERIALS.includes(block.name) ||
      STRUCTURE_MATERIALS.includes(block.name)
    );
  }
  return block.name === job.material;
}

export function jobStillOpen(bot: Bot, job: PlaceJob): boolean {
  return !jobSatisfied(bot, job);
}

export function countJobsByPart(jobs: PlaceJob[]): Record<HousePart, number> {
  const counts = {
    foundation: 0,
    floor: 0,
    porch: 0,
    wall: 0,
    window: 0,
    door: 0,
    roof: 0,
    light: 0
  };
  for (const job of jobs) {
    counts[job.part] += 1;
  }
  return counts;
}

export function describeMissingGaps(missing: PlaceJob[]): string {
  const counts = countJobsByPart(missing);
  const parts: string[] = [];
  if (counts.wall > 0) {
    parts.push(`${counts.wall} wall`);
  }
  if (counts.window > 0) {
    parts.push(`${counts.window} window`);
  }
  if (counts.roof > 0) {
    parts.push(`${counts.roof} roof`);
  }
  if (counts.floor + counts.foundation > 0) {
    parts.push(`${counts.floor + counts.foundation} floor`);
  }
  if (counts.porch > 0) {
    parts.push(`${counts.porch} porch`);
  }
  if (counts.door > 0) {
    parts.push(`${counts.door} door`);
  }
  if (counts.light > 0) {
    parts.push(`${counts.light} torch`);
  }
  return parts.length > 0 ? parts.join(", ") : "0";
}

export function summarizeBlueprint(plan: HousePlan): string {
  return (
    `${HOUSE_STYLE_LABEL}: ${HOUSE_SIZE}×${HOUSE_SIZE} room, ${WALL_HEIGHT}-high walls, ` +
    `peaked roof, porch on ${plan.doorSide}, windows, door, interior torch`
  );
}

export function materialNeeds(jobs: PlaceJob[]): Map<string, number> {
  const needs = new Map<string, number>();
  for (const job of jobs) {
    const add = job.part === "door" ? 1 : 1;
    needs.set(job.material, (needs.get(job.material) ?? 0) + add);
  }
  return needs;
}

export function isDoorwayBlocked(bot: Bot, plan: HousePlan): boolean {
  for (const y of [plan.floorY + 1, plan.floorY + 2]) {
    const block = bot.blockAt(new Vec3(plan.doorX, y, plan.doorZ));
    if (block && !block.name.endsWith("_door") && block.boundingBox !== "empty") {
      return true;
    }
  }
  return false;
}

export function shouldSkipExistingBlock(bot: Bot, plan: HousePlan, pos: Vec3): boolean {
  const block = bot.blockAt(pos);
  if (!block) {
    return true;
  }
  if (isSignBlockName(block.name)) {
    return true;
  }
  if (posKey(block.position) === posKey(plan.signPos)) {
    return true;
  }
  if (block.name !== "air" && !block.name.includes("grass") && !block.name.includes("flower")) {
    const replaceable =
      block.name.includes("grass") ||
      block.name === "tall_grass" ||
      block.name === "fern" ||
      block.name === "dead_bush" ||
      block.name === "snow" ||
      block.name === "vine";
    if (!replaceable && block.boundingBox !== "empty") {
      return true;
    }
  }
  return false;
}

export function collectPlaceJobs(
  bot: Bot,
  plan: HousePlan,
  structureMaterial: string,
  foundationMaterial: string | null,
  windowMaterial: string,
  doorMaterial: string
): PlaceJob[] {
  const jobs = collectBlueprintJobs(
    plan,
    structureMaterial,
    foundationMaterial,
    windowMaterial,
    doorMaterial
  );
  return sortPlaceJobs(
    bot,
    jobs.filter((job) => !shouldSkipExistingBlock(bot, plan, job.pos))
  );
}

export function findMissingFromBlueprint(
  bot: Bot,
  plan: HousePlan,
  structureMaterial: string,
  foundationMaterial: string | null,
  windowMaterial: string,
  doorMaterial: string
): PlaceJob[] {
  return sortPlaceJobs(
    bot,
    collectBlueprintJobs(plan, structureMaterial, foundationMaterial, windowMaterial, doorMaterial).filter(
      (job) => jobStillOpen(bot, job)
    )
  );
}
