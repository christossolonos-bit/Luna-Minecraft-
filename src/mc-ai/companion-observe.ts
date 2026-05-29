import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { CompanionState, OwnerActivityEvent } from "../types";

export type LearnedHabit = {
  id: string;
  category: "combat" | "craft" | "gather" | "build" | "survival";
  pattern: string;
  count: number;
  lastSeen: number;
};

type ObserveMemoryFile = {
  version: 1;
  habits: LearnedHabit[];
};

const DEFAULT_FILE = "data/companion_habits.json";
const MAX_HABITS = 60;
const TOOL_ITEMS = new Set([
  "wooden_sword",
  "stone_sword",
  "iron_sword",
  "wooden_pickaxe",
  "stone_pickaxe",
  "iron_pickaxe",
  "wooden_axe",
  "stone_axe",
  "iron_axe",
  "wooden_shovel",
  "stone_shovel",
  "iron_shovel"
]);

function memoryPath(): string {
  return process.env.MC_OBSERVE_MEMORY_FILE ?? DEFAULT_FILE;
}

function loadHabits(file = memoryPath()): LearnedHabit[] {
  try {
    const raw = readFileSync(file, "utf-8");
    const parsed = JSON.parse(raw) as ObserveMemoryFile;
    if (parsed?.version === 1 && Array.isArray(parsed.habits)) {
      return parsed.habits;
    }
  } catch {
    // no file yet
  }
  return [];
}

function saveHabits(habits: LearnedHabit[], file = memoryPath()): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ version: 1, habits: habits.slice(0, MAX_HABITS) }, null, 2));
  } catch {
    // best effort
  }
}

function habitKey(category: LearnedHabit["category"], pattern: string): string {
  return `${category}:${pattern}`;
}

export class CompanionObserver {
  private habits: LearnedHabit[];
  private readonly memoryFile: string;
  private seenEventKeys = new Set<string>();
  private lastOwnerHeld?: string;
  private ownerNearTable = false;
  private lastCommentAt = 0;

  constructor(memoryFile?: string) {
    this.memoryFile = memoryFile ?? memoryPath();
    this.habits = loadHabits(this.memoryFile);
  }

  get habitCount(): number {
    return this.habits.length;
  }

  getHabits(): LearnedHabit[] {
    return [...this.habits];
  }

  /** Passive ingest each state tick — does not interrupt Luna's tasks. */
  ingest(state: CompanionState): string | null {
    this.trackOwnerHeld(state);
    for (const ev of state.recentOwnerActivity ?? []) {
      this.recordEvent(ev);
    }
    return this.maybeObservationComment(state);
  }

  summaryForPrompt(): string {
    if (this.habits.length === 0) {
      return "Watching player: no learned habits yet.";
    }
    const top = [...this.habits].sort((a, b) => b.count - a.count).slice(0, 4);
    const bits = top.map((h) => `${h.pattern} (${h.count}x)`).join("; ");
    return `Watching player habits: ${bits}.`;
  }

  preferredSword(): string | null {
    const swords = this.habits
      .filter((h) => h.category === "combat" && h.pattern.includes("sword"))
      .sort((a, b) => b.count - a.count);
    for (const h of swords) {
      const match = h.pattern.match(/with:([\w_]+)/);
      if (match?.[1]?.endsWith("_sword")) {
        return match[1];
      }
    }
    return null;
  }

  shouldAutoDefend(state: CompanionState): boolean {
    if (process.env.MC_AI_AUTO_DEFEND === "false") {
      return false;
    }
    const threat = state.nearbyMobs?.find((m) => m.hostile && m.distance < 10);
    if (!threat) {
      return false;
    }
    return state.player.health < 16 || threat.distance < 6;
  }

  private trackOwnerHeld(state: CompanionState): void {
    const held = state.owner?.heldItem;
    if (!held || held === this.lastOwnerHeld) {
      return;
    }
    const prev = this.lastOwnerHeld;
    this.lastOwnerHeld = held;

    if (TOOL_ITEMS.has(held) && this.ownerNearTable) {
      this.learn("craft", `craft:${held}`, Date.now());
    } else if (held.endsWith("_sword")) {
      this.learn("combat", `equip:${held}`, Date.now());
    } else if (held.endsWith("_chestplate") || held.endsWith("_helmet")) {
      this.learn("survival", `armor:${held}`, Date.now());
    } else if (held === "torch" || held === "bread" || held.includes("cooked")) {
      this.learn("survival", `use:${held}`, Date.now());
    } else if (prev?.endsWith("_pickaxe") || prev?.endsWith("_axe")) {
      this.learn("gather", `use:${prev}`, Date.now());
    }

    this.pushActivity({
      kind: "equip_item",
      detail: held,
      at: Date.now()
    });
  }

  private recordEvent(ev: OwnerActivityEvent): void {
    const key = `${ev.kind}:${ev.detail}:${Math.floor(ev.at / 1000)}`;
    if (this.seenEventKeys.has(key)) {
      return;
    }
    this.seenEventKeys.add(key);
    while (this.seenEventKeys.size > 200) {
      const first = this.seenEventKeys.values().next().value;
      if (first) {
        this.seenEventKeys.delete(first);
      } else {
        break;
      }
    }

    switch (ev.kind) {
      case "break_block":
        if (ev.detail.includes("log") || ev.detail.includes("stem")) {
          this.learn("gather", `break:${ev.detail}`, ev.at);
        } else if (ev.detail.includes("coal_ore")) {
          this.learn("gather", `break:${ev.detail}`, ev.at);
          this.learn("survival", `mine:coal`, ev.at);
        } else if (ev.detail.includes("stone") || ev.detail === "deepslate") {
          this.learn("gather", `break:${ev.detail}`, ev.at);
        } else if (ev.detail.includes("iron_ore") || ev.detail.includes("gold_ore")) {
          this.learn("survival", `mine:${ev.detail}`, ev.at);
        }
        break;
      case "place_block":
        this.learn("build", `place:${ev.detail}`, ev.at);
        if (ev.detail.includes("torch") || ev.detail.includes("lantern")) {
          this.learn("survival", `place:${ev.detail}`, ev.at);
        }
        if (ev.detail === "crafting_table" || ev.detail === "furnace") {
          this.learn("survival", `place:${ev.detail}`, ev.at);
        }
        break;
      case "kill_mob": {
        const [mob, weapon] = ev.detail.split("|");
        this.learn("combat", `kill:${mob ?? "mob"}:with:${weapon ?? "hand"}`, ev.at);
        break;
      }
      case "craft_item":
        this.learn("craft", `craft:${ev.detail}`, ev.at);
        break;
      default:
        break;
    }
  }

  private learn(category: LearnedHabit["category"], pattern: string, at: number): void {
    const id = habitKey(category, pattern);
    const existing = this.habits.find((h) => h.id === id);
    if (existing) {
      existing.count += 1;
      existing.lastSeen = at;
    } else {
      this.habits.unshift({ id, category, pattern, count: 1, lastSeen: at });
    }
    this.habits.sort((a, b) => b.count - a.count);
    this.habits = this.habits.slice(0, MAX_HABITS);
    saveHabits(this.habits, this.memoryFile);
  }

  private pushActivity(_ev: OwnerActivityEvent): void {
    // held-item changes are tracked internally; build/kill events come from bot state
  }

  private maybeObservationComment(state: CompanionState): string | null {
    if (process.env.MC_AI_OBSERVE_COMMENTS !== "true") {
      return null;
    }
    const now = Date.now();
    if (now - this.lastCommentAt < 90_000) {
      return null;
    }
    const recent = state.recentOwnerActivity?.slice(-1)[0];
    if (!recent || now - recent.at > 5000) {
      return null;
    }
    this.lastCommentAt = now;
    switch (recent.kind) {
      case "kill_mob":
        return `(They fought ${recent.detail.replace("|", " with ")}.) React briefly as their companion.`;
      case "craft_item":
        return `(They crafted ${recent.detail}.) React briefly — you're learning from them.`;
      case "break_block":
        if (recent.detail.includes("log")) {
          return `(They're chopping ${recent.detail}.) React briefly as their companion.`;
        }
        return null;
      default:
        return null;
    }
  }

  setOwnerNearTable(near: boolean): void {
    this.ownerNearTable = near;
  }
}
