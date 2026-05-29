import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ollamaChat } from "./ollama";
import { SurvivalGoal } from "./survival-skills";

export type TutorialLesson = {
  id: string;
  topic: string;
  source: string;
  sourceUrl: string;
  lesson: string;
  learnedAt: number;
  trigger?: string;
};

type TutorialMemoryFile = {
  version: 1;
  lessons: TutorialLesson[];
  lastStudiedAt: Record<string, number>;
};

const DEFAULT_FILE = "data/tutorial_learnings.json";
const MAX_LESSONS = 40;
const WIKI_API = "https://minecraft.wiki/api.php";

/** Curated wiki pages — reliable survival tutorials. */
const WIKI_TUTORIALS: Record<string, { title: string; label: string }> = {
  crafting_basics: { title: "Crafting", label: "how crafting & recipes work" },
  wood_tools: { title: "Tutorial:Beginner's_guide", label: "first-day wood and tools" },
  stone_mining: { title: "Mining", label: "mining stone and ores" },
  coal_torches: { title: "Torch", label: "torches and lighting" },
  combat: { title: "Combat", label: "fighting hostile mobs" },
  food: { title: "Food", label: "hunger and eating" },
  building_shelter: { title: "Tutorial:Survival", label: "survival shelter basics" },
  stuck_movement: { title: "Tutorial:Navigation", label: "getting unstuck and pathing" },
  craft_table_missing: { title: "Crafting_table", label: "crafting table setup" },
  furnace_smelt: { title: "Smelting", label: "furnace and smelting" },
  chest_storage: { title: "Chest", label: "storage chests" },
  pickaxe: { title: "Pickaxe", label: "pickaxe tiers and use" }
};

function memoryPath(): string {
  return process.env.MC_TUTORIAL_MEMORY_FILE ?? DEFAULT_FILE;
}

function loadMemory(): TutorialMemoryFile {
  try {
    const raw = readFileSync(memoryPath(), "utf-8");
    const parsed = JSON.parse(raw) as TutorialMemoryFile;
    if (parsed?.version === 1 && Array.isArray(parsed.lessons)) {
      return parsed;
    }
  } catch {
    // no file
  }
  return { version: 1, lessons: [], lastStudiedAt: {} };
}

function saveMemory(mem: TutorialMemoryFile): void {
  try {
    mkdirSync(dirname(memoryPath()), { recursive: true });
    writeFileSync(memoryPath(), JSON.stringify(mem, null, 2), "utf-8");
  } catch {
    // best effort
  }
}

function topicFromFailure(goal: SurvivalGoal | string, reason?: string): string | null {
  const r = (reason ?? "").toLowerCase();
  const g = String(goal).toLowerCase();

  if (/crafting table|place a crafting|no crafting/.test(r)) {
    return "craft_table_missing";
  }
  if (/stuck|pathfinding|timeout|unreachable|no path/.test(r)) {
    return "stuck_movement";
  }
  if (g.includes("craft") || /not enough materials|recipe|planks|sticks/.test(r)) {
    return "crafting_basics";
  }
  if (g.includes("gather_wood") || /log|tree|chop/.test(r)) {
    return "wood_tools";
  }
  if (g.includes("gather_stone") || /cobble|mine stone/.test(r)) {
    return "stone_mining";
  }
  if (g.includes("gather_coal") || /coal/.test(r)) {
    return "coal_torches";
  }
  if (g.includes("fight") || /hostile|zombie|creeper|sword/.test(r)) {
    return "combat";
  }
  if (/food|hunger|eat/.test(r)) {
    return "food";
  }
  if (g.includes("deposit") || /chest/.test(r)) {
    return "chest_storage";
  }
  if (/furnace|smelt|iron/.test(r)) {
    return "furnace_smelt";
  }
  if (g.includes("craft_survival") || /torch|shelter|build/.test(r)) {
    return "building_shelter";
  }
  if (g.includes("gather") && /pickaxe/.test(r)) {
    return "pickaxe";
  }
  return null;
}

async function searchWikiTitle(query: string): Promise<string | null> {
  const url =
    `${WIKI_API}?action=opensearch&search=${encodeURIComponent(query)}` +
    "&limit=1&namespace=0&format=json";
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(12_000) });
    if (!res.ok) {
      return null;
    }
    const data = (await res.json()) as [string, string[], string[], string[]];
    return data[1]?.[0] ?? null;
  } catch {
    return null;
  }
}

async function fetchWikiExtract(title: string): Promise<{ text: string; url: string } | null> {
  const pageUrl = `https://minecraft.wiki/w/${encodeURIComponent(title.replace(/ /g, "_"))}`;
  const apiUrl =
    `${WIKI_API}?action=query&prop=extracts&exintro=&explaintext=1&titles=${encodeURIComponent(title)}&format=json`;
  try {
    const res = await fetch(apiUrl, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      return null;
    }
    const data = (await res.json()) as {
      query?: { pages?: Record<string, { extract?: string; title?: string }> };
    };
    const pages = data.query?.pages ?? {};
    const page = Object.values(pages)[0];
    const extract = page?.extract?.trim();
    if (!extract) {
      return null;
    }
    return { text: extract.slice(0, 4500), url: pageUrl };
  } catch {
    return null;
  }
}

export function shouldStudyAfterStreak(streakFail: number): boolean {
  const min = Number(process.env.MC_AI_TUTORIAL_STREAK ?? "2") || 2;
  return streakFail >= min;
}

/** Owner chat to Luna — not a wiki lookup. */
export function shouldStudyWikiFromOwnerMessage(question: string): boolean {
  const q = question.trim().toLowerCase();
  if (q.length < 10) {
    return false;
  }
  if (
    /\b(your inventory|what do you have|what are you carrying|did i give you|what did i give|hotbar|what did you get)\b/.test(
      q
    )
  ) {
    return false;
  }
  if (/\b(behind you|in front of you|crafting table behind|look behind|you have a)\b/.test(q)) {
    return false;
  }
  if (
    /\b(what are you (doing|looking at|up to)|how are you|what do you see|who are you|hello|hey luna|hi luna)\b/.test(
      q
    ) &&
    !/\b(craft|make|build|mine|gather|recipe|tutorial)\b/.test(q)
  ) {
    return false;
  }
  if (/\b(how do i|how to|how can i|tutorial|recipe for|best way to|step by step)\b/.test(q)) {
    return true;
  }
  if (/\b(how|why)\b/.test(q) && /\b(craft|mine|build|survive|enchant|smelt|farm|nether|village)\b/.test(q)) {
    return true;
  }
  if (/\b(what is|what's|whats)\b/.test(q) && /\b(recipe|crafting|smelting|enchant)\b/.test(q)) {
    return true;
  }
  return false;
}

export class TutorialLearner {
  private mem: TutorialMemoryFile;
  private studying = false;

  constructor() {
    this.mem = loadMemory();
  }

  get enabled(): boolean {
    return process.env.MC_AI_TUTORIALS !== "false";
  }

  summaryForPrompt(): string {
    if (!this.enabled || this.mem.lessons.length === 0) {
      return "";
    }
    const recent = [...this.mem.lessons]
      .sort((a, b) => b.learnedAt - a.learnedAt)
      .slice(0, 3)
      .map((l) => `${l.topic}: ${l.lesson.slice(0, 90)}`);
    return `Tutorial lessons studied: ${recent.join(" | ")}`;
  }

  getLessonForTopic(topic: string): TutorialLesson | undefined {
    return this.mem.lessons.find((l) => l.topic === topic);
  }

  /** When stuck or failing repeatedly — study a wiki tutorial asynchronously. */
  maybeStudyFromFailure(
    goal: SurvivalGoal | string,
    reason: string | undefined,
    ollamaHost: string,
    model: string,
    onLearned?: () => void
  ): void {
    if (!this.enabled || this.studying) {
      return;
    }
    const topic = topicFromFailure(goal, reason);
    if (!topic) {
      return;
    }
    const cooldownMs = Number(process.env.MC_AI_TUTORIAL_COOLDOWN_MS ?? "120000") || 120_000;
    const last = this.mem.lastStudiedAt[topic] ?? 0;
    if (Date.now() - last < cooldownMs) {
      return;
    }
    void this.watchTutorial(topic, `${goal}: ${reason ?? "failed"}`, ollamaHost, model).then(() => {
      onLearned?.();
    });
  }

  maybeStudyFromQuestion(
    question: string,
    ollamaHost: string,
    model: string,
    onLearned?: () => void
  ): void {
    if (!this.enabled || this.studying) {
      return;
    }
    if (!shouldStudyWikiFromOwnerMessage(question)) {
      return;
    }
    const q = question.trim().toLowerCase();
    const topicKey = `q:${q.slice(0, 48)}`;
    const cooldownMs = Number(process.env.MC_AI_TUTORIAL_COOLDOWN_MS ?? "120000") || 120_000;
    if (Date.now() - (this.mem.lastStudiedAt[topicKey] ?? 0) < cooldownMs) {
      return;
    }
    void this.watchTutorialSearch(q, topicKey, ollamaHost, model).then(() => {
      onLearned?.();
    });
  }

  private async watchTutorialSearch(
    query: string,
    topicKey: string,
    ollamaHost: string,
    model: string
  ): Promise<void> {
    this.studying = true;
    try {
      console.log(`[tutorial] searching wiki: "${query.slice(0, 60)}"…`);
      const title =
        (await searchWikiTitle(`minecraft ${query}`)) ??
        (await searchWikiTitle(query)) ??
        WIKI_TUTORIALS.wood_tools!.title;
      await this.studyPage(title, topicKey, `question: ${query}`, ollamaHost, model);
    } finally {
      this.studying = false;
    }
  }

  async watchTutorial(
    topic: string,
    trigger: string,
    ollamaHost: string,
    model: string
  ): Promise<string | null> {
    if (!this.enabled) {
      return null;
    }
    this.studying = true;
    try {
      const curated = WIKI_TUTORIALS[topic];
      const title = curated?.title ?? (await searchWikiTitle(`minecraft ${topic}`)) ?? topic;
      console.log(
        `[tutorial] studying${curated ? ` ${curated.label}` : ""}: ${title} (minecraft.wiki)…`
      );
      return await this.studyPage(title, topic, trigger, ollamaHost, model);
    } finally {
      this.studying = false;
    }
  }

  private async studyPage(
    title: string,
    topic: string,
    trigger: string,
    ollamaHost: string,
    model: string
  ): Promise<string | null> {
    this.mem.lastStudiedAt[topic] = Date.now();

    const existing = this.getLessonForTopic(topic);
    if (existing && Date.now() - existing.learnedAt < 3600_000) {
      console.log(`[tutorial] already studied ${topic} recently`);
      return existing.lesson;
    }

    const page = await fetchWikiExtract(title);
    if (!page) {
      console.log(`[tutorial] could not fetch wiki page: ${title}`);
      return null;
    }

    let lesson: string;
    try {
      lesson = await ollamaChat({
        host: ollamaHost,
        model,
        messages: [
          {
            role: "system",
            content:
              "You teach Minecraft survival to an AI bot. Summarize the wiki into 2-3 short actionable steps she can follow in-game. Plain text only, max 200 chars."
          },
          {
            role: "user",
            content: `Situation: ${trigger}\n\nWiki (${title}):\n${page.text}\n\nWhat should she do differently?`
          }
        ],
        numPredict: 120,
        temperature: 0.35
      });
      lesson = lesson.trim().replace(/\s+/g, " ").slice(0, 220);
    } catch {
      lesson = page.text.slice(0, 180).replace(/\s+/g, " ");
    }

    if (!lesson) {
      return null;
    }

    const entry: TutorialLesson = {
      id: `${topic}:${Date.now()}`,
      topic,
      source: title,
      sourceUrl: page.url,
      lesson,
      learnedAt: Date.now(),
      trigger
    };
    this.mem.lessons.unshift(entry);
    while (this.mem.lessons.length > MAX_LESSONS) {
      this.mem.lessons.pop();
    }
    saveMemory(this.mem);

    console.log(`[tutorial] learned: ${lesson}`);
    console.log(`[tutorial] source: ${page.url}`);
    return lesson;
  }
}
