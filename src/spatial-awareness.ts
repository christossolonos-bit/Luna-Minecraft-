import { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { NearbyStructure } from "./types";

export type StructureDirection = NearbyStructure["direction"];

const WORKSTATION_BLOCKS = new Set([
  "crafting_table",
  "furnace",
  "chest",
  "trapped_chest",
  "bed",
  "anvil",
  "smithing_table",
  "grindstone"
]);

export function yawToCompassLabel(yaw: number): string {
  const deg = ((yaw * (180 / Math.PI)) % 360 + 360) % 360;
  if (deg >= 315 || deg < 45) return "south";
  if (deg >= 45 && deg < 135) return "west";
  if (deg >= 135 && deg < 225) return "north";
  return "east";
}

/** Horizontal direction from Luna's view to a world position. */
export function directionFromBot(bot: Bot, target: Vec3): StructureDirection {
  if (!bot.entity) {
    return "nearby";
  }
  const pos = bot.entity.position;
  const dx = target.x + 0.5 - pos.x;
  const dy = target.y + 0.5 - pos.y;
  const dz = target.z + 0.5 - pos.z;
  const hLen = Math.hypot(dx, dz);
  if (hLen < 0.6 && Math.abs(dy) < 2) {
    return "here";
  }
  if (Math.abs(dy) > 1.5 && hLen < 2) {
    return dy > 0 ? "above" : "below";
  }

  const yaw = bot.entity.yaw;
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  const rx = -Math.cos(yaw);
  const rz = Math.sin(yaw);

  const ndx = dx / (hLen || 1);
  const ndz = dz / (hLen || 1);
  const forwardDot = ndx * fx + ndz * fz;
  const rightDot = ndx * rx + ndz * rz;

  if (forwardDot > 0.45) return "ahead";
  if (forwardDot < -0.45) return "behind";
  if (rightDot > 0.45) return "right";
  if (rightDot < -0.45) return "left";
  return "nearby";
}

export function scanNearbyStructures(bot: Bot, maxDistance = 12): NearbyStructure[] {
  if (!bot.entity) {
    return [];
  }
  const pos = bot.entity.position;
  const positions = bot.findBlocks({
    point: pos,
    matching: (b) => WORKSTATION_BLOCKS.has(b.name),
    maxDistance,
    count: 24
  });

  const seen = new Map<string, NearbyStructure>();
  for (const blockPos of positions) {
    const block = bot.blockAt(blockPos);
    if (!block) {
      continue;
    }
    const dist = pos.distanceTo(blockPos.offset(0.5, 0.5, 0.5));
    const dir = directionFromBot(bot, blockPos);
    const key = `${block.name}:${dir}`;
    const prev = seen.get(key);
    if (!prev || dist < prev.distance) {
      seen.set(key, { kind: block.name, distance: dist, direction: dir });
    }
  }

  return [...seen.values()].sort((a, b) => a.distance - b.distance);
}

export function formatStructuresForContext(structures: NearbyStructure[]): string {
  if (structures.length === 0) {
    return "Workstations in 12m: none detected.";
  }
  const parts = structures.map(
    (s) => `${s.kind.replace(/_/g, " ")} ${s.direction} ${s.distance.toFixed(1)}m`
  );
  return `Workstations in 12m: ${parts.join("; ")}.`;
}

export function hasStructureKind(structures: NearbyStructure[] | undefined, kind: string): boolean {
  return Boolean(structures?.some((s) => s.kind === kind));
}

export function findStructure(
  structures: NearbyStructure[] | undefined,
  kind: string,
  preferDirection?: string
): NearbyStructure | undefined {
  if (!structures?.length) {
    return undefined;
  }
  const matches = structures.filter((s) => s.kind === kind);
  if (!matches.length) {
    return undefined;
  }
  if (preferDirection) {
    const d = preferDirection as StructureDirection;
    const exact = matches.find((s) => s.direction === d);
    if (exact) {
      return exact;
    }
  }
  return matches.sort((a, b) => a.distance - b.distance)[0];
}
