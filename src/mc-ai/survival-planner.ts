import { CompanionState } from "../types";
import { recommendProcessStep } from "./craft-knowledge";
import { SurvivalGoal } from "./survival-skills";

const PHASE_CHAIN: SurvivalGoal[] = [
  "gather_wood",
  "craft_tools",
  "gather_stone",
  "gather_coal",
  "craft_survival",
  "deposit_chest"
];

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

/** Next goals in early-game order that are not yet satisfied. */
export function remainingEarlyGameGoals(state: CompanionState): SurvivalGoal[] {
  const out: SurvivalGoal[] = [];
  const logs = countItem(state, /_log$|_stem$/);
  const planks = countItem(state, /_planks$/);
  const wood = logs + planks;
  const hasPick = hasTool(state, "_pickaxe");
  const cobble = countItem(state, /cobble/);
  const coal = countItem(state, /coal$/);
  const torches = countItem(state, /torch/);

  if (wood < 6 && logs < 3) {
    out.push("gather_wood");
  }
  if (!hasPick || !hasTool(state, "_sword")) {
    out.push("craft_tools");
  }
  if (hasPick && cobble < 12) {
    out.push("gather_stone");
  }
  if (hasPick && coal < 4) {
    out.push("gather_coal");
  }
  if (torches < 4 && coal >= 1) {
    out.push("craft_survival");
  }
  if (wood >= 12 && cobble >= 8 && state.nearbyChest) {
    out.push("deposit_chest");
  }
  return out.length ? out : ["explore"];
}

/** Text block for the LLM — fixed survival plan so chat matches autonomous play. */
export function survivalPlannerSummary(state: CompanionState | null): string {
  if (!state) {
    return "";
  }

  const process = recommendProcessStep(state);
  const remaining = remainingEarlyGameGoals(state);
  const chain = remaining.slice(0, 4).join(" → ") || "explore";
  const processLine = process ? `Now (recipes): ${process.reason}` : "";

  return [
    "SURVIVAL PLAN (trust inventory + workstations; follow in order when autonomous or asked for routine):",
    `Queue: ${PHASE_CHAIN.join(" → ")}.`,
    `Your remaining steps: ${chain}.`,
    processLine
  ]
    .filter(Boolean)
    .join("\n");
}

/** Boost score when autonomous pick matches the planner queue head. */
export function plannerGoalBonus(state: CompanionState, goal: SurvivalGoal): number {
  const head = remainingEarlyGameGoals(state)[0];
  if (head && head === goal) {
    return 12;
  }
  const idx = PHASE_CHAIN.indexOf(goal);
  const headIdx = head ? PHASE_CHAIN.indexOf(head) : -1;
  if (idx >= 0 && headIdx >= 0 && idx < headIdx) {
    return -8;
  }
  return 0;
}
