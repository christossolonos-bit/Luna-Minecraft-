import { HOUSE_MATERIAL_NAMES } from "./house-blueprint";
import { InventorySlot } from "./types";

export type ResumableTask =
  | "build_house"
  | "gather_wood"
  | "collect_wheat"
  | "plant_wheat";

const BUILD_BLOCKS = [
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
  "warped_planks",
  "cobblestone",
  "stone_bricks"
];

const LOG_ITEMS = /_log$|_stem$|^crimson_stem$|^warped_stem$|^mushroom_stem$/;

export type PendingResume = {
  task: ResumableTask;
  reason: string;
  markedAt: number;
};

let pending: PendingResume | null = null;

export function markTaskIncomplete(task: ResumableTask, reason: string): void {
  pending = { task, reason, markedAt: Date.now() };
  console.log(`[resume] paused ${task} — will continue when supplies arrive`);
}

export function clearPendingResume(): void {
  pending = null;
}

export function getPendingResume(): PendingResume | null {
  return pending;
}

export function hasPendingResume(): boolean {
  return pending !== null;
}

export function inventoryTotals(items: InventorySlot[] | undefined): Map<string, number> {
  const map = new Map<string, number>();
  for (const item of items ?? []) {
    map.set(item.name, (map.get(item.name) ?? 0) + item.count);
  }
  return map;
}

export function inventoryGained(
  before: Map<string, number>,
  after: Map<string, number>
): Map<string, number> {
  const gained = new Map<string, number>();
  for (const [name, count] of after) {
    const delta = count - (before.get(name) ?? 0);
    if (delta > 0) {
      gained.set(name, delta);
    }
  }
  return gained;
}

export function suppliesForPendingTask(gained: Map<string, number>, task: ResumableTask): boolean {
  if (gained.size === 0) {
    return false;
  }
  switch (task) {
    case "build_house":
      return (
        BUILD_BLOCKS.some((name) => (gained.get(name) ?? 0) > 0) ||
        HOUSE_MATERIAL_NAMES.some((name) => (gained.get(name) ?? 0) > 0) ||
        [...gained.keys()].some((name) => name.endsWith("_sign") && !name.includes("hanging"))
      );
    case "gather_wood":
      return [...gained.keys()].some((name) => LOG_ITEMS.test(name));
    case "collect_wheat":
      return (gained.get("wheat") ?? 0) > 0;
    case "plant_wheat":
      return (gained.get("wheat_seeds") ?? 0) > 0;
    default:
      return false;
  }
}

export function resumeSay(task: ResumableTask): string {
  switch (task) {
    case "build_house":
      return "Got supplies — continuing the house.";
    case "gather_wood":
      return "Picked up logs — back to the tree.";
    case "collect_wheat":
      return "Got wheat — continuing harvest.";
    case "plant_wheat":
      return "Got seeds — continuing to plant.";
    default:
      return "Got supplies — continuing my task.";
  }
}
