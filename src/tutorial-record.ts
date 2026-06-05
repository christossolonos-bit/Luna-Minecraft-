import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { approachTrunk, findNearestTree, placeLogPillarStep } from "./bot-tree";
import { digBlockInReach, mineBlockReliably } from "./bot-gather";
import { equipToolCategory } from "./bot-inventory";
import { isSleepRoutineActive } from "./bot-sleep";
import { preferredStandColumn } from "./tree-knowledge";
import { ActionResult } from "./types";

export type RecordedStep =
  | {
      type: "break_block";
      block: string;
      pos: { x: number; y: number; z: number };
      at: number;
    }
  | {
      type: "place_block";
      block: string;
      pos: { x: number; y: number; z: number };
      at: number;
    }
  | {
      type: "look_up";
      at: number;
    }
  | {
      type: "owner_pos";
      pos: { x: number; y: number; z: number };
      at: number;
    };

/** What the owner demonstrated — applied to any tree, not one fixed location. */
export type TreeTutorialPattern = {
  clearLeaves: boolean;
  pillarClimb: boolean;
  lookUpWhileChopping: boolean;
  stepCount: number;
};

export type RecordedTutorial = {
  topic: string;
  recordedAt: number;
  /** Bottom of the demonstrated trunk — steps are offsets from here. */
  anchor: { x: number; y: number; z: number };
  pattern: TreeTutorialPattern;
  steps: RecordedStep[];
};

type TutorialMemoryFile = {
  version: 1;
  tutorials: Record<string, RecordedTutorial>;
};

const DEFAULT_FILE = "data/owner_tutorials.json";
const MAX_STEPS = 320;
const MAX_RECORD_MS = 600_000;
const POS_SAMPLE_MS = 2500;
const LOOK_UP_COOLDOWN_MS = 1800;
const LOOK_UP_PITCH = -0.35;

function memoryPath(): string {
  return process.env.MC_TUTORIAL_RECORD_FILE ?? DEFAULT_FILE;
}

function loadMemory(): TutorialMemoryFile {
  try {
    const raw = readFileSync(memoryPath(), "utf-8");
    const parsed = JSON.parse(raw) as TutorialMemoryFile;
    if (parsed?.version === 1 && parsed.tutorials) {
      for (const topic of Object.keys(parsed.tutorials)) {
        const t = parsed.tutorials[topic];
        if (t && !t.pattern) {
          t.pattern = inferPattern(t.steps);
        }
      }
      return parsed;
    }
  } catch {
    // no file
  }
  return { version: 1, tutorials: {} };
}

function saveMemory(mem: TutorialMemoryFile): void {
  try {
    mkdirSync(dirname(memoryPath()), { recursive: true });
    writeFileSync(memoryPath(), JSON.stringify(mem, null, 2), "utf-8");
  } catch {
    // best effort
  }
}

function isLogBlockName(name: string): boolean {
  return (
    name.endsWith("_log") ||
    name.endsWith("_stem") ||
    name === "crimson_stem" ||
    name === "warped_stem"
  );
}

function isLeafBlockName(name: string): boolean {
  return name.endsWith("_leaves") || name === "azalea_leaves" || name === "flowering_azalea_leaves";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isReplayStep(step: RecordedStep): boolean {
  if (step.type === "look_up") {
    return true;
  }
  if (step.type === "break_block") {
    return isLogBlockName(step.block) || isLeafBlockName(step.block);
  }
  if (step.type === "place_block") {
    return isLogBlockName(step.block);
  }
  return false;
}

function inferPattern(steps: RecordedStep[]): TreeTutorialPattern {
  const replayable = steps.filter(isReplayStep);
  return {
    clearLeaves: replayable.some(
      (s) => s.type === "break_block" && isLeafBlockName(s.block)
    ),
    pillarClimb: replayable.some((s) => s.type === "place_block"),
    lookUpWhileChopping: replayable.some((s) => s.type === "look_up"),
    stepCount: replayable.length
  };
}

function computeTutorialAnchor(steps: RecordedStep[]): { x: number; y: number; z: number } {
  const logBreaks = steps.filter(
    (s): s is Extract<RecordedStep, { type: "break_block" }> =>
      s.type === "break_block" && isLogBlockName(s.block)
  );
  if (logBreaks.length > 0) {
    const minY = Math.min(...logBreaks.map((s) => s.pos.y));
    const bottom = logBreaks.filter((s) => s.pos.y === minY);
    const x = Math.round(bottom.reduce((n, s) => n + s.pos.x, 0) / bottom.length);
    const z = Math.round(bottom.reduce((n, s) => n + s.pos.z, 0) / bottom.length);
    return { x, y: minY, z };
  }

  const places = steps.filter(
    (s): s is Extract<RecordedStep, { type: "place_block" }> => s.type === "place_block"
  );
  if (places.length > 0) {
    const p = places[0]!.pos;
    return { x: p.x, y: p.y - 1, z: p.z };
  }

  const owner = steps.find((s): s is Extract<RecordedStep, { type: "owner_pos" }> => s.type === "owner_pos");
  if (owner) {
    return {
      x: Math.floor(owner.pos.x),
      y: Math.floor(owner.pos.y) - 1,
      z: Math.floor(owner.pos.z)
    };
  }

  return { x: 0, y: 0, z: 0 };
}

/** Map a recorded step onto a new tree using offsets from each tree's trunk base. */
function resolveStepPos(
  recorded: { x: number; y: number; z: number },
  recordedAnchor: { x: number; y: number; z: number },
  targetBase: { x: number; y: number; z: number }
): Vec3 {
  return new Vec3(
    targetBase.x + (recorded.x - recordedAnchor.x),
    targetBase.y + (recorded.y - recordedAnchor.y),
    targetBase.z + (recorded.z - recordedAnchor.z)
  );
}

function findMatchingBlockNear(
  bot: Bot,
  center: Vec3,
  wantLog: boolean,
  wantLeaf: boolean
): Vec3 | null {
  if (wantLog) {
    for (let dy = 0; dy <= 2; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          const p = center.offset(dx, dy, dz);
          const b = bot.blockAt(p);
          if (b && isLogBlockName(b.name)) {
            return p;
          }
        }
      }
    }
  }
  if (wantLeaf) {
    for (const p of [center, center.offset(0, 1, 0), center.offset(1, 0, 0), center.offset(-1, 0, 0)]) {
      const b = bot.blockAt(p);
      if (b && isLeafBlockName(b.name)) {
        return p;
      }
    }
  }
  return null;
}

/** Watch the owner demonstrate a skill, save steps, replay on matching tasks. */
export class TutorialRecorder {
  private mem: TutorialMemoryFile;
  private active = false;
  private topic = "gather_wood";
  private steps: RecordedStep[] = [];
  private startedAt = 0;
  private lastPosSampleAt = 0;
  private lastLookUpAt = 0;

  constructor() {
    this.mem = loadMemory();
  }

  get isRecording(): boolean {
    return this.active;
  }

  get recordingTopic(): string {
    return this.topic;
  }

  hasTutorial(topic: string): boolean {
    const t = this.mem.tutorials[topic];
    return !!t && t.steps.some(isReplayStep);
  }

  getTutorial(topic: string): RecordedTutorial | undefined {
    return this.mem.tutorials[topic];
  }

  getPattern(topic = "gather_wood"): TreeTutorialPattern | null {
    const t = this.mem.tutorials[topic];
    if (!t) {
      return null;
    }
    return t.pattern ?? inferPattern(t.steps);
  }

  start(topic = "gather_wood"): { ok: boolean; reason: string } {
    if (this.active) {
      return { ok: false, reason: "Already recording — say end first." };
    }
    this.active = true;
    this.topic = topic;
    this.steps = [];
    this.startedAt = Date.now();
    this.lastPosSampleAt = 0;
    this.lastLookUpAt = 0;
    console.log(`[record] watching owner tutorial for "${topic}" — say end when done`);
    return {
      ok: true,
      reason:
        "Recording — chop trunk, clear leaves, place logs to climb, look up for more. Say end when done."
    };
  }

  stop(): { ok: boolean; reason: string; detail?: string } {
    if (!this.active) {
      return { ok: false, reason: "Not recording anything." };
    }

    const breaks = this.steps.filter((s) => s.type === "break_block");
    const logBreaks = breaks.filter((s) => isLogBlockName(s.block)).length;
    const leafBreaks = breaks.filter((s) => isLeafBlockName(s.block)).length;
    const places = this.steps.filter((s) => s.type === "place_block" && isLogBlockName(s.block)).length;
    const lookUps = this.steps.filter((s) => s.type === "look_up").length;

    if (logBreaks + leafBreaks + places === 0) {
      this.active = false;
      this.steps = [];
      return {
        ok: false,
        reason: "No tree steps recorded — chop trunk, clear leaves, or place logs while I watch."
      };
    }

    const anchor = computeTutorialAnchor(this.steps);
    const pattern = inferPattern(this.steps);
    const tutorial: RecordedTutorial = {
      topic: this.topic,
      recordedAt: Date.now(),
      anchor,
      pattern,
      steps: [...this.steps]
    };
    this.mem.tutorials[this.topic] = tutorial;
    saveMemory(this.mem);

    this.active = false;
    this.steps = [];

    const learned = [
      pattern.clearLeaves ? "clear leaves" : "",
      pattern.pillarClimb ? "pillar climb" : "",
      pattern.lookUpWhileChopping ? "look up" : ""
    ]
      .filter(Boolean)
      .join(", ");

    const msg =
      `Saved tutorial (${learned}) — ${logBreaks} log breaks, ${leafBreaks} leaves, ` +
      `${places} placements. I'll use this on other trees too.`;
    console.log(`[record] ${msg}`);
    return { ok: true, reason: msg, detail: `${logBreaks + leafBreaks + places}` };
  }

  noteOwnerBlockBreak(blockName: string, pos: { x: number; y: number; z: number }): void {
    if (!this.active || this.steps.length >= MAX_STEPS) {
      return;
    }
    if (Date.now() - this.startedAt > MAX_RECORD_MS) {
      console.log("[record] max duration reached — say end to save");
      return;
    }
    if (!isLogBlockName(blockName) && !isLeafBlockName(blockName)) {
      return;
    }
    this.steps.push({
      type: "break_block",
      block: blockName,
      pos: { x: pos.x, y: pos.y, z: pos.z },
      at: Date.now()
    });
    const kind = isLeafBlockName(blockName) ? "leaf" : "log";
    console.log(`[record] saw break ${kind} ${blockName} at (${pos.x},${pos.y},${pos.z})`);
  }

  noteOwnerBlockPlace(blockName: string, pos: { x: number; y: number; z: number }): void {
    if (!this.active || this.steps.length >= MAX_STEPS) {
      return;
    }
    if (!isLogBlockName(blockName)) {
      return;
    }
    this.steps.push({
      type: "place_block",
      block: blockName,
      pos: { x: pos.x, y: pos.y, z: pos.z },
      at: Date.now()
    });
    console.log(`[record] saw place log ${blockName} at (${pos.x},${pos.y},${pos.z})`);
  }

  noteOwnerLookUp(pitch: number): void {
    if (!this.active || this.steps.length >= MAX_STEPS) {
      return;
    }
    const now = Date.now();
    if (pitch > LOOK_UP_PITCH || now - this.lastLookUpAt < LOOK_UP_COOLDOWN_MS) {
      return;
    }
    this.lastLookUpAt = now;
    this.steps.push({ type: "look_up", at: now });
    console.log("[record] saw look up for higher logs");
  }

  noteOwnerPosition(pos: { x: number; y: number; z: number }): void {
    if (!this.active) {
      return;
    }
    const now = Date.now();
    if (now - this.lastPosSampleAt < POS_SAMPLE_MS) {
      return;
    }
    this.lastPosSampleAt = now;
    this.steps.push({
      type: "owner_pos",
      pos: { x: pos.x, y: pos.y, z: pos.z },
      at: now
    });
  }
}

let sharedRecorder: TutorialRecorder | null = null;

export function getTutorialRecorder(): TutorialRecorder {
  if (!sharedRecorder) {
    sharedRecorder = new TutorialRecorder();
  }
  return sharedRecorder;
}

/** Learned chop habits from the owner's recording — for any tree. */
export function getTreeTutorialPattern(): TreeTutorialPattern | null {
  return getTutorialRecorder().getPattern("gather_wood");
}

async function replayLookUp(bot: Bot): Promise<void> {
  const yaw = bot.entity.yaw;
  await bot.look(yaw, -Math.PI / 2.2, true);
  await delay(450);
}

async function replayPlaceLog(bot: Bot, pos: Vec3, blockName: string): Promise<boolean> {
  const logType =
    bot.inventory.items().find((i) => i.name === blockName)?.name ??
    bot.inventory.items().find((i) => isLogBlockName(i.name))?.name ??
    blockName;
  return placeLogPillarStep(bot, pos.x, pos.z, logType, [], undefined, pos.y);
}

async function replayBreakBlock(
  bot: Bot,
  pos: Vec3,
  blockName: string
): Promise<boolean> {
  let block = bot.blockAt(pos);
  const wantLog = isLogBlockName(blockName);
  const wantLeaf = isLeafBlockName(blockName);

  if (!block || block.name === "air") {
    const near = findMatchingBlockNear(bot, pos, wantLog, wantLeaf);
    if (!near) {
      return false;
    }
    block = bot.blockAt(near)!;
    pos = near;
  } else if (wantLog && !isLogBlockName(block.name)) {
    const near = findMatchingBlockNear(bot, pos, true, false);
    if (near) {
      block = bot.blockAt(near)!;
      pos = near;
    }
  } else if (wantLeaf && !isLeafBlockName(block.name)) {
    const near = findMatchingBlockNear(bot, pos, false, true);
    if (near) {
      block = bot.blockAt(near)!;
      pos = near;
    }
  }

  await equipToolCategory(bot, "axe");

  if (isLeafBlockName(block.name)) {
    try {
      await mineBlockReliably(bot, block, { tool: "axe", pathTimeoutMs: 12_000 });
      return true;
    } catch {
      try {
        await digBlockInReach(bot, block, { tool: "axe" });
        return true;
      } catch {
        return false;
      }
    }
  }

  if (!isLogBlockName(block.name)) {
    return false;
  }

  try {
    await mineBlockReliably(bot, block, { tool: "axe", pathTimeoutMs: 20_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Apply the owner's learned chop pattern to the nearest tree
 * (relative offsets from trunk base — works on different trees).
 */
export async function replayGatherWoodTutorial(
  bot: Bot,
  maxDistance: number,
  deadline: number
): Promise<ActionResult & { detail?: string }> {
  const recorder = getTutorialRecorder();
  const tutorial = recorder.getTutorial("gather_wood");
  if (!tutorial) {
    return { ok: false, action: "run_task", reason: "no tutorial" };
  }

  const tree = findNearestTree(bot, maxDistance);
  if (!tree) {
    return { ok: false, action: "run_task", reason: "no tree nearby for tutorial" };
  }

  const targetBase = preferredStandColumn(tree);
  const pattern = tutorial.pattern ?? inferPattern(tutorial.steps);
  const replaySteps = [...tutorial.steps].sort((a, b) => a.at - b.at).filter(isReplayStep);

  if (replaySteps.length === 0) {
    return { ok: false, action: "run_task", reason: "tutorial has no tree steps" };
  }

  console.log(
    `[record] applying learned pattern (${[
      pattern.clearLeaves ? "leaves" : "",
      pattern.pillarClimb ? "pillar" : "",
      pattern.lookUpWhileChopping ? "look-up" : ""
    ]
      .filter(Boolean)
      .join(", ")}) on ${tree.profile.label} at (${targetBase.x},${targetBase.y},${targetBase.z})`
  );

  await approachTrunk(bot, targetBase, targetBase.y);

  let done = 0;
  let skipped = 0;
  let lastAt = replaySteps[0]!.at;

  for (const step of replaySteps) {
    if (Date.now() >= deadline || isSleepRoutineActive()) {
      break;
    }

    const gap = Math.min(step.at - lastAt, 1200);
    if (gap > 80) {
      await delay(gap);
    }
    lastAt = step.at;

    if (step.type === "look_up") {
      await replayLookUp(bot);
      done += 1;
      continue;
    }

    const pos = resolveStepPos(step.pos, tutorial.anchor, targetBase);

    if (step.type === "break_block") {
      if (await replayBreakBlock(bot, pos, step.block)) {
        done += 1;
        const kind = isLeafBlockName(step.block) ? "leaf" : "log";
        console.log(`[record] pattern: broke ${kind} at (${pos.x},${pos.y},${pos.z})`);
      } else {
        skipped += 1;
      }
      continue;
    }

    if (step.type === "place_block") {
      if (await replayPlaceLog(bot, pos, step.block)) {
        done += 1;
        console.log(`[record] pattern: placed log at (${pos.x},${pos.y},${pos.z})`);
      } else {
        skipped += 1;
      }
    }
  }

  if (done === 0) {
    return {
      ok: false,
      action: "run_task",
      reason: `Learned pattern: no steps matched this tree (${skipped} skipped).`
    };
  }

  const msg = `Learned pattern on ${tree.profile.label}: ${done} step(s)${skipped > 0 ? `, ${skipped} skipped` : ""}.`;
  console.log(`[record] ${msg}`);
  return { ok: true, action: "run_task", reason: msg, detail: "tutorial_replay" };
}
