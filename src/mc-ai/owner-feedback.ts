import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { CraftableItem } from "./craft-requests";
import { McTurnResult, MoveIntent, TaskIntent } from "./actions";
import { SurvivalGoal } from "./survival-skills";
import type { GameplayRL } from "./reinforcement";
import type { SurvivalSkills } from "./survival-skills";

export type FeedbackPolarity = "positive" | "negative";

export type LastOwnerAction = {
  ownerMessage: string;
  lunaSay: string;
  task: TaskIntent;
  move: MoveIntent;
  craftItem?: string;
  goal: SurvivalGoal | null;
  ok: boolean;
  at: number;
};

export type LearnedOwnerPattern = {
  id: string;
  /** Keywords from the owner's request that led to a praised action */
  triggers: string[];
  task: TaskIntent;
  move: MoveIntent;
  craftItem?: string;
  score: number;
  successes: number;
  failures: number;
  lastUsed: number;
};

type OwnerFeedbackFile = {
  version: 1;
  lastAction: LastOwnerAction | null;
  patterns: LearnedOwnerPattern[];
  ownerNotes: string[];
};

const DEFAULT_FILE = "data/owner_action_memory.json";
const MAX_PATTERNS = 48;
const MAX_NOTES = 36;

function memoryPath(): string {
  return process.env.MC_OWNER_FEEDBACK_FILE ?? DEFAULT_FILE;
}

function loadFile(): OwnerFeedbackFile {
  try {
    const raw = readFileSync(memoryPath(), "utf-8");
    const parsed = JSON.parse(raw) as OwnerFeedbackFile;
    if (parsed?.version === 1 && Array.isArray(parsed.patterns)) {
      return parsed;
    }
  } catch {
    // new file
  }
  return { version: 1, lastAction: null, patterns: [], ownerNotes: [] };
}

function saveFile(mem: OwnerFeedbackFile): void {
  try {
    mkdirSync(dirname(memoryPath()), { recursive: true });
    writeFileSync(memoryPath(), JSON.stringify(mem, null, 2), "utf-8");
  } catch {
    // best effort
  }
}

function goalFromTurn(turn: McTurnResult): SurvivalGoal | null {
  const map: Record<string, SurvivalGoal> = {
    gather_wood: "gather_wood",
    gather_stone: "gather_stone",
    gather_coal: "gather_coal",
    craft_tools: "craft_tools",
    craft_survival: "craft_survival",
    deposit_chest: "deposit_chest",
    fight_mobs: "fight_mobs",
    hunt_animal: "fight_mobs",
    explore: "explore"
  };
  if (turn.task !== "none") {
    return map[turn.task] ?? null;
  }
  if (turn.move === "come_to_owner" || turn.move === "follow_owner") {
    return "explore";
  }
  return null;
}

function extractTriggers(message: string): string[] {
  const stop = new Set([
    "luna",
    "please",
    "could",
    "would",
    "want",
    "need",
    "some",
    "that",
    "this",
    "with",
    "have",
    "make",
    "help"
  ]);
  return [
    ...new Set(
      message
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 2 && !stop.has(w))
    )
  ].slice(0, 8);
}

function patternKey(triggers: string[], task: string, craft?: string): string {
  return `${triggers.slice(0, 4).join("+")}|${task}|${craft ?? ""}`;
}

/** Owner praise or correction — not a gameplay command. */
export function parseOwnerFeedback(message: string): FeedbackPolarity | null {
  const m = message.trim().toLowerCase();
  if (m.length < 3 || m.length > 120) {
    return null;
  }
  if (
    /\b(good job|great job|well done|nice work|nice one|perfect|awesome|excellent|amazing|that'?s right|exactly|you nailed|love it|so good|well played)\b/.test(
      m
    ) ||
    /\b(thanks|thank you).{0,20}(worked|helped|perfect)\b/.test(m) ||
    /^(yes|yep|yeah|correct|right)\b/.test(m) ||
    /\b(do more like that|keep doing that|more of that)\b/.test(m)
  ) {
    return "positive";
  }
  if (
    /\b(bad job|terrible|awful|wrong|not that|don'?t do that|stop doing|quit that|no good|that sucked|waste of time)\b/.test(
      m
    ) ||
    /\b(don'?t ever|never do that again|that was wrong|so wrong)\b/.test(m) ||
    /^(no|nope|incorrect)\b/.test(m)
  ) {
    return "negative";
  }
  return null;
}

export function isFeedbackMessage(message: string): boolean {
  return parseOwnerFeedback(message) !== null;
}

export class OwnerFeedbackMemory {
  private mem: OwnerFeedbackFile;

  constructor() {
    this.mem = loadFile();
  }

  get enabled(): boolean {
    return process.env.MC_OWNER_FEEDBACK !== "false";
  }

  setLastAction(
    ownerMessage: string,
    turn: McTurnResult,
    ok: boolean
  ): void {
    if (!this.enabled) {
      return;
    }
    this.mem.lastAction = {
      ownerMessage: ownerMessage.trim().slice(0, 200),
      lunaSay: turn.say.slice(0, 200),
      task: turn.task,
      move: turn.move,
      craftItem: turn.craftItem,
      goal: goalFromTurn(turn),
      ok,
      at: Date.now()
    };
    saveFile(this.mem);
  }

  applyFeedback(
    polarity: FeedbackPolarity,
    rl: GameplayRL,
    skills: SurvivalSkills
  ): { say: string; note: string } {
    const last = this.mem.lastAction;
    if (!last) {
      return {
        say:
          polarity === "positive"
            ? "Thanks! Tell me what to do next and I'll remember it."
            : "Sorry — what should I do differently?",
        note: ""
      };
    }

    const goal = last.goal;
    const label = describeAction(last);
    let note = "";

    if (polarity === "positive") {
      if (goal) {
        rl.ownerAdjustGoal(goal, 2.5);
        skills.applyOwnerFeedback(goal, true, `Owner praised: ${label}`);
      }
      this.upsertPattern(last, +1);
      note = `Owner liked: ${label} (after "${last.ownerMessage.slice(0, 50)}")`;
      this.pushNote(note);
      saveFile(this.mem);
      return {
        say: last.ok
          ? `Thanks! I'll remember how to ${label} when you ask like that.`
          : `Thanks — I'll try ${label} better next time.`,
        note
      };
    }

    if (goal) {
      rl.ownerAdjustGoal(goal, -2.5);
      skills.applyOwnerFeedback(goal, false, `Owner corrected: ${label}`);
    }
    this.upsertPattern(last, -2);
    note = `Owner disliked: ${label}`;
    this.pushNote(note);
    saveFile(this.mem);
    return {
      say: `Got it — I won't do it that way. What should I do instead?`,
      note
    };
  }

  private upsertPattern(last: LastOwnerAction, delta: number): void {
    const triggers = extractTriggers(last.ownerMessage);
    if (triggers.length < 1) {
      return;
    }
    const id = patternKey(triggers, last.task, last.craftItem);
    let p = this.mem.patterns.find((x) => x.id === id);
    if (!p) {
      p = {
        id,
        triggers,
        task: last.task,
        move: last.move,
        craftItem: last.craftItem,
        score: 0,
        successes: 0,
        failures: 0,
        lastUsed: Date.now()
      };
      this.mem.patterns.unshift(p);
    }
    p.score += delta;
    p.lastUsed = Date.now();
    if (delta > 0) {
      p.successes += 1;
    } else {
      p.failures += 1;
    }
    this.mem.patterns.sort((a, b) => b.score - a.score);
    this.mem.patterns = this.mem.patterns.filter((x) => x.score > -4).slice(0, MAX_PATTERNS);
  }

  private pushNote(note: string): void {
    this.mem.ownerNotes.push(note);
    while (this.mem.ownerNotes.length > MAX_NOTES) {
      this.mem.ownerNotes.shift();
    }
  }

  /** Match a praised pattern from past owner phrasing. */
  matchLearnedPattern(message: string): McTurnResult | null {
    if (!this.enabled || this.mem.patterns.length === 0) {
      return null;
    }
    const m = message.toLowerCase();
    if (
      /\?/.test(m) ||
      /\b(what do you mean|what are you doing|tell me what|how are you|why are you|help me fight|fight for me)\b/.test(
        m
      )
    ) {
      return null;
    }
    let best: LearnedOwnerPattern | null = null;
    let bestHits = 0;

    for (const p of this.mem.patterns) {
      if (p.score < 1) {
        continue;
      }
      const hits = p.triggers.filter((t) => t.length > 3 && m.includes(t)).length;
      if (hits >= 3 && hits > bestHits) {
        bestHits = hits;
        best = p;
      }
    }

    if (!best) {
      return null;
    }
    best.lastUsed = Date.now();
    saveFile(this.mem);

    const craftItem = best.craftItem as CraftableItem | undefined;
    const taskLabel = best.task.replace(/_/g, " ");
    return {
      say: `Sure — I'll ${taskLabel} like last time!`,
      move: best.move,
      lookAt: best.move !== "none" ? "owner" : "none",
      task: craftItem ? "none" : best.task,
      craftItem,
      equip: "none"
    };
  }

  summaryForPrompt(): string {
    if (!this.enabled) {
      return "";
    }
    const top = this.mem.patterns
      .filter((p) => p.score > 0)
      .slice(0, 4)
      .map((p) => `"${p.triggers.slice(0, 3).join(" ")}"→${p.task}${p.craftItem ? `(${p.craftItem})` : ""}`)
      .join("; ");

    const notes = this.mem.ownerNotes.slice(-3).join(" | ");
    const parts: string[] = [];
    if (top) {
      parts.push(`Owner-approved phrases: ${top}.`);
    }
    if (notes) {
      parts.push(`Owner feedback notes: ${notes}.`);
    }
    if (!parts.length) {
      return "Owner feedback memory: praise/correct me with good job or bad job — I link it to my last action.";
    }
    return parts.join(" ");
  }
}

function describeAction(last: LastOwnerAction): string {
  if (last.craftItem) {
    return `craft ${last.craftItem}`;
  }
  if (last.task !== "none") {
    return last.task.replace(/_/g, " ");
  }
  if (last.move !== "none") {
    return last.move.replace(/_/g, " ");
  }
  return "that";
}
