import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { CompanionState } from "../types";
import { SurvivalGoal } from "./survival-skills";
import { isFoodItem } from "../bot-eat";
import { isStuckFailure } from "./learning";
import { ollamaChat } from "./ollama";

export type GameplaySnapshot = {
  at: number;
  health: number;
  hunger: number;
  foodStock: number;
  wood: number;
  stone: number;
  coal: number;
  hasSword: boolean;
  hasPick: boolean;
  hostileNear: boolean;
  night: boolean;
};

type Transition = {
  goal: SurvivalGoal;
  actionType: string;
  ok: boolean;
  reward: number;
  reason?: string;
  before: GameplaySnapshot;
  after: GameplaySnapshot;
  at: number;
};

type GoalValue = {
  /** Exponential moving average reward (Q-style value). */
  q: number;
  trials: number;
  streakFail: number;
};

type RlMemoryFile = {
  version: 1;
  goalValues: Record<string, GoalValue>;
  reflections: string[];
  totalReward: number;
  episodeCount: number;
};

const DEFAULT_FILE = "data/gameplay_rl.json";
const MAX_REFLECTIONS = 24;
const MAX_TRANSITIONS = 40;

const ALL_GOALS: SurvivalGoal[] = [
  "explore",
  "gather_wood",
  "gather_stone",
  "gather_coal",
  "craft_tools",
  "craft_survival",
  "deposit_chest",
  "fight_mobs"
];

function memoryPath(): string {
  return process.env.MC_RL_MEMORY_FILE ?? DEFAULT_FILE;
}

function loadMemory(): RlMemoryFile {
  try {
    const raw = readFileSync(memoryPath(), "utf-8");
    const parsed = JSON.parse(raw) as RlMemoryFile;
    if (parsed?.version === 1 && parsed.goalValues) {
      return parsed;
    }
  } catch {
    // no file
  }
  const goalValues: Record<string, GoalValue> = {};
  for (const g of ALL_GOALS) {
    goalValues[g] = { q: 0, trials: 0, streakFail: 0 };
  }
  return { version: 1, goalValues, reflections: [], totalReward: 0, episodeCount: 0 };
}

function saveMemory(mem: RlMemoryFile): void {
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

export function snapshotState(state: CompanionState): GameplaySnapshot {
  const t = state.world.timeOfDay ?? 6000;
  return {
    at: Date.now(),
    health: state.player.health,
    hunger: state.player.hunger,
    foodStock: state.inventory?.filter((i) => isFoodItem(i.name)).reduce((n, i) => n + i.count, 0) ?? 0,
    wood: countItem(state, /_log$|_stem$|_planks$/),
    stone: countItem(state, /cobble|stone|deepslate/),
    coal: countItem(state, /coal$/),
    hasSword: Boolean(state.inventory?.some((i) => i.name.endsWith("_sword"))),
    hasPick: Boolean(state.inventory?.some((i) => i.name.endsWith("_pickaxe"))),
    hostileNear: Boolean(state.nearbyMobs?.some((m) => m.hostile && m.distance < 10)),
    night: t > 12_000 && t < 24_000
  };
}

export class GameplayRL {
  private mem: RlMemoryFile;
  private recent: Transition[] = [];
  private ticksSinceReflect = 0;
  private llmReflectPending = false;

  constructor() {
    this.mem = loadMemory();
    for (const g of ALL_GOALS) {
      if (!this.mem.goalValues[g]) {
        this.mem.goalValues[g] = { q: 0, trials: 0, streakFail: 0 };
      }
    }
  }

  get enabled(): boolean {
    return process.env.MC_AI_RL !== "false";
  }

  /** Bias added to planner scores from learned Q-values. */
  goalBias(goal: SurvivalGoal): number {
    if (!this.enabled) {
      return 0;
    }
    const gv = this.mem.goalValues[goal];
    if (!gv || gv.trials < 2) {
      return 0;
    }
    const scale = Number(process.env.MC_AI_RL_BIAS_SCALE ?? "8") || 8;
    return gv.q * scale;
  }

  /** Penalize goals on a losing streak. */
  goalPenalty(goal: SurvivalGoal): number {
    const gv = this.mem.goalValues[goal];
    if (!gv || gv.streakFail < 3) {
      return 0;
    }
    return Math.min(25, gv.streakFail * 4);
  }

  computeReward(
    before: GameplaySnapshot,
    after: GameplaySnapshot,
    goal: SurvivalGoal,
    ok: boolean,
    reason?: string
  ): number {
    let r = ok ? 2 : -2.5;

    if (reason && isStuckFailure(reason)) {
      r -= 2;
    }
    if (!ok && /timeout|no reachable|no food/i.test(reason ?? "")) {
      r -= 1;
    }

    const dHealth = after.health - before.health;
    const dHunger = after.hunger - before.hunger;
    if (dHealth > 0) {
      r += 1.5;
    }
    if (dHealth < -2) {
      r -= 2;
    }
    if (dHunger > 0) {
      r += 0.8;
    }
    if (after.foodStock > before.foodStock) {
      r += 0.6;
    }
    if (after.wood > before.wood && goal === "gather_wood") {
      r += 1;
    }
    if (after.stone > before.stone && goal === "gather_stone") {
      r += 1;
    }
    if (after.coal > before.coal && goal === "gather_coal") {
      r += 1.2;
    }

    if (ok && goal === "fight_mobs" && !after.hostileNear && before.hostileNear) {
      r += 2;
    }
    if (goal === "explore" && ok) {
      r += 0.3;
    }
    if (after.health < 6 && goal !== "fight_mobs" && goal !== "craft_survival") {
      r -= 0.5;
    }

    return Math.max(-8, Math.min(8, r));
  }

  recordEpisode(
    goal: SurvivalGoal,
    actionType: string,
    before: GameplaySnapshot,
    after: GameplaySnapshot,
    ok: boolean,
    reason?: string
  ): { reward: number; reflection: string | null } {
    if (!this.enabled) {
      return { reward: 0, reflection: null };
    }

    const reward = this.computeReward(before, after, goal, ok, reason);
    const alpha = Number(process.env.MC_AI_RL_LEARNING_RATE ?? "0.25") || 0.25;

    const gv = this.mem.goalValues[goal] ?? { q: 0, trials: 0, streakFail: 0 };
    gv.trials += 1;
    gv.q = gv.q * (1 - alpha) + reward * alpha;
    if (!ok || reward < 0) {
      gv.streakFail += 1;
    } else {
      gv.streakFail = 0;
    }
    this.mem.goalValues[goal] = gv;

    this.mem.totalReward += reward;
    this.mem.episodeCount += 1;

    this.recent.push({
      goal,
      actionType,
      ok,
      reward,
      reason,
      before,
      after,
      at: Date.now()
    });
    while (this.recent.length > MAX_TRANSITIONS) {
      this.recent.shift();
    }

    saveMemory(this.mem);

    this.ticksSinceReflect += 1;
    const reflection = this.maybeReflect();
    return { reward, reflection };
  }

  /** Rule-based self-reflection from recent wins/losses. */
  maybeReflect(): string | null {
    const every = Number(process.env.MC_AI_RL_REFLECT_EVERY ?? "6") || 6;
    const recentBad = this.recent.filter((t) => t.reward < 0).slice(-4);
    const should =
      recentBad.length >= 2 &&
      (this.ticksSinceReflect >= every || recentBad.some((t) => (this.mem.goalValues[t.goal]?.streakFail ?? 0) >= 3));

    if (!should) {
      return null;
    }

    this.ticksSinceReflect = 0;
    const lesson = this.buildHeuristicReflection(recentBad);
    if (!lesson) {
      return null;
    }

    this.mem.reflections.push(lesson);
    while (this.mem.reflections.length > MAX_REFLECTIONS) {
      this.mem.reflections.shift();
    }
    saveMemory(this.mem);
    return lesson;
  }

  private buildHeuristicReflection(failures: Transition[]): string | null {
    const byGoal = new Map<SurvivalGoal, Transition[]>();
    for (const t of failures) {
      const list = byGoal.get(t.goal) ?? [];
      list.push(t);
      byGoal.set(t.goal, list);
    }

    const lines: string[] = [];
    for (const [goal, list] of byGoal) {
      const reasons = list.map((t) => t.reason ?? "failed").join("; ");
      const stuck = list.some((t) => isStuckFailure(t.reason));
      const gv = this.mem.goalValues[goal];

      if (goal === "gather_wood" && stuck) {
        lines.push("Chopping failed: path blocked — try nearer trees or ask owner to clear blocks.");
      } else if (goal === "gather_stone" || goal === "gather_coal") {
        lines.push(`Mining ${goal.replace("gather_", "")} struggled (${reasons}) — need pickaxe and open path.`);
      } else if (goal === "craft_tools" || goal === "craft_survival") {
        lines.push("Crafting failed: keep a crafting table within 48 blocks and stock wood/stone first.");
      } else if (goal === "fight_mobs") {
        lines.push("Combat was rough — equip sword, eat before fighting, retreat if low health.");
      } else if (goal === "explore" && stuck) {
        lines.push("Exploring got stuck — shorter walks and avoid water/cliffs.");
      } else if (goal === "deposit_chest") {
        lines.push("Deposit failed: build or find a chest nearby before hauling resources.");
      } else {
        lines.push(`${goal} did not work well (${reasons}).`);
      }

      if (gv && gv.q < -0.5) {
        lines.push(`I'll try ${goal} less until conditions improve (learned Q=${gv.q.toFixed(1)}).`);
      }
    }

    const topQ = [...ALL_GOALS]
      .map((g) => ({ g, q: this.mem.goalValues[g]?.q ?? 0 }))
      .sort((a, b) => b.q - a.q)
      .slice(0, 2)
      .filter((x) => x.q > 0.5);
    if (topQ.length) {
      lines.push(`What's working: ${topQ.map((x) => x.g).join(", ")}.`);
    }

    return lines.length ? lines.join(" ") : null;
  }

  summaryForPrompt(): string {
    if (!this.enabled) {
      return "";
    }
    const best = [...ALL_GOALS]
      .map((g) => ({ g, q: this.mem.goalValues[g]?.q ?? 0, n: this.mem.goalValues[g]?.trials ?? 0 }))
      .filter((x) => x.n >= 3)
      .sort((a, b) => b.q - a.q)
      .slice(0, 3)
      .map((x) => `${x.g}(${x.q >= 0 ? "+" : ""}${x.q.toFixed(1)})`)
      .join(", ");

    const lastReflect = this.mem.reflections[this.mem.reflections.length - 1];
    if (!best && !lastReflect) {
      return "RL: learning which actions pay off from health, loot, and failures.";
    }
    return `RL values: ${best || "collecting data"}.${lastReflect ? ` Reflection: ${lastReflect}` : ""}`;
  }

  getLastReflection(): string | undefined {
    return this.mem.reflections[this.mem.reflections.length - 1];
  }

  getStreakFail(goal: SurvivalGoal): number {
    return this.mem.goalValues[goal]?.streakFail ?? 0;
  }

  /** Optional deeper reflection via Ollama (async, non-blocking). */
  scheduleLlmReflection(ollamaHost: string, model: string): void {
    if (process.env.MC_AI_RL_REFLECT_LLM !== "true" || this.llmReflectPending) {
      return;
    }
    const minEpisodes = Number(process.env.MC_AI_RL_REFLECT_LLM_MIN ?? "8") || 8;
    if (this.mem.episodeCount < minEpisodes || this.recent.length < 4) {
      return;
    }
    if (this.ticksSinceReflect > 0) {
      return;
    }

    this.llmReflectPending = true;
    const recent = this.recent.slice(-8);
    const prompt = [
      "You are Luna's gameplay coach. Review her last Minecraft actions and rewards.",
      "Write ONE short lesson (max 120 chars) for what to do differently. Plain text only.",
      "",
      ...recent.map(
        (t) =>
          `${t.goal} ${t.ok ? "ok" : "fail"} reward=${t.reward.toFixed(1)} HP ${t.before.health}→${t.after.health} food ${t.before.hunger}→${t.after.hunger} ${t.reason ?? ""}`
      ),
      this.getLastReflection() ? `Prior lesson: ${this.getLastReflection()}` : ""
    ].join("\n");

    void ollamaChat({
      host: ollamaHost,
      model,
      messages: [
        { role: "system", content: "Short survival gameplay reflections only." },
        { role: "user", content: prompt }
      ],
      numPredict: 80,
      temperature: 0.4
    })
      .then((raw) => {
        const lesson = raw.trim().replace(/\s+/g, " ").slice(0, 140);
        if (lesson.length > 12) {
          this.mem.reflections.push(`[LLM] ${lesson}`);
          while (this.mem.reflections.length > MAX_REFLECTIONS) {
            this.mem.reflections.shift();
          }
          saveMemory(this.mem);
          console.log(`[reflect] ${lesson}`);
        }
      })
      .catch(() => {
        // Ollama optional
      })
      .finally(() => {
        this.llmReflectPending = false;
      });
  }
}
