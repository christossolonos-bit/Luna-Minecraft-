import { Bot } from "mineflayer";
import { Block } from "prismarine-block";
import { goals, Movements } from "mineflayer-pathfinder";
import { Vec3 } from "vec3";
import { abortActiveMining, configureGatherMovements, digBlockInReach, mineBlockReliably } from "./bot-gather";
import { equipToolCategory } from "./bot-inventory";
import { isBedBlock, isSleepRoutineActive } from "./bot-sleep";

const MAX_DIG_REACH = 4.5;
const SCAN_ORE_EXTRA = 2;

export type StripMineResult = {
  ok: boolean;
  reason?: string;
  mined?: number;
  floorY?: number;
  headY?: number;
  detail?: "ores_found" | "stopped" | "running";
};

export type OreVein = {
  pos: Vec3;
  name: string;
};

export type StripMineSession = {
  floorY: number;
  headY: number;
  forward: Vec3;
  center: Vec3;
  radius: number;
};

let activeSession: StripMineSession | null = null;
let pendingOres: OreVein[] = [];
let stripMineCancelled = false;
let stripMineRunning = false;

export function getStripMineSession(): StripMineSession | null {
  return activeSession;
}

export function clearStripMineSession(): void {
  activeSession = null;
  pendingOres = [];
}

export function isStripMiningActive(): boolean {
  return stripMineRunning;
}

export function hasPendingOres(): boolean {
  return pendingOres.length > 0;
}

export function getPendingOreSummary(): string {
  if (pendingOres.length === 0) {
    return "";
  }
  const counts = new Map<string, number>();
  for (const ore of pendingOres) {
    const label = ore.name.replace(/_/g, " ");
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const parts = [...counts.entries()].map(([name, n]) => (n > 1 ? `${n} ${name}` : name));
  return parts.join(", ");
}

export function requestStopStripMining(): boolean {
  if (!stripMineRunning) {
    return false;
  }
  stripMineCancelled = true;
  return true;
}

function posKey(pos: Vec3): string {
  return `${pos.x},${pos.y},${pos.z}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function blockCenter(pos: Vec3): Vec3 {
  return pos.offset(0.5, 0.5, 0.5);
}

export function isOreBlockName(name: string): boolean {
  return name.endsWith("_ore") || name === "ancient_debris";
}

function isOreBlock(block: Block | null): block is Block {
  return block != null && isOreBlockName(block.name);
}

function isStripMineable(block: Block | null, skipOres: boolean): boolean {
  if (!block || block.name === "air") {
    return false;
  }
  if (skipOres && isOreBlock(block)) {
    return false;
  }
  if (block.name === "bedrock" || block.name === "water" || block.name === "lava") {
    return false;
  }
  if (isBedBlock(block)) {
    return false;
  }
  if (block.name === "chest" || block.name === "trapped_chest") {
    return false;
  }
  if (block.boundingBox === "empty") {
    return false;
  }
  return block.diggable !== false;
}

function addPendingOre(pos: Vec3, name: string): void {
  const key = posKey(pos);
  if (pendingOres.some((o) => posKey(o.pos) === key)) {
    return;
  }
  pendingOres.push({ pos: pos.clone(), name });
}

function removePendingOre(pos: Vec3): void {
  const key = posKey(pos);
  pendingOres = pendingOres.filter((o) => posKey(o.pos) !== key);
}

/** Snap facing to N/S/E/W for tidy strip-mine tunnels. */
export function cardinalForward(bot: Bot): Vec3 {
  const yaw = bot.entity.yaw;
  const sx = -Math.sin(yaw);
  const sz = -Math.cos(yaw);
  if (Math.abs(sx) > Math.abs(sz)) {
    return new Vec3(sx > 0 ? 1 : -1, 0, 0);
  }
  return new Vec3(0, 0, sz > 0 ? 1 : -1);
}

/** Tunnel floor + head height from where Luna is standing when you start. */
export function tunnelLevelsFromBot(bot: Bot): { floorY: number; headY: number } {
  const floorY = Math.floor(bot.entity.position.y);
  return { floorY, headY: floorY + 1 };
}

function isStandingColumn(pos: Vec3, feet: Vec3, floorY: number, headY: number): boolean {
  return pos.x === feet.x && pos.z === feet.z && (pos.y === floorY || pos.y === headY);
}

function stationPositions(
  center: Vec3,
  floorY: number,
  headY: number,
  radius: number,
  feet: Vec3
): Vec3[] {
  const base = center.floored();
  const positions: Vec3[] = [];
  const seen = new Set<string>();

  for (const y of [floorY, headY]) {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        const pos = new Vec3(base.x + dx, y, base.z + dz);
        if (isStandingColumn(pos, feet, floorY, headY)) {
          continue;
        }
        const key = posKey(pos);
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        positions.push(pos);
      }
    }
  }

  return positions;
}

/** Scan tunnel and nearby walls for ore — strip miners leave these for the owner. */
function scanOresNearStation(
  bot: Bot,
  center: Vec3,
  session: StripMineSession
): OreVein[] {
  const found: OreVein[] = [];
  const seen = new Set<string>();
  const base = center.floored();
  const extra = SCAN_ORE_EXTRA;

  for (let y = session.floorY - 1; y <= session.headY + 1; y++) {
    for (let dx = -session.radius - extra; dx <= session.radius + extra; dx++) {
      for (let dz = -session.radius - extra; dz <= session.radius + extra; dz++) {
        const pos = new Vec3(base.x + dx, y, base.z + dz);
        const key = posKey(pos);
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        const block = bot.blockAt(pos);
        if (!isOreBlock(block)) {
          continue;
        }
        found.push({ pos: pos.clone(), name: block.name });
        addPendingOre(pos, block.name);
      }
    }
  }

  return found;
}

async function pathToStand(bot: Bot, pos: Vec3, timeoutMs: number): Promise<boolean> {
  const movements = new Movements(bot);
  movements.canDig = false;
  movements.allowSprinting = true;
  bot.pathfinder.setMovements(movements);
  bot.pathfinder.setGoal(new goals.GoalNear(pos.x, pos.y, pos.z, 0.6));

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        bot.pathfinder.setGoal(null);
        reject(new Error("path timed out"));
      }, timeoutMs);
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

function shouldAbort(): boolean {
  return stripMineCancelled || isSleepRoutineActive();
}

async function digStripTarget(
  bot: Bot,
  pos: Vec3,
  deadline: number,
  skipOres: boolean
): Promise<"mined" | "skipped" | "ore" | "abort"> {
  const block = bot.blockAt(pos);
  if (isOreBlock(block)) {
    addPendingOre(pos, block.name);
    return "ore";
  }
  if (!isStripMineable(block, skipOres)) {
    return "skipped";
  }

  if (Date.now() >= deadline || shouldAbort()) {
    return "abort";
  }

  const dist = bot.entity.position.distanceTo(blockCenter(pos));
  try {
    if (dist > MAX_DIG_REACH) {
      await mineBlockReliably(bot, block!, {
        tool: "pickaxe",
        pathTimeoutMs: Math.min(12_000, deadline - Date.now())
      });
    } else {
      await equipToolCategory(bot, "pickaxe");
      await digBlockInReach(bot, block!, { tool: "pickaxe" });
    }
    return "mined";
  } catch {
    return "skipped";
  }
}

async function clearStation(
  bot: Bot,
  center: Vec3,
  session: StripMineSession,
  deadline: number,
  skipOres: boolean
): Promise<number> {
  const feet = bot.entity.position.floored();
  const targets = stationPositions(center, session.floorY, session.headY, session.radius, feet);
  targets.sort(
    (a, b) =>
      bot.entity.position.distanceTo(blockCenter(a)) -
      bot.entity.position.distanceTo(blockCenter(b))
  );

  let mined = 0;
  for (const pos of targets) {
    if (Date.now() >= deadline || shouldAbort()) {
      break;
    }
    const result = await digStripTarget(bot, pos, deadline, skipOres);
    if (result === "mined") {
      mined += 1;
    }
    if (result === "abort") {
      break;
    }
  }
  return mined;
}

function oreFoundMessage(): string {
  const summary = getPendingOreSummary();
  return `Found ${summary} nearby — say mine ores when you want me to collect them, then I'll keep strip mining.`;
}

/**
 * Strip mine at the Y level where Luna is standing.
 * Continuous mode runs until ores are found, you say stop, or sleep.
 */
export async function stripMineFromHere(
  bot: Bot,
  options: {
    segments?: number;
    radius?: number;
    deadline?: number;
    resume?: boolean;
    continuous?: boolean;
  } = {}
): Promise<StripMineResult> {
  if (isSleepRoutineActive()) {
    return { ok: false, reason: "paused — owner is sleeping" };
  }

  if (!bot.entity) {
    return { ok: false, reason: "not in world" };
  }

  const continuous = options.continuous ?? true;
  const segments = Math.max(1, Math.min(options.segments ?? 6, 32));
  const radius = Math.max(1, Math.min(options.radius ?? 1, 2));
  const deadline = options.deadline ?? Date.now() + 3_600_000;

  let session: StripMineSession;
  if (options.resume && activeSession) {
    session = activeSession;
  } else {
    const levels = tunnelLevelsFromBot(bot);
    session = {
      floorY: levels.floorY,
      headY: levels.headY,
      forward: cardinalForward(bot),
      center: bot.entity.position.floored(),
      radius
    };
    activeSession = session;
    pendingOres = [];
  }

  abortActiveMining(bot);
  configureGatherMovements(bot);
  stripMineCancelled = false;
  stripMineRunning = true;

  if (!(await equipToolCategory(bot, "pickaxe"))) {
    stripMineRunning = false;
    return { ok: false, reason: "Need a pickaxe — say take pickaxe." };
  }

  let totalMined = 0;
  let center = session.center.clone();
  let seg = 0;

  console.log(
    `[strip-mine] Y ${session.floorY}–${session.headY}, forward (${session.forward.x},${session.forward.z}), ` +
      `${continuous ? "continuous" : `${segments} segment(s)`}`
  );

  try {
    while (true) {
      if (shouldAbort()) {
        if (stripMineCancelled) {
          return {
            ok: true,
            detail: "stopped",
            mined: totalMined,
            floorY: session.floorY,
            headY: session.headY,
            reason: `Stopped strip mining at Y ${session.floorY}–${session.headY} (${totalMined} block(s) cleared).`
          };
        }
        break;
      }

      scanOresNearStation(bot, center, session);
      if (pendingOres.length > 0) {
        session.center = center.clone();
        activeSession = session;
        return {
          ok: true,
          detail: "ores_found",
          mined: totalMined,
          floorY: session.floorY,
          headY: session.headY,
          reason: oreFoundMessage()
        };
      }

      const mined = await clearStation(bot, center, session, deadline, true);
      totalMined += mined;
      seg += 1;
      console.log(`[strip-mine] segment ${seg} — cleared ${mined} block(s)`);

      if (shouldAbort()) {
        if (stripMineCancelled) {
          return {
            ok: true,
            detail: "stopped",
            mined: totalMined,
            floorY: session.floorY,
            headY: session.headY,
            reason: `Stopped strip mining at Y ${session.floorY}–${session.headY} (${totalMined} block(s) cleared).`
          };
        }
        break;
      }

      scanOresNearStation(bot, center, session);
      if (pendingOres.length > 0) {
        session.center = center.clone();
        activeSession = session;
        return {
          ok: true,
          detail: "ores_found",
          mined: totalMined,
          floorY: session.floorY,
          headY: session.headY,
          reason: oreFoundMessage()
        };
      }

      if (!continuous && seg >= segments) {
        break;
      }

      const next = center.plus(session.forward);
      const stand = new Vec3(next.x + 0.5, session.floorY, next.z + 0.5);
      await pathToStand(bot, stand, Math.min(8000, deadline - Date.now()));
      await delay(150);
      center = next;
      session.center = center.clone();
      activeSession = session;
    }
  } finally {
    stripMineRunning = false;
    if (stripMineCancelled) {
      stripMineCancelled = false;
    }
  }

  if (totalMined === 0 && !continuous) {
    return {
      ok: false,
      reason: `Nothing to mine at Y ${session.floorY}–${session.headY} — already clear or out of reach.`,
      mined: 0,
      floorY: session.floorY,
      headY: session.headY
    };
  }

  return {
    ok: true,
    mined: totalMined,
    floorY: session.floorY,
    headY: session.headY,
    reason: `Strip mined ${totalMined} block(s) at Y ${session.floorY}–${session.headY}.`
  };
}

/** Mine ore blocks Luna marked during strip mining. */
export async function minePendingOres(
  bot: Bot,
  deadline = Date.now() + 300_000
): Promise<StripMineResult> {
  if (!activeSession) {
    return { ok: false, reason: "No strip mine session — say strip mine first." };
  }
  if (pendingOres.length === 0) {
    return { ok: false, reason: "No ores marked — keep strip mining until I find some." };
  }

  abortActiveMining(bot);
  configureGatherMovements(bot);

  if (!(await equipToolCategory(bot, "pickaxe"))) {
    return { ok: false, reason: "Need a pickaxe — say take pickaxe." };
  }

  const targets = [...pendingOres];
  let mined = 0;

  for (const ore of targets) {
    if (Date.now() >= deadline || shouldAbort()) {
      break;
    }
    const block = bot.blockAt(ore.pos);
    if (!isOreBlock(block)) {
      removePendingOre(ore.pos);
      continue;
    }
    try {
      await mineBlockReliably(bot, block, {
        tool: "pickaxe",
        pathTimeoutMs: Math.min(15_000, deadline - Date.now())
      });
      mined += 1;
      removePendingOre(ore.pos);
      console.log(`[strip-mine] mined ore ${block.name} at (${ore.pos.x},${ore.pos.y},${ore.pos.z})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[strip-mine] ore dig failed: ${msg}`);
    }
  }

  if (mined === 0) {
    return { ok: false, reason: "Could not reach the ores — move closer or clear the path." };
  }

  return {
    ok: true,
    mined,
    floorY: activeSession.floorY,
    headY: activeSession.headY,
    reason: `Mined ${mined} ore block(s).`
  };
}
