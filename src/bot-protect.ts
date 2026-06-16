import { Bot } from "mineflayer";
import { Block } from "prismarine-block";
import { Movements } from "mineflayer-pathfinder";
import { Vec3 } from "vec3";
import { isBedBlock, isBedBlockName } from "./bot-sleep";

/** Blocks Luna must never break (storage, crafting, beds, etc.). */
export const PROTECTED_BREAK_NAMES = new Set([
  "chest",
  "trapped_chest",
  "barrel",
  "ender_chest",
  "shulker_box",
  "crafting_table",
  "furnace",
  "blast_furnace",
  "smoker",
  "anvil",
  "chipped_anvil",
  "damaged_anvil",
  "enchanting_table",
  "brewing_stand",
  "smithing_table",
  "grindstone",
  "stonecutter",
  "loom",
  "cartography_table",
  "fletching_table",
  "lectern",
  "composter",
  "cauldron",
  "water_cauldron",
  "lava_cauldron",
  "powder_snow_cauldron"
]);

export function isChestBlockName(name: string): boolean {
  return name === "chest" || name === "trapped_chest" || name === "barrel" || name === "ender_chest";
}

export function isProtectedFromBreaking(block: Block | null | undefined): boolean {
  if (!block || block.name === "air") {
    return false;
  }
  if (isBedBlock(block) || isBedBlockName(block.name)) {
    return true;
  }
  if (PROTECTED_BREAK_NAMES.has(block.name)) {
    return true;
  }
  if (block.name.endsWith("_shulker_box")) {
    return true;
  }
  return false;
}

export function safeToBreak(block: Block | null | undefined): block is Block {
  return !!block && block.name !== "air" && !isProtectedFromBreaking(block);
}

/** Ray-step along look direction to find the first solid block in front of Luna. */
export function blockInFrontOfBot(bot: Bot, maxReach = 5): Block | null {
  if (!bot.entity) {
    return null;
  }
  const eye = bot.entity.position.offset(0, 1.62, 0);
  const yaw = bot.entity.yaw;
  const pitch = bot.entity.pitch;
  const dx = -Math.sin(yaw) * Math.cos(pitch);
  const dy = -Math.sin(pitch);
  const dz = -Math.cos(yaw) * Math.cos(pitch);
  const seen = new Set<string>();

  for (let t = 0.35; t <= maxReach; t += 0.3) {
    const point = eye.plus(new Vec3(dx * t, dy * t, dz * t));
    const pos = point.floored();
    const key = `${pos.x},${pos.y},${pos.z}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const block = bot.blockAt(pos);
    if (!block || block.name === "air" || block.boundingBox === "empty") {
      continue;
    }
    return block;
  }
  return null;
}

export function logProtectedSkip(block: Block, context: string): void {
  const label = block.name.replace(/_/g, " ");
  console.log(
    `[protect] will not break ${label} at (${block.position.x},${block.position.y},${block.position.z}) — ${context}`
  );
}

/** Register protected blocks on pathfinder movements (same pattern as beds). */
export function addProtectedBlocksToMovements(bot: Bot, movements: Movements): void {
  for (const name of PROTECTED_BREAK_NAMES) {
    const id = bot.registry.blocksByName[name]?.id;
    if (id != null) {
      movements.blocksCantBreak.add(id);
    }
  }
  for (const name of Object.keys(bot.registry.blocksByName)) {
    if (isBedBlockName(name) || name.endsWith("_shulker_box")) {
      const id = bot.registry.blocksByName[name]?.id;
      if (id != null) {
        movements.blocksCantBreak.add(id);
      }
    }
  }
}

/** Refuse dig and log if this block must be preserved. */
export function refuseProtectedDig(block: Block, context: string): boolean {
  if (!isProtectedFromBreaking(block)) {
    return false;
  }
  logProtectedSkip(block, context);
  return true;
}
