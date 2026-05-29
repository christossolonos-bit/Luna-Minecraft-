import { CompanionAction, CompanionState, Vec3 } from "../types";
import {
  craftCommandSay,
  checkCraftMaterials,
  parseCraftItemRequest
} from "./craft-requests";
import {
  asksAboutInventory,
  isOwnerDirectQuestion,
  resolveDirectOwnerQuestion
} from "./owner-questions";

export { asksAboutInventory, isOwnerDirectQuestion, resolveDirectOwnerQuestion };
export {
  resolveSpatialAwarenessTurn,
  applySpatialAwarenessToTurn,
  parseSpatialOwnerHint
} from "./spatial-hints";

export type MoveIntent = "none" | "come_to_owner" | "follow_owner" | "stop" | "teleport_to_owner";
export type LookIntent = "owner" | "none";
export type TaskIntent =
  | "none"
  | "gather_wood"
  | "gather_stone"
  | "gather_coal"
  | "craft_tools"
  | "craft_survival"
  | "deposit_chest"
  | "fight_mobs"
  | "hunt_animal";

export type EquipIntent = "none" | "sword" | "pickaxe" | "axe" | "shovel";

export type McTurnResult = {
  say: string;
  move: MoveIntent;
  lookAt: LookIntent;
  task: TaskIntent;
  taskAmount?: number;
  equip?: EquipIntent;
  /** Hotbar UI slot 1–9 to select */
  hotbarSlot?: number;
  /** Direct craft request (bed, chest, etc.) — bypasses vague LLM task picks */
  craftItem?: string;
  /** Species for hunt_animal, e.g. cow */
  taskTarget?: string;
};

export function parseTurnResponse(raw: string, userMessage: string): McTurnResult {
  const trimmed = raw.trim();
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const data = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
      if ("role" in data && typeof data.say !== "string") {
        throw new Error("chat API shape, not Luna turn JSON");
      }
      if ("action" in data && typeof data.say !== "string") {
        throw new Error("wrong action schema, not Luna turn JSON");
      }
      if ("type" in data && (data.type === "chat" || data.type === "break_block")) {
        throw new Error("wrong type schema, not Luna turn JSON");
      }
      const sayRaw = data.say;
      const say =
        typeof sayRaw === "string"
          ? sayRaw.trim()
          : typeof data.thought === "string"
            ? String(data.thought).trim().slice(0, 200)
            : "";
      if (!say || /^\{"role"\s*:/.test(say)) {
        throw new Error("missing or invalid say field");
      }
      const hunt = parseHuntTarget(userMessage);
      return {
        say: say || "Okay!",
        move: normalizeMove(data.move) ?? heuristicMove(userMessage),
        lookAt: normalizeLook(data.look_at ?? data.lookAt),
        task: normalizeTask(data.task) ?? heuristicTask(userMessage),
        taskAmount: (data.task_amount ?? data.taskAmount) as number | undefined,
        equip: normalizeEquip(data.equip) ?? heuristicEquip(userMessage),
        hotbarSlot: (data.hotbar_slot ?? data.hotbarSlot ?? heuristicHotbarSlot(userMessage)) as
          | number
          | undefined,
        taskTarget: hunt ?? undefined
      };
    } catch {
      // fall through
    }
  }
  const task = heuristicTask(userMessage);
  const huntTarget = parseHuntTarget(userMessage) ?? undefined;
  return {
    say: trimmed.replace(/^```[\s\S]*?```/g, "").trim() || "Got it.",
    move: heuristicMove(userMessage),
    lookAt: heuristicMove(userMessage) !== "none" ? "owner" : "none",
    task,
    equip: heuristicEquip(userMessage),
    hotbarSlot: heuristicHotbarSlot(userMessage),
    taskTarget: huntTarget
  };
}

function normalizeMove(value: unknown): MoveIntent | null {
  const v = String(value ?? "").toLowerCase();
  if (v === "come_to_owner" || v === "come") return "come_to_owner";
  if (v === "follow_owner" || v === "follow") return "follow_owner";
  if (v === "stop" || v === "stay") return "stop";
  if (v === "teleport_to_owner" || v === "teleport") return "teleport_to_owner";
  if (v === "none" || v === "") return "none";
  return null;
}

function normalizeLook(value: unknown): LookIntent {
  const v = String(value ?? "").toLowerCase();
  return v === "owner" ? "owner" : "none";
}

function normalizeTask(value: unknown): TaskIntent | null {
  const v = String(value ?? "").toLowerCase();
  if (v === "gather_wood" || v === "wood" || v === "chop_wood") return "gather_wood";
  if (v === "gather_stone" || v === "stone" || v === "mine_stone") return "gather_stone";
  if (v === "gather_coal" || v === "coal" || v === "mine_coal") return "gather_coal";
  if (v === "craft_tools" || v === "craft") return "craft_tools";
  if (v === "craft_survival" || v === "survival_gear" || v === "craft_gear") return "craft_survival";
  if (v === "deposit_chest" || v === "deposit") return "deposit_chest";
  if (v === "fight_mobs" || v === "fight" || v === "combat") return "fight_mobs";
  if (v === "hunt_animal" || v === "hunt" || v === "hunt_mob") return "hunt_animal";
  if (v === "none" || v === "") return "none";
  return null;
}

function normalizeEquip(value: unknown): EquipIntent | null {
  const v = String(value ?? "").toLowerCase();
  if (v === "sword") return "sword";
  if (v === "pickaxe" || v === "pick") return "pickaxe";
  if (v === "axe") return "axe";
  if (v === "shovel") return "shovel";
  if (v === "none" || v === "") return "none";
  return null;
}

export function heuristicEquip(message: string): EquipIntent {
  const m = message.toLowerCase();
  if (/\b(equip|use|hold|switch to|select)\b.*\b(sword)\b/.test(m)) return "sword";
  if (/\b(equip|use|hold|switch to|select)\b.*\b(pickaxe|pick)\b/.test(m)) return "pickaxe";
  if (/\b(equip|use|hold|switch to|select)\b.*\b(axe)\b/.test(m)) return "axe";
  if (/\b(equip|use|hold|switch to|select)\b.*\b(shovel)\b/.test(m)) return "shovel";
  return "none";
}

export function heuristicHotbarSlot(message: string): number | undefined {
  const m = message.toLowerCase();
  const slotMatch = m.match(/\b(?:hotbar|slot|bar)\s*#?(\d)\b/) ?? m.match(/\bselect\s+(\d)\b/);
  if (slotMatch?.[1]) {
    const n = Number(slotMatch[1]);
    if (n >= 1 && n <= 9) {
      return n;
    }
  }
  return undefined;
}

/** Small talk — answer in chat only; do not equip, move, or start tasks. */
export function isCasualQuestion(message: string): boolean {
  const m = message.trim().toLowerCase();
  if (m.length < 4) {
    return false;
  }
  if (
    /\b(come here|follow me|stop|teleport|tp to|chop|mine|gather|craft|make a|build a|fight|kill|hunt|attack|equip|hotbar|slot \d)\b/.test(
      m
    )
  ) {
    return false;
  }
  return /\b(what are you (doing|looking at|up to)|how are you|what do you see|who are you|tell me about yourself|are you ok|are you okay|what's wrong|whats wrong|why are you stuck|hello|hi luna|hey luna)\b/.test(
    m
  );
}

/** Strip game actions when the owner is just chatting. */
export function stripConversationalActions(turn: McTurnResult, message: string): McTurnResult {
  if (!isCasualQuestion(message)) {
    return turn;
  }
  return {
    ...turn,
    move: "none",
    task: "none",
    equip: "none",
    hotbarSlot: undefined,
    craftItem: undefined,
    lookAt: "owner"
  };
}

export function heuristicMove(message: string): MoveIntent {
  const m = message.toLowerCase();
  if (/\b(stop|stay there|wait here|don't move|dont move|hold)\b/.test(m)) {
    return "stop";
  }
  if (/\b(teleport to me|tp to me|teleport here|warp to me|teleport to)\b/.test(m)) {
    return "teleport_to_owner";
  }
  if (/\b(tp|teleport)\b.*\b(solonaras|me|owner)\b/.test(m)) {
    return "teleport_to_owner";
  }
  if (/\b(follow me|stay with me|stick with me|keep following)\b/.test(m)) {
    return "follow_owner";
  }
  if (
    /\b(come here|come to me|get over here|come closer|where are you|walk over|get here)\b/.test(
      m
    )
  ) {
    return "come_to_owner";
  }
  return "none";
}

export const HUNT_ANIMALS = ["cow", "pig", "sheep", "chicken", "mooshroom", "rabbit", "goat"] as const;

export function parseHuntTarget(message: string): string | null {
  const m = message.toLowerCase();
  for (const animal of HUNT_ANIMALS) {
    if (
      new RegExp(`\\b(kill|attack|slaughter|hunt|get)\\b(?:\\s+the)?\\s+${animal}s?\\b`).test(m) ||
      new RegExp(`\\b${animal}s?\\b.*\\b(kill|attack|hunt)\\b`).test(m)
    ) {
      return animal;
    }
  }
  if (/\b(kill|attack|hunt)\b.*\b(the\s+)?(cow|animal|livestock)\b/.test(m)) {
    return "cow";
  }
  return null;
}

export function resolveDirectHuntTurn(
  message: string,
  state: CompanionState | null
): McTurnResult | null {
  const target = parseHuntTarget(message);
  if (!target) {
    return null;
  }
  const seen = state?.nearbyMobs?.filter(
    (mob) => !mob.hostile && mob.name.replace(/s$/, "") === target
  );
  const nearest = seen?.[0];
  if (nearest) {
    return {
      say: `On it — hunting the ${target} (${nearest.distance.toFixed(0)}m away)!`,
      move: "none",
      lookAt: "none",
      task: "hunt_animal",
      taskTarget: target
    };
  }
  return {
    say: `On it — I'll hunt the ${target}!`,
    move: "none",
    lookAt: "none",
    task: "hunt_animal",
    taskTarget: target
  };
}

export function heuristicTask(message: string): TaskIntent {
  const m = message.toLowerCase();
  const hunt = parseHuntTarget(message);
  if (hunt) {
    return "hunt_animal";
  }
  if (/\b(fight|kill|attack|defend)\b.*\b(zombie|mob|mobs|creeper|spider|skeleton|hostile)\b/.test(m)) {
    return "fight_mobs";
  }
  if (/\b(fight mobs|kill zombies|attack creeper|defend yourself|use your sword)\b/.test(m)) {
    return "fight_mobs";
  }
  if (/\b(deposit|put in chest|store in chest|empty inventory|stash)\b/.test(m)) {
    return "deposit_chest";
  }
  if (/\b(craft tools|make tools|craft a pick|make pickaxe|craft pickaxe|make sword|craft sword)\b/.test(m)) {
    return "craft_tools";
  }
  if (/\b(chop wood and craft|gather and craft|get wood then tools)\b/.test(m)) {
    return "gather_wood";
  }
  if (/\b(gather some|get some|chop some|mine some|collect some)\b/.test(m)) {
    if (/wood|tree|log/.test(m)) return "gather_wood";
    if (/stone|cobble/.test(m)) return "gather_stone";
  }
  if (/\b(chop wood|get wood|gather wood|collect wood|cut trees|chop trees|get trees|gather some wood)\b/.test(m)) {
    return "gather_wood";
  }
  if (/\b(mine stone|get stone|gather stone|collect stone|get cobble|cobblestone)\b/.test(m)) {
    return "gather_stone";
  }
  if (/\b(mine coal|get coal|gather coal|collect coal)\b/.test(m)) {
    return "gather_coal";
  }
  if (
    /\b(craft torches?|make torches?|craft armor|make armor|craft bread|survival gear|craft gear|make shield|craft furnace)\b/.test(
      m
    )
  ) {
    return "craft_survival";
  }
  if (/\b(gather resources|collect resources)\b/.test(m)) {
    return "gather_wood";
  }
  return "none";
}

export function resolveDirectCraftTurn(
  message: string,
  state: CompanionState | null
): McTurnResult | null {
  const item = parseCraftItemRequest(message);
  if (!item) {
    return null;
  }
  const check = checkCraftMaterials(state, item);
  return {
    say: craftCommandSay(message, state) ?? "On it!",
    move: "none",
    lookAt: "none",
    task: "none",
    craftItem: check.ok ? item : undefined
  };
}

export function focusTurnOnUserIntent(turn: McTurnResult, userMessage: string): McTurnResult {
  const userMove = heuristicMove(userMessage);
  const userTask = heuristicTask(userMessage);
  const userCraft = parseCraftItemRequest(userMessage);
  const focused = { ...turn };

  if (userCraft) {
    focused.task = "none";
    focused.move = userMove !== "none" ? userMove : "none";
    focused.lookAt = "none";
    focused.equip = "none";
    focused.hotbarSlot = undefined;
  } else if (parseHuntTarget(userMessage)) {
    focused.task = "hunt_animal";
    focused.taskTarget = parseHuntTarget(userMessage) ?? focused.taskTarget;
    focused.move = userMove !== "none" ? userMove : "none";
    if (userMove === "none") {
      focused.lookAt = "none";
    }
    focused.equip = "none";
    focused.hotbarSlot = undefined;
    focused.craftItem = undefined;
  } else if (asksAboutInventory(userMessage)) {
    focused.move = "none";
    focused.lookAt = "none";
    focused.task = "none";
    focused.equip = "none";
    focused.hotbarSlot = undefined;
  } else if (userTask !== "none" && userMove === "none" && !turn.hotbarSlot && (!turn.equip || turn.equip === "none")) {
    focused.move = "none";
    focused.lookAt = "none";
    focused.task = userTask;
  } else if (userMove !== "none" && userTask === "none") {
    focused.move = userMove;
    focused.task = "none";
  } else if (userTask !== "none") {
    focused.task = userTask;
    focused.move = userMove;
  }

  // Never follow while doing a gather/craft/fight task unless they literally said follow.
  if (focused.task !== "none" && focused.move === "follow_owner" && userMove !== "follow_owner") {
    focused.move = "none";
  }

  return focused;
}

/** Rule-based parse for voice/chat commands (no LLM). */
export function heuristicTurn(message: string): McTurnResult {
  const move = heuristicMove(message);
  const task = heuristicTask(message);
  const craftItem = parseCraftItemRequest(message) ?? undefined;
  const huntTarget = parseHuntTarget(message) ?? undefined;
  return {
    say: "",
    move,
    lookAt: move !== "none" ? "owner" : "none",
    task: craftItem || huntTarget ? "none" : task,
    equip: heuristicEquip(message),
    hotbarSlot: heuristicHotbarSlot(message),
    craftItem,
    taskTarget: huntTarget
  };
}

export function hasActionableCommand(message: string, turn?: McTurnResult): boolean {
  if (parseCraftItemRequest(message) || parseHuntTarget(message)) {
    return true;
  }
  if (asksAboutInventory(message)) {
    return true;
  }
  const t = turn ?? heuristicTurn(message);
  return (
    t.move !== "none" ||
    t.task !== "none" ||
    (t.equip !== undefined && t.equip !== "none") ||
    Boolean(t.hotbarSlot) ||
    Boolean(t.craftItem) ||
    Boolean(t.taskTarget)
  );
}

export function isTaskIntent(task: TaskIntent): boolean {
  return task !== "none";
}

export function ownerMoveTarget(state: CompanionState): Vec3 | null {
  const owner = state.owner;
  if (!owner) {
    return null;
  }
  const o = owner.position;
  const luna = state.player.position;
  const dx = luna.x - o.x;
  const dz = luna.z - o.z;
  const len = Math.hypot(dx, dz);
  if (len < 0.5) {
    return { x: Math.floor(o.x), y: Math.floor(o.y), z: Math.floor(o.z + 2) };
  }
  const standOff = 2;
  return {
    x: Math.floor(o.x + (dx / len) * standOff),
    y: Math.floor(o.y),
    z: Math.floor(o.z + (dz / len) * standOff)
  };
}

export function ownerLookTarget(state: CompanionState): Vec3 | null {
  const owner = state.owner;
  if (!owner) {
    return null;
  }
  return {
    x: owner.position.x,
    y: owner.position.y + 1.6,
    z: owner.position.z
  };
}

export function resolveActions(state: CompanionState | null, turn: McTurnResult): CompanionAction[] {
  if (!state) {
    return [];
  }
  const actions: CompanionAction[] = [];

  if (turn.move === "stop") {
    actions.push({ type: "stop_all" });
    return actions;
  }

  if (turn.move === "teleport_to_owner") {
    actions.push({ type: "teleport_to_owner" });
    return actions;
  }

  if (turn.hotbarSlot) {
    actions.push({ type: "equip_hotbar", slot: turn.hotbarSlot });
    return actions;
  }

  if (turn.equip && turn.equip !== "none") {
    actions.push({ type: "equip_tool", tool: turn.equip });
    return actions;
  }

  if (turn.craftItem) {
    actions.push({ type: "craft_item", item: turn.craftItem });
    return actions;
  }

  // Task first — don't path to owner before chopping/mining unless they only asked to come.
  if (turn.task !== "none") {
    if (turn.move === "come_to_owner") {
      const target = ownerMoveTarget(state);
      if (target) {
        actions.push({ type: "move_to", target, sprint: true });
      }
    }
    actions.push({
      type: "run_task",
      task: turn.task,
      amount: turn.taskAmount,
      target: turn.taskTarget
    });
    return actions;
  }

  if (turn.move === "come_to_owner" || turn.move === "follow_owner") {
    const target = ownerMoveTarget(state);
    if (target) {
      actions.push({ type: "move_to", target, sprint: true });
    }
  }

  if (turn.lookAt === "owner") {
    const target = ownerLookTarget(state);
    if (target) {
      actions.push({ type: "look_at", target });
    }
  }

  return actions;
}

export function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/**
 * Split "follow me, tp to me" into separate queued commands.
 * Long voice ramble stays one job.
 */
export function splitOwnerCommands(message: string): string[] {
  const trimmed = message.trim();
  if (!trimmed) {
    return [];
  }
  if (trimmed.length > 100) {
    return [trimmed];
  }

  const chunks = trimmed
    .split(/\s*(?:,|;|\band\b|\bthen\b)\s*/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (chunks.length <= 1) {
    return [trimmed];
  }

  const allShort = chunks.every((c) => c.length <= 40);
  const allCommands = chunks.every((c) => hasActionableCommand(c));
  if (allShort && allCommands && chunks.length <= 5) {
    return chunks;
  }
  return [trimmed];
}

export function suggestTaskChain(message: string): TaskIntent[] {
  const m = message.toLowerCase();
  if (/\b(gather everything|stock up|full routine|do everything)\b/.test(m)) {
    return ["gather_wood", "gather_stone", "gather_coal", "craft_tools", "craft_survival", "deposit_chest"];
  }
  if (/\b(gather wood and craft|chop trees and make tools)\b/.test(m)) {
    return ["gather_wood", "craft_tools"];
  }
  if (/\b(chop wood and put|gather and deposit|mine and store)\b/.test(m)) {
    const chain: TaskIntent[] = [];
    if (/wood|tree|log/.test(m)) chain.push("gather_wood");
    if (/stone|cobble/.test(m)) chain.push("gather_stone");
    chain.push("deposit_chest");
    return chain;
  }
  return [];
}
