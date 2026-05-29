import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { CompanionAction, CompanionState } from "../types";
import { LearnedHabit } from "./companion-observe";
import { GameplayRL } from "./reinforcement";
import { SurvivalGoal, SurvivalSkills } from "./survival-skills";

export type AutonomousGoal = SurvivalGoal | "idle";

type GoalStats = { successes: number; failures: number; lastUsed: number };

type AutonomousMemoryFile = {
  version: 1;
  goals: Record<string, GoalStats>;
  notes: string[];
};

const DEFAULT_FILE = "data/autonomous_play.json";
const MAX_NOTES = 30;

function memoryPath(): string {
  return process.env.MC_AUTONOMOUS_MEMORY_FILE ?? DEFAULT_FILE;
}

function loadMemory(): AutonomousMemoryFile {
  try {
    const raw = readFileSync(memoryPath(), "utf-8");
    const parsed = JSON.parse(raw) as AutonomousMemoryFile;
    if (parsed?.version === 1 && parsed.goals) {
      return parsed;
    }
  } catch {
    // no file
  }
  return { version: 1, goals: {}, notes: [] };
}

function saveMemory(mem: AutonomousMemoryFile): void {
  try {
    mkdirSync(dirname(memoryPath()), { recursive: true });
    writeFileSync(memoryPath(), JSON.stringify(mem, null, 2), "utf-8");
  } catch {
    // best effort
  }
}

export class AutonomousPlayer {
  private mem: AutonomousMemoryFile;
  private lastGoal: AutonomousGoal = "idle";
  private readonly file: string;
  private readonly survival: SurvivalSkills;

  constructor(file?: string, survival?: SurvivalSkills, _rl?: GameplayRL) {
    this.file = file ?? memoryPath();
    this.mem = loadMemory();
    this.survival = survival ?? new SurvivalSkills(_rl);
  }

  get enabled(): boolean {
    return process.env.MC_AI_AUTONOMOUS !== "false";
  }

  summaryForPrompt(): string {
    const top = Object.entries(this.mem.goals)
      .sort((a, b) => b[1].successes - a[1].successes)
      .slice(0, 3)
      .map(([g, s]) => `${g}(${s.successes}ok)`)
      .join(", ");
    const note = this.mem.notes[this.mem.notes.length - 1];
    if (!top && !note) {
      return "Autonomous play: learning by exploring when idle.";
    }
    return `Autonomous play learned: ${top || "exploring"}.${note ? ` Last note: ${note}` : ""}`;
  }

  get survivalSkills(): SurvivalSkills {
    return this.survival;
  }

  /** Pick next self-directed action from survival skill planner. */
  decide(
    state: CompanionState | null,
    ownerHabits: LearnedHabit[] = []
  ): { goal: AutonomousGoal; actions: CompanionAction[] } | null {
    if (!state) {
      return null;
    }
    this.survival.ingestOwnerHabits(ownerHabits);
    const plan = this.survival.decide(state, ownerHabits);
    if (!plan) {
      return null;
    }
    this.lastGoal = plan.goal;
    return plan;
  }

  recordOutcome(goal: AutonomousGoal, ok: boolean, detail?: string): void {
    if (goal !== "idle") {
      this.survival.recordGoal(goal, ok, detail);
    }
    const key = goal;
    const entry = this.mem.goals[key] ?? { successes: 0, failures: 0, lastUsed: 0 };
    if (ok) {
      entry.successes += 1;
    } else {
      entry.failures += 1;
    }
    entry.lastUsed = Date.now();
    this.mem.goals[key] = entry;

    if (detail) {
      const note = `${goal}: ${detail}`.slice(0, 120);
      this.mem.notes.push(note);
      while (this.mem.notes.length > MAX_NOTES) {
        this.mem.notes.shift();
      }
    }

    saveMemory(this.mem);
  }

  shouldPause(flags: {
    busy: boolean;
    taskFocus: boolean;
    voiceBusy: boolean;
    followOwner: boolean;
    lastReplyAt: number;
    userQueuePending?: boolean;
  }): boolean {
    if (!this.enabled) {
      return true;
    }
    if (flags.busy || flags.taskFocus || flags.voiceBusy || flags.userQueuePending) {
      return true;
    }
    if (flags.followOwner) {
      return true;
    }
    const pauseAfterChatMs = Number(process.env.MC_AI_AUTONOMOUS_PAUSE_AFTER_CHAT_MS ?? "8000") || 8000;
    if (Date.now() - flags.lastReplyAt < pauseAfterChatMs) {
      return true;
    }
    return false;
  }
}

export function isDirectCommand(message: string): boolean {
  const m = message.trim().toLowerCase();
  if (!m) {
    return false;
  }
  return (
    /\b(come|follow|stop|teleport|tp|gather|chop|mine|craft|fight|equip|hotbar|inventory|what do you have)\b/.test(
      m
    ) || m.length > 2
  );
}
