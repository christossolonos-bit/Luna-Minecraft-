import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { CompanionAction, CompanionState, Vec3 } from "../types";
import { LearnedHabit } from "./companion-observe";
import { McTurnResult, resolveActions, TaskIntent } from "./actions";
import { isFoodItem } from "../bot-eat";
import { GameplayRL } from "./reinforcement";
import { recommendProcessStep } from "./craft-knowledge";

export type SurvivalSkillId =
  | "wood_gathering"
  | "stone_mining"
  | "coal_mining"
  | "tool_crafting"
  | "gear_crafting"
  | "combat"
  | "food_security"
  | "storage"
  | "lighting"
  | "exploration"
  | "companion_sync";

export type SurvivalGoal =
  | "explore"
  | "gather_wood"
  | "gather_stone"
  | "gather_coal"
  | "craft_tools"
  | "craft_survival"
  | "deposit_chest"
  | "fight_mobs";

type SkillStat = {
  practice: number;
  successes: number;
  failures: number;
  lastUsed: number;
  ownerInfluence: number;
};

type SurvivalMemoryFile = {
  version: 1;
  skills: Record<string, SkillStat>;
  copiedHabits: string[];
  notes: string[];
};

const DEFAULT_FILE = "data/survival_skills.json";
const MAX_NOTES = 40;

export const SKILL_CATALOG: Record<
  SurvivalSkillId,
  { label: string; tip: string; goal: SurvivalGoal | null }
> = {
  wood_gathering: { label: "Chop wood", tip: "Logs for tools and fuel.", goal: "gather_wood" },
  stone_mining: { label: "Mine stone", tip: "Cobble for tools and furnace.", goal: "gather_stone" },
  coal_mining: { label: "Mine coal", tip: "Torches and smelting.", goal: "gather_coal" },
  tool_crafting: { label: "Craft tools", tip: "Pickaxe, axe, sword progression.", goal: "craft_tools" },
  gear_crafting: {
    label: "Survival gear",
    tip: "Torches, furnace, armor, bread.",
    goal: "craft_survival"
  },
  combat: { label: "Fight hostiles", tip: "Clear zombies and creepers.", goal: "fight_mobs" },
  food_security: { label: "Stay fed", tip: "Keep food stocked and eat when low.", goal: "craft_survival" },
  storage: { label: "Organize stash", tip: "Deposit extras in chests.", goal: "deposit_chest" },
  lighting: { label: "Light area", tip: "Craft torches before night.", goal: "craft_survival" },
  exploration: { label: "Scout", tip: "Learn the area safely.", goal: "explore" },
  companion_sync: { label: "Mirror you", tip: "Copy habits she sees you do.", goal: null }
};

const GOAL_TO_SKILL: Partial<Record<SurvivalGoal, SurvivalSkillId>> = {
  gather_wood: "wood_gathering",
  gather_stone: "stone_mining",
  gather_coal: "coal_mining",
  craft_tools: "tool_crafting",
  craft_survival: "gear_crafting",
  fight_mobs: "combat",
  deposit_chest: "storage",
  explore: "exploration"
};

function memoryPath(): string {
  return process.env.MC_SURVIVAL_SKILLS_FILE ?? DEFAULT_FILE;
}

function loadMemory(): SurvivalMemoryFile {
  try {
    const raw = readFileSync(memoryPath(), "utf-8");
    const parsed = JSON.parse(raw) as SurvivalMemoryFile;
    if (parsed?.version === 1 && parsed.skills) {
      return parsed;
    }
  } catch {
    // no file
  }
  const skills: Record<string, SkillStat> = {};
  for (const id of Object.keys(SKILL_CATALOG) as SurvivalSkillId[]) {
    skills[id] = { practice: 0, successes: 0, failures: 0, lastUsed: 0, ownerInfluence: 0 };
  }
  return { version: 1, skills, copiedHabits: [], notes: [] };
}

function saveMemory(mem: SurvivalMemoryFile): void {
  try {
    mkdirSync(dirname(memoryPath()), { recursive: true });
    writeFileSync(memoryPath(), JSON.stringify(mem, null, 2), "utf-8");
  } catch {
    // best effort
  }
}

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

function hasArmor(state: CompanionState): boolean {
  return Boolean(
    state.inventory?.some(
      (i) =>
        i.name.endsWith("_helmet") ||
        i.name.endsWith("_chestplate") ||
        i.name.endsWith("_leggings") ||
        i.name.endsWith("_boots")
    )
  );
}

function foodStock(state: CompanionState): number {
  if (!state.inventory?.length) {
    return 0;
  }
  return state.inventory.filter((i) => isFoodItem(i.name)).reduce((n, i) => n + i.count, 0);
}

function goalToTask(goal: SurvivalGoal): TaskIntent {
  if (goal === "explore") {
    return "none";
  }
  return goal;
}

function isNight(state: CompanionState): boolean {
  const t = state.world.timeOfDay ?? 6000;
  return t > 12_000 && t < 24_000;
}

function pickExploreTarget(state: CompanionState): Vec3 {
  const p = state.player.position;
  const owner = state.owner?.position;
  let angle = Math.random() * Math.PI * 2;
  let dist = 14 + Math.random() * 18;
  if (owner) {
    const dx = p.x - owner.x;
    const dz = p.z - owner.z;
    if (Math.hypot(dx, dz) < 8) {
      angle = Math.atan2(dx, dz) + Math.PI + (Math.random() - 0.5) * 0.8;
      dist = 16 + Math.random() * 12;
    }
  }
  return {
    x: Math.floor(p.x + Math.cos(angle) * dist),
    y: Math.floor(p.y),
    z: Math.floor(p.z + Math.sin(angle) * dist)
  };
}

function habitGoalBoosts(habits: LearnedHabit[]): Partial<Record<SurvivalGoal, number>> {
  const boost: Partial<Record<SurvivalGoal, number>> = {};
  for (const h of habits) {
    const p = h.pattern.toLowerCase();
    const w = Math.min(h.count, 12);
    if (p.includes("kill:")) {
      boost.fight_mobs = (boost.fight_mobs ?? 0) + w;
    }
    if (p.includes("log") || p.includes("stem")) {
      boost.gather_wood = (boost.gather_wood ?? 0) + w;
    }
    if (p.includes("stone") || p.includes("deepslate") || p.includes("cobble")) {
      boost.gather_stone = (boost.gather_stone ?? 0) + w;
    }
    if (p.includes("coal")) {
      boost.gather_coal = (boost.gather_coal ?? 0) + w;
    }
    if (p.includes("torch") || p.includes("lantern")) {
      boost.craft_survival = (boost.craft_survival ?? 0) + w * 1.5;
    }
    if (p.includes("chestplate") || p.includes("helmet") || p.includes("craft:")) {
      boost.craft_survival = (boost.craft_survival ?? 0) + w;
      boost.craft_tools = (boost.craft_tools ?? 0) + w * 0.5;
    }
    if (p.includes("bread") || p.includes("cooked")) {
      boost.craft_survival = (boost.craft_survival ?? 0) + w;
    }
    if (p.includes("place:") && (p.includes("crafting_table") || p.includes("furnace"))) {
      boost.craft_tools = (boost.craft_tools ?? 0) + w;
    }
  }
  return boost;
}

export class SurvivalSkills {
  private mem: SurvivalMemoryFile;

  constructor(private readonly rl?: GameplayRL) {
    this.mem = loadMemory();
  }

  get enabled(): boolean {
    return process.env.MC_AI_SURVIVAL_SKILLS !== "false";
  }

  ingestOwnerHabits(habits: LearnedHabit[]): void {
    const top = [...habits].sort((a, b) => b.count - a.count).slice(0, 8);
    for (const h of top) {
      if (!this.mem.copiedHabits.includes(h.pattern)) {
        this.mem.copiedHabits.push(h.pattern);
      }
      const skill = this.mapHabitToSkill(h);
      if (skill && this.mem.skills[skill]) {
        this.mem.skills[skill]!.ownerInfluence = Math.min(
          50,
          this.mem.skills[skill]!.ownerInfluence + 1
        );
      }
    }
    while (this.mem.copiedHabits.length > 30) {
      this.mem.copiedHabits.shift();
    }
    saveMemory(this.mem);
  }

  private mapHabitToSkill(h: LearnedHabit): SurvivalSkillId | null {
    const p = h.pattern.toLowerCase();
    if (p.includes("kill:")) {
      return "combat";
    }
    if (p.includes("log") || p.includes("stem")) {
      return "wood_gathering";
    }
    if (p.includes("coal")) {
      return "coal_mining";
    }
    if (p.includes("torch")) {
      return "lighting";
    }
    if (p.includes("chestplate") || p.includes("craft:")) {
      return "gear_crafting";
    }
    if (p.includes("stone") || p.includes("cobble")) {
      return "stone_mining";
    }
    return null;
  }

  recordGoal(goal: SurvivalGoal, ok: boolean, detail?: string): void {
    const skillId = GOAL_TO_SKILL[goal];
    if (!skillId || !this.mem.skills[skillId]) {
      return;
    }
    const s = this.mem.skills[skillId]!;
    s.practice += 1;
    s.lastUsed = Date.now();
    if (ok) {
      s.successes += 1;
    } else {
      s.failures += 1;
    }
    if (detail) {
      const note = `${SKILL_CATALOG[skillId].label}: ${detail}`.slice(0, 100);
      this.mem.notes.push(note);
      while (this.mem.notes.length > MAX_NOTES) {
        this.mem.notes.shift();
      }
    }
    saveMemory(this.mem);
  }

  recordTask(task: string, ok: boolean, detail?: string): void {
    const map: Record<string, SurvivalGoal> = {
      gather_wood: "gather_wood",
      gather_stone: "gather_stone",
      gather_coal: "gather_coal",
      craft_tools: "craft_tools",
      craft_survival: "craft_survival",
      deposit_chest: "deposit_chest",
      fight_mobs: "fight_mobs"
    };
    const goal = map[task];
    if (goal) {
      this.recordGoal(goal, ok, detail);
    }
  }

  summaryForPrompt(habits: LearnedHabit[], rlSummary = ""): string {
    const practiced = (Object.keys(SKILL_CATALOG) as SurvivalSkillId[])
      .map((id) => ({ id, s: this.mem.skills[id] }))
      .filter((x) => x.s && x.s.practice > 0)
      .sort((a, b) => (b.s!.successes - a.s!.successes) - (a.s!.successes - b.s!.successes))
      .slice(0, 5)
      .map((x) => `${SKILL_CATALOG[x.id].label}(${x.s!.successes}ok)`)
      .join(", ");

    const habitHint =
      habits.length > 0
        ? `Mirroring you: ${habits
            .slice(0, 2)
            .map((h) => h.pattern)
            .join("; ")}.`
        : "";

    const note = this.mem.notes[this.mem.notes.length - 1];
    if (!practiced && !habitHint) {
      return "Survival skills: learning intermediate play (wood, stone, coal, tools, armor, torches, food, combat).";
    }
    const base = `Survival skills practiced: ${practiced || "starting out"}. ${habitHint}${note ? ` Last: ${note}` : ""}`;
    return rlSummary ? `${base} ${rlSummary}` : base;
  }

  /** Intermediate survival planner — habits boost what she saw you do. */
  decide(
    state: CompanionState | null,
    habits: LearnedHabit[] = []
  ): { goal: SurvivalGoal; actions: CompanionAction[] } | null {
    if (!state) {
      return null;
    }

    const logs = countItem(state, /_log$|_stem$/);
    const planks = countItem(state, /_planks$/);
    const wood = logs + planks;
    const sticks = countItem(state, /^stick$/);
    const stone = countItem(state, /cobble|stone|deepslate/);
    const coal = countItem(state, /coal$/);
    const torches = countItem(state, /torch/);
    const iron = countItem(state, /^iron_ingot$/);
    const hasSword = hasTool(state, "_sword");
    const hasPick = hasTool(state, "_pickaxe");
    const hasAxe = hasTool(state, "_axe");
    const armor = hasArmor(state);
    const food = foodStock(state);
    const threat = state.nearbyMobs?.find((m) => m.hostile && m.distance < 8);
    const boosts = habitGoalBoosts(habits);
    const night = isNight(state);

    type Scored = { goal: SurvivalGoal; score: number };
    const candidates: Scored[] = [];

    const add = (goal: SurvivalGoal, base: number) => {
      const rlBoost = this.rl?.goalBias(goal) ?? 0;
      const rlPen = this.rl?.goalPenalty(goal) ?? 0;
      candidates.push({
        goal,
        score: base + (boosts[goal] ?? 0) + skillAffinity(goal) + rlBoost - rlPen
      });
    };

    const skillAffinity = (goal: SurvivalGoal): number => {
      const id = GOAL_TO_SKILL[goal];
      if (!id || !this.mem.skills[id]) {
        return 0;
      }
      const s = this.mem.skills[id]!;
      const weak = s.practice < 5 ? 2 : 0;
      return s.ownerInfluence * 0.15 + weak;
    };

    const processStep = recommendProcessStep(state);
    if (processStep) {
      add(processStep.goal, processStep.priority);
      if (processStep.chain === "tools_stone" || processStep.chain === "tools_wood") {
        add("craft_tools", processStep.priority + 22);
      }
    }

    if (food < 6 && (wood >= 2 || countItem(state, /wheat/) >= 3)) {
      const toolChain =
        processStep &&
        processStep.goal === "craft_tools" &&
        (processStep.chain === "tools_stone" || processStep.chain === "tools_wood");
      if (!toolChain) {
        add("craft_survival", 75);
      }
    }
    if (threat && hasSword) {
      add("fight_mobs", 90);
    }
    if (logs >= 2 && (!hasPick || !hasSword)) {
      add("craft_tools", 85);
    }
    if (logs >= 6 && !hasPick) {
      add("craft_tools", 88);
    }
    if (!hasSword && planks >= 4 && sticks >= 2) {
      add("craft_tools", 78);
    }
    if (wood < 4 && logs < 2 && (hasAxe || !hasPick)) {
      add("gather_wood", 68);
    } else if (wood < 6 && !hasPick && !hasSword && logs < 4) {
      add("gather_wood", 65);
    }
    if (stone < 10 && hasPick) {
      add("gather_stone", 60);
    }
    if (coal < 4 && hasPick && stone >= 4) {
      add("gather_coal", 55 + (night ? 15 : 0));
    }
    if ((torches < 8 || night) && coal >= 1 && countItem(state, /stick/) >= 1) {
      add("craft_survival", 58 + (night ? 20 : 0));
    }
    if (!armor && (iron >= 8 || countItem(state, /leather/) >= 8)) {
      add("craft_survival", 52);
    }
    if (wood >= 16 && stone >= 12 && state.nearbyChest) {
      add("deposit_chest", 45);
    }
    if (!hasPick && logs >= 2) {
      add("craft_tools", 72);
    }
    add("explore", 20);

    candidates.sort((a, b) => b.score - a.score);
    const goal = candidates[0]?.goal ?? "explore";

    const turn: McTurnResult = {
      say: "",
      move: "none",
      lookAt: "none",
      task: goalToTask(goal),
      taskAmount: Number(process.env.MC_TASK_GATHER_AMOUNT ?? "6") || 6
    };

    let actions = resolveActions(state, turn);
    if (goal === "explore") {
      actions = [{ type: "move_to", target: pickExploreTarget(state), sprint: false }];
    }
    if (actions.length === 0) {
      return null;
    }
    return { goal, actions };
  }
}
