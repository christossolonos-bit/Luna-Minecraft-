import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { CompanionAction, CompanionState, Vec3 } from "../types";

export type RelativeBlockFix = {
  dx: number;
  dy: number;
  dz: number;
  blockId: string;
};

export type StuckFixEntry = {
  id: string;
  blocks: RelativeBlockFix[];
  successes: number;
  lastUsed: number;
};

export type StuckMemoryFile = {
  version: 1;
  fixes: StuckFixEntry[];
};

const DEFAULT_FILE = "data/stuck_fixes.json";
const MAX_ENTRIES = 40;

function memoryPath(): string {
  return process.env.MC_STUCK_MEMORY_FILE ?? DEFAULT_FILE;
}

export function loadStuckMemory(file = memoryPath()): StuckFixEntry[] {
  try {
    const raw = readFileSync(file, "utf-8");
    const parsed = JSON.parse(raw) as StuckMemoryFile;
    if (parsed?.version === 1 && Array.isArray(parsed.fixes)) {
      return parsed.fixes;
    }
  } catch {
    // no file yet
  }
  return [];
}

export function saveStuckMemory(fixes: StuckFixEntry[], file = memoryPath()): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const payload: StuckMemoryFile = { version: 1, fixes: fixes.slice(0, MAX_ENTRIES) };
    writeFileSync(file, JSON.stringify(payload, null, 2), "utf-8");
  } catch {
    // best effort
  }
}

export function isStuckFailure(reason?: string): boolean {
  const r = (reason ?? "").toLowerCase();
  return (
    r.includes("pathfinding timed out") ||
    r.includes("stuck") ||
    r.includes("no path") ||
    r.includes("unreachable") ||
    r.includes("no reachable blocks") ||
    r.includes("timeout")
  );
}

export function dist(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function relBlock(stuckAt: Vec3, blockPos: Vec3, blockId: string): RelativeBlockFix {
  return {
    dx: Math.floor(blockPos.x) - Math.floor(stuckAt.x),
    dy: Math.floor(blockPos.y) - Math.floor(stuckAt.y),
    dz: Math.floor(blockPos.z) - Math.floor(stuckAt.z),
    blockId
  };
}

function fixKey(blocks: RelativeBlockFix[]): string {
  return blocks
    .map((b) => `${b.dx},${b.dy},${b.dz}:${b.blockId}`)
    .sort()
    .join("|");
}

export class StuckLearning {
  private fixes: StuckFixEntry[];
  private readonly memoryFile: string;
  private awaitingHelp = false;
  private stuckAt: Vec3 | null = null;
  private pendingBlocks: RelativeBlockFix[] = [];
  private seenBreakKeys = new Set<string>();
  private lastHelpAskAt = 0;
  private retryGoal: Vec3 | null = null;

  constructor(memoryFile?: string) {
    this.memoryFile = memoryFile ?? memoryPath();
    this.fixes = loadStuckMemory(this.memoryFile);
  }

  get fixCount(): number {
    return this.fixes.length;
  }

  get isAwaitingHelp(): boolean {
    return this.awaitingHelp;
  }

  summaryForPrompt(): string {
    if (this.fixes.length === 0) {
      return "Learned stuck fixes: none yet.";
    }
    const top = [...this.fixes].sort((a, b) => b.successes - a.successes)[0]!;
    const blocks = top.blocks.map((b) => `${b.blockId}@(${b.dx},${b.dy},${b.dz})`).join(", ");
    return `Learned stuck fixes: ${this.fixes.length} patterns. Best: break ${blocks} (${top.successes}x).`;
  }

  rememberAction(action: CompanionAction): void {
    if (action.type === "move_to") {
      this.retryGoal = action.target;
    }
  }

  planRecovery(state: CompanionState): CompanionAction[] {
    const stuck = state.player.position;
    const sorted = [...this.fixes].sort((a, b) => b.successes - a.successes);
    for (const entry of sorted.slice(0, 3)) {
      const mines: CompanionAction[] = entry.blocks.map((b) => ({
        type: "mine_block" as const,
        target: {
          x: Math.floor(stuck.x) + b.dx,
          y: Math.floor(stuck.y) + b.dy,
          z: Math.floor(stuck.z) + b.dz
        },
        blockIdHint: b.blockId
      }));
      if (mines.length > 0) {
        entry.lastUsed = Date.now();
        saveStuckMemory(this.fixes, this.memoryFile);
        return mines;
      }
    }
    return [];
  }

  enterStuck(state: CompanionState): { askHelp: string | null; tryFirst: CompanionAction[] } {
    this.stuckAt = { ...state.player.position };
    this.pendingBlocks = [];
    this.seenBreakKeys.clear();
    const tryFirst = this.planRecovery(state);
    if (tryFirst.length > 0) {
      console.log(`[learn] trying ${tryFirst.length} remembered block break(s)`);
      return { askHelp: null, tryFirst };
    }
    const now = Date.now();
    if (now - this.lastHelpAskAt < 45_000) {
      return { askHelp: null, tryFirst: [] };
    }
    this.awaitingHelp = true;
    this.lastHelpAskAt = now;
    return {
      askHelp: "I'm stuck! Can you break the block blocking me? I'll remember for next time.",
      tryFirst: []
    };
  }

  observe(state: CompanionState): { freed: boolean } {
    if (!this.awaitingHelp || !this.stuckAt) {
      return { freed: false };
    }

    const luna = state.player.position;
    for (const ev of state.recentBuildEvents) {
      if (ev.kind !== "break_block") {
        continue;
      }
      const key = `${ev.blockId}:${ev.position.x},${ev.position.y},${ev.position.z}`;
      if (this.seenBreakKeys.has(key)) {
        continue;
      }
      if (dist(ev.position, luna) > 6 && dist(ev.position, this.stuckAt) > 6) {
        continue;
      }
      this.seenBreakKeys.add(key);
      const rel = relBlock(this.stuckAt, ev.position, ev.blockId);
      this.pendingBlocks.push(rel);
      console.log(
        `[learn] saw you break ${ev.blockId} at offset (${rel.dx}, ${rel.dy}, ${rel.dz})`
      );
    }

    const moved = dist(luna, this.stuckAt) > 2.5;
    if (moved && this.pendingBlocks.length > 0) {
      this.commitFix(this.pendingBlocks);
      this.clearStuck();
      return { freed: true };
    }
    if (moved) {
      this.clearStuck();
      return { freed: true };
    }
    return { freed: false };
  }

  onOwnerSaysDone(message: string): boolean {
    const m = message.toLowerCase();
    return /\b(done|fixed|clear|ok|okay|there|freed|good)\b/.test(m);
  }

  finalizeHelp(state: CompanionState): void {
    if (!this.awaitingHelp || !this.stuckAt) {
      return;
    }
    if (this.pendingBlocks.length > 0) {
      this.commitFix(this.pendingBlocks);
    }
    this.clearStuck();
    void state;
  }

  private commitFix(blocks: RelativeBlockFix[]): void {
    if (blocks.length === 0) {
      return;
    }
    const key = fixKey(blocks);
    const existing = this.fixes.find((f) => fixKey(f.blocks) === key);
    if (existing) {
      existing.successes += 1;
      existing.lastUsed = Date.now();
    } else {
      this.fixes.unshift({
        id: `fix_${Date.now()}`,
        blocks: [...blocks],
        successes: 1,
        lastUsed: Date.now()
      });
    }
    this.fixes.sort((a, b) => b.successes - a.successes);
    this.fixes = this.fixes.slice(0, MAX_ENTRIES);
    saveStuckMemory(this.fixes, this.memoryFile);
    console.log(`[learn] saved fix (${blocks.length} block(s), ${this.fixes.length} total patterns)`);
  }

  clearStuck(): void {
    this.awaitingHelp = false;
    this.stuckAt = null;
    this.pendingBlocks = [];
  }

  retryMoveAction(): CompanionAction | null {
    if (!this.retryGoal) {
      return null;
    }
    return { type: "move_to", target: this.retryGoal, sprint: true };
  }
}
