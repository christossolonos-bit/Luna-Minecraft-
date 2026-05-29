import { CompanionAction, CompanionState } from "../types";
import { LearnedHabit } from "./companion-observe";
import { recommendProcessStep } from "./craft-knowledge";
import { isStuckFailure } from "./learning";
import { SurvivalGoal, SurvivalSkills } from "./survival-skills";
import { isFoodItem } from "../bot-eat";

export type ActivityKind =
  | "idle"
  | "autonomous"
  | "owner_command"
  | "eating"
  | "following"
  | "defending"
  | "queued_command"
  | "stuck";

export type SurvivalPhase =
  | "spawn"
  | "get_wood"
  | "get_tools"
  | "get_stone"
  | "get_coal"
  | "gear_up"
  | "established";

export type AgentStatusSnapshot = {
  activity: ActivityKind;
  phase: SurvivalPhase;
  goal: SurvivalGoal | "none";
  stuck: boolean;
  stuckReason?: string;
  position: { x: number; y: number; z: number };
  distToOwner?: number;
  timeLabel: string;
  progressHint: string;
  nextStep: string;
};

type StatusFlags = {
  busy: boolean;
  autonomousBusy: boolean;
  followOwner: boolean;
  commandQueuePending: number;
  voiceBusy: boolean;
  taskFocus: boolean;
};

function countItem(state: CompanionState, pattern: RegExp): number {
  if (!state.inventory?.length) {
    return 0;
  }
  return state.inventory
    .filter((i) => pattern.test(i.name))
    .reduce((n, i) => n + i.count, 0);
}

function hasTool(state: CompanionState, suffix: string): boolean {
  return Boolean(state.inventory?.some((i) => i.name.endsWith(suffix)));
}

function timeLabel(state: CompanionState): string {
  const t = state.world.timeOfDay ?? 6000;
  if (t >= 0 && t < 6000) {
    return "morning";
  }
  if (t < 12_000) {
    return "day";
  }
  if (t < 18_000) {
    return "evening";
  }
  return "night";
}

function detectPhase(state: CompanionState): SurvivalPhase {
  const logs = countItem(state, /_log$|_stem$/);
  const planks = countItem(state, /_planks$/);
  const hasPick = hasTool(state, "_pickaxe");
  const hasSword = hasTool(state, "_sword");
  const cobble = countItem(state, /cobble/);
  const coal = countItem(state, /coal$/);
  const torches = countItem(state, /torch/);
  const food = state.inventory?.filter((i) => isFoodItem(i.name)).reduce((n, i) => n + i.count, 0) ?? 0;

  if (!hasPick && logs + planks < 2) {
    return "get_wood";
  }
  if (!hasPick) {
    return "get_tools";
  }
  if (cobble < 12) {
    return "get_stone";
  }
  if (coal < 4) {
    return "get_coal";
  }
  if (!hasSword || torches < 4 || food < 4) {
    return "gear_up";
  }
  return "established";
}

function phaseProgressHint(phase: SurvivalPhase): string {
  switch (phase) {
    case "spawn":
      return "Just spawned — assess inventory.";
    case "get_wood":
      return "Priority: chop logs for crafting materials.";
    case "get_tools":
      return "Priority: planks → sticks → table → wooden/stone pick.";
    case "get_stone":
      return "Priority: mine cobblestone for stone tools & furnace.";
    case "get_coal":
      return "Priority: mine coal for torches and smelting.";
    case "gear_up":
      return "Priority: sword, torches, food before night.";
    case "established":
      return "Stocked up — explore, stash, or help owner.";
  }
}

function dist2d(a: { x: number; z: number }, b: { x: number; z: number }): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

export class AgentStatusTracker {
  private activity: ActivityKind = "idle";
  private goal: SurvivalGoal | "none" = "none";
  private phase: SurvivalPhase = "spawn";
  private stuck = false;
  private stuckReason?: string;
  private lastPos: { x: number; y: number; z: number } | null = null;
  private samePosTicks = 0;
  private failStreak = 0;
  private lastFailGoal?: SurvivalGoal;
  private lastStatusLogAt = 0;
  private lastActivityChange = "";
  private nextStepHint = "";

  tick(state: CompanionState, flags: StatusFlags): AgentStatusSnapshot {
    this.phase = detectPhase(state);
    this.updateActivity(flags);
    this.updateStuckByPosition(state, flags);

    if (!flags.busy && !flags.autonomousBusy && !flags.followOwner && this.activity === "idle") {
      this.goal = "none";
    }

    const snap = this.snapshot(state);
    this.maybeLogStatus(state, snap);
    return snap;
  }

  setActivity(activity: ActivityKind, goal: SurvivalGoal | "none" = "none"): void {
    const label = `${activity}:${goal}`;
    if (label !== this.lastActivityChange) {
      this.lastActivityChange = label;
      this.activity = activity;
      this.goal = goal;
      if (activity !== "stuck") {
        this.stuck = false;
        this.stuckReason = undefined;
      }
    }
  }

  recordActionResult(goal: SurvivalGoal | "none", ok: boolean, reason?: string): void {
    if (ok) {
      this.failStreak = 0;
      this.lastFailGoal = undefined;
      if (this.stuck && !isStuckFailure(reason)) {
        this.stuck = false;
        this.stuckReason = undefined;
        if (this.activity === "stuck") {
          this.activity = "autonomous";
        }
      }
      return;
    }

    const g = goal === "none" ? undefined : goal;
    if (g && g === this.lastFailGoal) {
      this.failStreak += 1;
    } else {
      this.failStreak = 1;
      this.lastFailGoal = g;
    }

    if (isStuckFailure(reason) || this.failStreak >= 2) {
      this.stuck = true;
      this.stuckReason = reason ?? `failed ${goal} x${this.failStreak}`;
      this.activity = "stuck";
    }
  }

  decideProgress(
    state: CompanionState,
    habits: LearnedHabit[],
    survival: SurvivalSkills
  ): { goal: SurvivalGoal; actions: CompanionAction[]; reason: string } | null {
    const process = recommendProcessStep(state);
    this.nextStepHint = process?.reason ?? phaseProgressHint(this.phase);

    if (this.stuck) {
      const recovery = this.recoveryPlan(state, process?.goal);
      if (recovery) {
        this.goal = recovery.goal;
        return recovery;
      }
    }

    if (process && process.priority >= 85) {
      const base = survival.decide(state, habits);
      if (base) {
        this.goal = process.goal;
        return { goal: base.goal, actions: base.actions, reason: process.reason };
      }
    }

    const plan = survival.decide(state, habits);
    if (!plan) {
      return null;
    }

    if (
      process &&
      process.goal === "craft_tools" &&
      (process.chain === "tools_stone" || process.chain === "tools_wood") &&
      plan.goal !== "craft_tools"
    ) {
      this.goal = "craft_tools";
      return {
        goal: "craft_tools",
        actions: [{ type: "run_task", task: "craft_tools" }],
        reason: process.reason
      };
    }

    if (this.lastFailGoal === plan.goal && this.failStreak >= 2) {
      const alt = this.recoveryPlan(state, plan.goal);
      if (alt) {
        this.goal = alt.goal;
        return alt;
      }
    }

    this.goal = plan.goal;
    return {
      ...plan,
      reason: process?.reason ?? phaseProgressHint(this.phase)
    };
  }

  snapshot(state: CompanionState): AgentStatusSnapshot {
    const p = state.player.position;
    let distToOwner: number | undefined;
    if (state.owner) {
      distToOwner = dist2d(p, state.owner.position);
    }
    return {
      activity: this.activity,
      phase: this.phase,
      goal: this.goal,
      stuck: this.stuck,
      stuckReason: this.stuckReason,
      position: { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) },
      distToOwner,
      timeLabel: timeLabel(state),
      progressHint: phaseProgressHint(this.phase),
      nextStep: this.nextStepHint || phaseProgressHint(this.phase)
    };
  }

  summaryForPrompt(state: CompanionState | null): string {
    if (!state) {
      return "STATUS: connecting to world.";
    }
    const s = this.snapshot(state);
    const ownerBit =
      s.distToOwner !== undefined ? ` | ${Math.round(s.distToOwner)}m from owner` : "";
    const stuckBit = s.stuck ? ` | STUCK: ${s.stuckReason ?? "yes"}` : "";
    const doing =
      s.activity === "idle" && s.goal === "none"
        ? "idle"
        : `${s.activity}${s.goal !== "none" ? ` → ${s.goal}` : ""}`;
    return (
      `STATUS: (${s.position.x},${s.position.y},${s.position.z}) ${s.timeLabel}${ownerBit} | ` +
      `phase=${s.phase} | doing=${doing}${stuckBit} | next: ${s.nextStep}`
    );
  }

  private updateActivity(flags: StatusFlags): void {
    if (this.stuck) {
      this.activity = "stuck";
      return;
    }
    if (flags.commandQueuePending > 0) {
      this.activity = "queued_command";
      return;
    }
    if (flags.busy) {
      this.activity = "owner_command";
      return;
    }
    if (flags.autonomousBusy) {
      this.activity = "autonomous";
      return;
    }
    if (flags.followOwner) {
      this.activity = "following";
      return;
    }
    if (!flags.busy && !flags.autonomousBusy) {
      this.activity = "idle";
    }
  }

  private updateStuckByPosition(state: CompanionState, flags: StatusFlags): void {
    const p = state.player.position;
    const pos = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
    if (
      this.lastPos &&
      this.lastPos.x === pos.x &&
      this.lastPos.y === pos.y &&
      this.lastPos.z === pos.z
    ) {
      this.samePosTicks += 1;
    } else {
      this.samePosTicks = 0;
      if (this.stuck && this.stuckReason?.includes("not moving")) {
        this.stuck = false;
        this.stuckReason = undefined;
      }
    }
    this.lastPos = pos;

    const threshold = Number(process.env.MC_AI_STUCK_POS_TICKS ?? "12") || 12;
    if (
      (flags.autonomousBusy || flags.busy) &&
      this.samePosTicks >= threshold &&
      this.goal !== "none"
    ) {
      this.stuck = true;
      this.stuckReason = `not moving at (${pos.x},${pos.y},${pos.z}) for ${this.samePosTicks}s`;
      this.activity = "stuck";
    }
  }

  private recoveryPlan(
    state: CompanionState,
    failedGoal?: SurvivalGoal
  ): { goal: SurvivalGoal; actions: CompanionAction[]; reason: string } | null {
    const logs = countItem(state, /_log$|_stem$/);
    const planks = countItem(state, /_planks$/);
    const hasPick = hasTool(state, "_pickaxe");
    const goal = failedGoal ?? this.lastFailGoal ?? (this.goal === "none" ? undefined : this.goal);

    if (goal === "gather_wood" || goal === "explore") {
      const coalVisible = state.world.nearbyBlocks?.some((b) => b.includes("coal_ore"));
      if (goal === "gather_wood" && coalVisible && hasPick && this.failStreak >= 2) {
        return {
          goal: "gather_coal",
          actions: [{ type: "run_task", task: "gather_coal", amount: 4 }],
          reason: "Recovery: coal ore nearby — mine coal instead of chopping wood."
        };
      }
      if (logs >= 2 || planks >= 4) {
        return {
          goal: "craft_tools",
          actions: [{ type: "run_task", task: "craft_tools" }],
          reason: "Recovery: have wood — craft planks/tools instead of repeating chop."
        };
      }
      return {
        goal: "explore",
        actions: [
          {
            type: "move_to",
            target: {
              x: Math.floor(state.player.position.x + (Math.random() > 0.5 ? 14 : -14)),
              y: Math.floor(state.player.position.y),
              z: Math.floor(state.player.position.z + (Math.random() > 0.5 ? 14 : -14))
            },
            sprint: false
          }
        ],
        reason: "Recovery: move to new area — trees/path may be blocked here."
      };
    }

    if (goal === "craft_tools" || goal === "craft_survival") {
      if (logs >= 1) {
        return {
          goal: "craft_tools",
          actions: [{ type: "run_task", task: "craft_tools" }],
          reason: "Recovery: craft planks → table → tools from inventory logs."
        };
      }
      return {
        goal: "gather_wood",
        actions: [{ type: "run_task", task: "gather_wood", amount: 4 }],
        reason: "Recovery: need logs before crafting can work."
      };
    }

    if (goal === "gather_stone" && !hasPick) {
      return {
        goal: "craft_tools",
        actions: [{ type: "run_task", task: "craft_tools" }],
        reason: "Recovery: need pickaxe before mining stone."
      };
    }

    if (goal === "gather_coal" && this.failStreak >= 2) {
      return {
        goal: "explore",
        actions: [
          {
            type: "move_to",
            target: {
              x: Math.floor(state.player.position.x + (Math.random() > 0.5 ? 16 : -16)),
              y: Math.floor(state.player.position.y),
              z: Math.floor(state.player.position.z + (Math.random() > 0.5 ? 16 : -16))
            },
            sprint: true
          }
        ],
        reason: "Recovery: no coal nearby — scout a new area."
      };
    }

    if (this.stuck) {
      return {
        goal: "explore",
        actions: [
          {
            type: "move_to",
            target: {
              x: Math.floor(state.player.position.x + 10),
              y: Math.floor(state.player.position.y),
              z: Math.floor(state.player.position.z + 10)
            },
            sprint: true
          }
        ],
        reason: "Recovery: unstuck — walk to open ground and retry."
      };
    }

    return null;
  }

  private maybeLogStatus(state: CompanionState, s: AgentStatusSnapshot): void {
    const interval = Number(process.env.MC_AI_STATUS_LOG_MS ?? "15000") || 15000;
    const now = Date.now();
    if (now - this.lastStatusLogAt < interval && !s.stuck) {
      return;
    }
    this.lastStatusLogAt = now;
    console.log(`[status] ${this.summaryForPrompt(state).replace(/^STATUS: /, "")}`);
  }
}
