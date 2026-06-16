import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Bot } from "mineflayer";
import { Vec3 } from "vec3";

export type TreeChopAction =
  | "break_log"
  | "walk_to_break"
  | "break_log_above"
  | "pillar_place"
  | "look_up_break"
  | "pillar_mount"
  | "place_then_mount"
  | "empty_jump";

const ACTION_LABELS: Record<TreeChopAction, string> = {
  break_log: "broke a log",
  walk_to_break: "walked to broken log",
  break_log_above: "broke log above her",
  pillar_place: "placed log under her",
  look_up_break: "looked up and broke log above",
  pillar_mount: "jumped onto a block",
  place_then_mount: "placed log then mounted it",
  empty_jump: "jumped without placing or gaining height"
};

const ALL_ACTIONS: TreeChopAction[] = [
  "break_log",
  "walk_to_break",
  "break_log_above",
  "pillar_place",
  "look_up_break",
  "pillar_mount",
  "place_then_mount",
  "empty_jump"
];

export type ClimbTimings = {
  /** How long to hold jump before placing a log underfoot. */
  placeJumpMs: number;
  /** Pause after placing before trying to mount the new block. */
  placeSettleMs: number;
  /** How long to hold jump when mounting a block. */
  mountJumpMs: number;
  /** Pause after jump release before checking if she landed on the block. */
  mountLandMs: number;
};

const DEFAULT_TIMINGS: ClimbTimings = {
  placeJumpMs: Number(process.env.MC_TREE_RL_PLACE_JUMP_MS ?? "120") || 120,
  placeSettleMs: Number(process.env.MC_TREE_RL_PLACE_SETTLE_MS ?? "150") || 150,
  mountJumpMs: Number(process.env.MC_TREE_RL_MOUNT_JUMP_MS ?? "220") || 220,
  mountLandMs: Number(process.env.MC_TREE_RL_MOUNT_LAND_MS ?? "280") || 280
};

type ActionStats = {
  count: number;
  /** Exponential moving average — learns which moves pay off. */
  q: number;
};

type TreeRlFile = {
  version: 1;
  totalPoints: number;
  sessions: number;
  actions: Record<TreeChopAction, ActionStats>;
  climbTimings?: ClimbTimings;
};

const DEFAULT_FILE = "data/tree_chop_rl.json";
const MAX_RECENT = 32;

function memoryPath(): string {
  return process.env.MC_TREE_RL_FILE ?? DEFAULT_FILE;
}

function defaultActions(): Record<TreeChopAction, ActionStats> {
  const out = {} as Record<TreeChopAction, ActionStats>;
  for (const a of ALL_ACTIONS) {
    out[a] = { count: 0, q: 0 };
  }
  return out;
}

function mergeTimings(raw?: Partial<ClimbTimings>): ClimbTimings {
  return {
    placeJumpMs: raw?.placeJumpMs ?? DEFAULT_TIMINGS.placeJumpMs,
    placeSettleMs: raw?.placeSettleMs ?? DEFAULT_TIMINGS.placeSettleMs,
    mountJumpMs: raw?.mountJumpMs ?? DEFAULT_TIMINGS.mountJumpMs,
    mountLandMs: raw?.mountLandMs ?? DEFAULT_TIMINGS.mountLandMs
  };
}

function loadMemory(): TreeRlFile {
  try {
    const raw = readFileSync(memoryPath(), "utf-8");
    const parsed = JSON.parse(raw) as TreeRlFile;
    if (parsed?.version === 1 && parsed.actions) {
      for (const a of ALL_ACTIONS) {
        if (!parsed.actions[a]) {
          parsed.actions[a] = { count: 0, q: 0 };
        }
      }
      parsed.climbTimings = mergeTimings(parsed.climbTimings);
      return parsed;
    }
  } catch {
    // no file
  }
  return {
    version: 1,
    totalPoints: 0,
    sessions: 0,
    actions: defaultActions(),
    climbTimings: { ...DEFAULT_TIMINGS }
  };
}

function saveMemory(mem: TreeRlFile): void {
  try {
    mkdirSync(dirname(memoryPath()), { recursive: true });
    writeFileSync(memoryPath(), JSON.stringify(mem, null, 2), "utf-8");
  } catch {
    // best effort
  }
}

function posKey(pos: Vec3): string {
  return `${pos.x},${pos.y},${pos.z}`;
}

function rewardLabel(reward: number): string {
  return reward >= 0 ? `+${reward}` : `${reward}`;
}

/** Persistent tree-chop reinforcement — rewards good moves, penalizes empty jumps. */
export class TreeChopRL {
  private mem: TreeRlFile;
  private recent: { action: TreeChopAction; at: number; reward: number; detail?: string }[] = [];

  constructor() {
    this.mem = loadMemory();
    if (!this.mem.climbTimings) {
      this.mem.climbTimings = { ...DEFAULT_TIMINGS };
    }
  }

  get enabled(): boolean {
    return process.env.MC_TREE_RL !== "false";
  }

  get totalPoints(): number {
    return this.mem.totalPoints;
  }

  getTimings(): ClimbTimings {
    return { ...(this.mem.climbTimings ?? DEFAULT_TIMINGS) };
  }

  /** Nudge jump/place delays toward what worked, or away from failed attempts. */
  adaptTiming(kind: "place" | "mount", success: boolean, used?: ClimbTimings): void {
    if (!this.enabled) {
      return;
    }

    const t = (this.mem.climbTimings ??= { ...DEFAULT_TIMINGS });
    const alpha = Number(process.env.MC_TREE_RL_TIMING_RATE ?? "0.12") || 0.12;

    if (success && used) {
      if (kind === "place") {
        t.placeJumpMs = Math.round(t.placeJumpMs * (1 - alpha) + used.placeJumpMs * alpha);
        t.placeSettleMs = Math.round(t.placeSettleMs * (1 - alpha) + used.placeSettleMs * alpha);
      } else {
        t.mountJumpMs = Math.round(t.mountJumpMs * (1 - alpha) + used.mountJumpMs * alpha);
        t.mountLandMs = Math.round(t.mountLandMs * (1 - alpha) + used.mountLandMs * alpha);
      }
    } else if (!success) {
      if (kind === "place") {
        t.placeJumpMs = Math.min(280, t.placeJumpMs + 18);
        t.placeSettleMs = Math.min(350, t.placeSettleMs + 12);
      } else {
        t.mountJumpMs = Math.min(240, t.mountJumpMs + 12);
        t.mountLandMs = Math.min(320, t.mountLandMs + 16);
        t.placeJumpMs = Math.min(200, t.placeJumpMs + 10);
      }
      console.log(
        `[tree-rl] timing adjust (${kind} fail): ` +
          `placeJump=${t.placeJumpMs}ms placeSettle=${t.placeSettleMs}ms ` +
          `mountJump=${t.mountJumpMs}ms mountLand=${t.mountLandMs}ms`
      );
    }

    saveMemory(this.mem);
  }

  record(action: TreeChopAction, detail?: string, reward = 1): number {
    if (!this.enabled) {
      return 0;
    }

    const alpha = Number(process.env.MC_TREE_RL_LEARNING_RATE ?? "0.2") || 0.2;
    const stats = this.mem.actions[action] ?? { count: 0, q: 0 };
    stats.count += 1;
    stats.q = stats.q * (1 - alpha) + reward * alpha;
    this.mem.actions[action] = stats;
    this.mem.totalPoints += reward;

    this.recent.push({ action, at: Date.now(), reward, detail });
    while (this.recent.length > MAX_RECENT) {
      this.recent.shift();
    }

    saveMemory(this.mem);
    console.log(
      `[tree-rl] ${rewardLabel(reward)} ${action} (${ACTION_LABELS[action]})` +
        `${detail ? ` @ ${detail}` : ""} — total ${this.mem.totalPoints} pts`
    );
    return reward;
  }

  startSession(): TreeChopSession {
    const t = (this.mem.climbTimings ??= { ...DEFAULT_TIMINGS });
    if (t.mountJumpMs > 260 || t.mountLandMs > 360) {
      t.mountJumpMs = DEFAULT_TIMINGS.mountJumpMs;
      t.mountLandMs = DEFAULT_TIMINGS.mountLandMs;
      t.placeJumpMs = DEFAULT_TIMINGS.placeJumpMs;
      t.placeSettleMs = DEFAULT_TIMINGS.placeSettleMs;
      saveMemory(this.mem);
      console.log("[tree-rl] reset climb timings (were too slow from failed jumps)");
    }
    return new TreeChopSession(this);
  }

  finishSession(session: TreeChopSession): void {
    if (!this.enabled) {
      return;
    }
    this.mem.sessions += 1;
    saveMemory(this.mem);
    const t = this.getTimings();
    console.log(
      `[tree-rl] session done: ${rewardLabel(session.points)} (${session.summary()}) | ` +
        `career ${this.mem.totalPoints} pts | ` +
        `timings place ${t.placeJumpMs}/${t.placeSettleMs}ms mount ${t.mountJumpMs}/${t.mountLandMs}ms`
    );
  }

  summaryForPrompt(): string {
    if (!this.enabled || this.mem.totalPoints === 0) {
      return "";
    }
    const top = ALL_ACTIONS.map((a) => ({ a, s: this.mem.actions[a] }))
      .filter(({ s }) => s.count > 0)
      .sort((x, y) => y.s.q - x.s.q)
      .slice(0, 4)
      .map(({ a, s }) => `${a}×${s.count}`)
      .join(", ");
    const t = this.getTimings();
    return (
      `Tree-chop RL: ${this.mem.totalPoints} pts. Best moves: ${top}. ` +
      `Climb timing: place ${t.placeJumpMs}ms jump + ${t.placeSettleMs}ms settle, ` +
      `mount ${t.mountJumpMs}ms jump + ${t.mountLandMs}ms land.`
    );
  }
}

/** Per gather-wood run — tracks look-up state, walk-to-break targets, and climb timing. */
export class TreeChopSession {
  private lookedUp = false;
  private walkTargets = new Map<string, Vec3>();
  private walkedRewarded = new Set<string>();
  private lastPlacedPillar: string | null = null;
  points = 0;

  constructor(private readonly rl: TreeChopRL) {}

  noteLookUp(): void {
    this.lookedUp = true;
  }

  noteBreak(bot: Bot, pos: Vec3): void {
    this.points += this.rl.record("break_log", posKey(pos));

    const feetY = bot.entity.position.floored().y;
    if (pos.y > feetY) {
      this.points += this.rl.record("break_log_above", posKey(pos));
    }
    if (this.lookedUp && pos.y >= feetY) {
      this.points += this.rl.record("look_up_break", posKey(pos));
    }
    this.lookedUp = false;

    this.walkTargets.set(posKey(pos), pos.clone());
  }

  /** Reward walking onto a spot where a log was just broken (pickup / centering). */
  noteWalkNear(bot: Bot, near: Vec3): void {
    const pos = bot.entity.position;
    for (const [key, target] of this.walkTargets) {
      if (this.walkedRewarded.has(key)) {
        continue;
      }
      const tx = target.x + 0.5;
      const tz = target.z + 0.5;
      const horizontal = Math.hypot(pos.x - tx, pos.z - tz);
      const vertical = Math.abs(pos.y - (target.y + 1));
      if (horizontal <= 1.2 && vertical <= 2) {
        this.walkedRewarded.add(key);
        this.points += this.rl.record("walk_to_break", key);
      }
    }
  }

  notePillarPlace(pos: Vec3): void {
    this.lastPlacedPillar = posKey(pos);
    this.points += this.rl.record("pillar_place", posKey(pos));
  }

  notePillarMount(pos: Vec3): void {
    this.points += this.rl.record("pillar_mount", posKey(pos));
    const key = posKey(pos);
    if (this.lastPlacedPillar === key) {
      this.points += this.rl.record("place_then_mount", key, 2);
      this.lastPlacedPillar = null;
    }
  }

  /** Jumped to place a log but nothing was placed — bad timing. */
  noteJumpNoPlace(pos: Vec3, reason: string): void {
    this.points += this.rl.record("empty_jump", `${posKey(pos)} ${reason}`, -1);
    this.rl.adaptTiming("place", false);
  }

  /** Kept jumping without landing higher — learn longer mount timing. */
  noteEmptyJumps(attempts: number, pos: Vec3): void {
    this.points += this.rl.record("empty_jump", `${attempts} jumps @ ${posKey(pos)}`, -1);
    this.rl.adaptTiming("mount", false);
  }

  summary(): string {
    return `${this.points} this tree`;
  }
}

let sharedRl: TreeChopRL | null = null;

export function getTreeChopRL(): TreeChopRL {
  if (!sharedRl) {
    sharedRl = new TreeChopRL();
  }
  return sharedRl;
}
