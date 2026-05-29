import { Bot } from "mineflayer";
import { Entity } from "prismarine-entity";
import { goals } from "mineflayer-pathfinder";
import { Vec3 as Vec3Class } from "vec3";
import { ActionResult, NearbyMob } from "./types";

const HOSTILE_MOBS = new Set([
  "zombie",
  "husk",
  "drowned",
  "skeleton",
  "stray",
  "spider",
  "cave_spider",
  "creeper",
  "enderman",
  "witch",
  "phantom",
  "slime",
  "magma_cube",
  "pillager",
  "vindicator",
  "evoker",
  "ravager",
  "zoglin",
  "hoglin",
  "piglin_brute",
  "blaze",
  "ghast",
  "wither_skeleton"
]);

const SWORD_PRIORITY = ["netherite_sword", "diamond_sword", "iron_sword", "stone_sword", "wooden_sword"];
const AXE_PRIORITY = ["netherite_axe", "diamond_axe", "iron_axe", "stone_axe", "wooden_axe"];

/** Passive livestock Luna can hunt when the owner asks. */
export const HUNTABLE_ANIMALS = new Set([
  "cow",
  "pig",
  "sheep",
  "chicken",
  "mooshroom",
  "rabbit",
  "goat"
]);

export function isHuntableAnimal(name: string): boolean {
  const n = normalizeEntityKind(name);
  return HUNTABLE_ANIMALS.has(n);
}

export function normalizeEntityKind(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/^minecraft:/, "");
}

/** Resolve mob id from mineflayer entity (name is often empty on passive mobs). */
export function entityKindName(entity: Entity): string {
  if (entity.name) {
    return normalizeEntityKind(entity.name);
  }
  const disp = entity.displayName as string | { text?: string } | undefined;
  if (typeof disp === "string" && disp.trim()) {
    return normalizeEntityKind(disp);
  }
  if (disp && typeof disp === "object" && typeof disp.text === "string") {
    return normalizeEntityKind(disp.text);
  }
  const mobType = (entity as Entity & { mobType?: string }).mobType;
  if (mobType) {
    return normalizeEntityKind(mobType);
  }
  return "";
}

export function isHostileMob(name: string): boolean {
  return HOSTILE_MOBS.has(normalizeEntityKind(name));
}

export function sampleNearbyMobs(bot: Bot, maxDistance = 40): NearbyMob[] {
  if (!bot.entity) {
    return [];
  }
  const mobs: NearbyMob[] = [];
  for (const entity of Object.values(bot.entities)) {
    if (!entity || entity === bot.entity) {
      continue;
    }
    const kind = entityKindName(entity);
    if (!kind || kind === "player" || kind === "item" || kind === "experience_orb") {
      continue;
    }
    if (entity.type === "player" || entity.type === "object") {
      continue;
    }
    const dist = bot.entity.position.distanceTo(entity.position);
    if (dist > maxDistance) {
      continue;
    }
    mobs.push({
      name: kind,
      distance: dist,
      hostile: isHostileMob(kind)
    });
  }
  return mobs.sort((a, b) => a.distance - b.distance).slice(0, 12);
}

export function findNearestHostile(bot: Bot, maxDistance = 16): Entity | null {
  return findNearestMob(bot, maxDistance, (name) => isHostileMob(name));
}

export function findNearestHuntable(
  bot: Bot,
  maxDistance = 40,
  species?: string
): Entity | null {
  const want = species ? normalizeEntityKind(species) : null;
  return findNearestMob(bot, maxDistance, (name) => {
    if (!isHuntableAnimal(name)) {
      return false;
    }
    return !want || name === want || name.startsWith(`${want}_`);
  });
}

function findNearestMob(
  bot: Bot,
  maxDistance: number,
  match: (kind: string) => boolean
): Entity | null {
  if (!bot.entity) {
    return null;
  }
  let best: Entity | null = null;
  let bestDist = maxDistance;
  for (const entity of Object.values(bot.entities)) {
    if (!entity || entity === bot.entity) {
      continue;
    }
    const kind = entityKindName(entity);
    if (!kind || !match(kind)) {
      continue;
    }
    const dist = bot.entity.position.distanceTo(entity.position);
    if (dist < bestDist) {
      bestDist = dist;
      best = entity;
    }
  }
  return best;
}

export async function equipBestMelee(bot: Bot): Promise<boolean> {
  if (await equipBestSword(bot)) {
    return true;
  }
  for (const name of AXE_PRIORITY) {
    const stack = bot.inventory.items().find((i) => i.name === name);
    if (stack) {
      await bot.equip(stack, "hand");
      return true;
    }
  }
  return false;
}

export async function huntAnimal(
  bot: Bot,
  options: { species?: string; maxDistance?: number; timeoutMs?: number; maxKills?: number } = {}
): Promise<ActionResult & { detail?: string }> {
  const maxDistance = options.maxDistance ?? 40;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const maxKills = options.maxKills ?? 1;
  const species = options.species ? normalizeEntityKind(options.species) : undefined;
  const deadline = Date.now() + timeoutMs;

  if (!(await equipBestMelee(bot))) {
    return {
      ok: false,
      action: "run_task",
      reason: "No sword or axe to hunt with."
    };
  }

  bot.pathfinder.setGoal(null);
  let kills = 0;

  while (Date.now() < deadline && kills < maxKills) {
    const target = findNearestHuntable(bot, maxDistance, species);
    if (!target) {
      break;
    }
    const kind = entityKindName(target);

    try {
      await bot.lookAt(target.position.offset(0, target.height * 0.8, 0));
      if (bot.entity.position.distanceTo(target.position) > 3.5) {
        bot.pathfinder.setGoal(null);
        await bot.pathfinder.goto(new goals.GoalFollow(target, 2));
      }
      await bot.attack(target);
      await waitForMobGone(bot, target, 12_000);
      kills += 1;
      console.log(`[hunt] killed ${kind}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[hunt] failed ${kind}: ${msg}`);
      break;
    }
  }

  bot.pathfinder.setGoal(null);

  if (kills === 0) {
    const label = species ?? "animal";
    const seen = sampleNearbyMobs(bot, maxDistance)
      .filter((m) => !m.hostile && isHuntableAnimal(m.name))
      .map((m) => `${m.name}@${m.distance.toFixed(0)}m`);
    if (seen.length) {
      return {
        ok: false,
        action: "run_task",
        reason: `Saw ${seen.join(", ")} but could not reach the ${label}.`
      };
    }
    return {
      ok: false,
      action: "run_task",
      reason: `No ${label} within ${maxDistance} blocks.`
    };
  }

  return { ok: true, action: "run_task", detail: `hunted ${kills} ${species ?? "animal"}(s)` };
}

export function hasSword(bot: Bot): boolean {
  return bot.inventory.items().some((i) => i.name.endsWith("_sword"));
}

export async function equipBestSword(bot: Bot): Promise<boolean> {
  for (const name of SWORD_PRIORITY) {
    const stack = bot.inventory.items().find((i) => i.name === name);
    if (stack) {
      await bot.equip(stack, "hand");
      return true;
    }
  }
  return false;
}

export async function fightHostiles(
  bot: Bot,
  options: { maxDistance?: number; timeoutMs?: number; maxKills?: number } = {}
): Promise<ActionResult & { detail?: string }> {
  const maxDistance = options.maxDistance ?? 16;
  const timeoutMs = options.timeoutMs ?? 45_000;
  const maxKills = options.maxKills ?? 3;
  const deadline = Date.now() + timeoutMs;

  if (!(await equipBestSword(bot))) {
    return {
      ok: false,
      action: "run_task",
      reason: "No sword — craft one first (gather wood, then craft tools)."
    };
  }

  bot.pathfinder.setGoal(null);
  let kills = 0;

  while (Date.now() < deadline && kills < maxKills) {
    const target = findNearestHostile(bot, maxDistance);
    if (!target) {
      break;
    }

    try {
      await bot.lookAt(target.position.offset(0, target.height * 0.8, 0));
      if (bot.entity.position.distanceTo(target.position) > 3.5) {
        bot.pathfinder.setGoal(null);
        await bot.pathfinder.goto(new goals.GoalFollow(target, 2));
      }
      await bot.attack(target);
      await waitForMobGone(bot, target, 8000);
      kills += 1;
    } catch {
      break;
    }
  }

  bot.pathfinder.setGoal(null);

  if (kills === 0) {
    const nearby = findNearestHostile(bot, maxDistance);
    if (!nearby) {
      return { ok: true, action: "run_task", detail: "no hostiles nearby" };
    }
    return { ok: false, action: "run_task", reason: "Could not reach or attack hostile mob." };
  }

  return { ok: true, action: "run_task", detail: `fought ${kills} mob(s)` };
}

function waitForMobGone(bot: Bot, entity: Entity, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const id = entity.id;
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, timeoutMs);

    const onGone = (gone: Entity) => {
      if (gone.id === id) {
        cleanup();
        resolve();
      }
    };

    const cleanup = () => {
      clearTimeout(timer);
      bot.removeListener("entityGone", onGone);
    };

    bot.on("entityGone", onGone);
    if (!bot.entities[id]) {
      cleanup();
      resolve();
    }
  });
}

export function ownerNearCraftingTable(bot: Bot, ownerUsername: string, maxDistance = 4): boolean {
  const owner = bot.players[ownerUsername]?.entity;
  if (!owner) {
    return false;
  }
  const table = bot.findBlock({
    matching: (b) => b.name === "crafting_table",
    maxDistance,
    point: owner.position
  });
  return Boolean(table);
}

export function readPlayerHeldItem(bot: Bot, username: string): string | undefined {
  const entity = bot.players[username]?.entity as Entity & { heldItem?: { name: string } } | undefined;
  return entity?.heldItem?.name;
}

export function ownerDistanceTo(bot: Bot, ownerUsername: string, pos: Vec3Class): number {
  const owner = bot.players[ownerUsername]?.entity;
  if (!owner) {
    return Infinity;
  }
  return owner.position.distanceTo(pos);
}
