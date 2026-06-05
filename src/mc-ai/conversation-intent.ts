import { parseCraftItemRequest } from "./craft-requests";
import { parseOwnerTaskChain } from "./task-chains";
import {
  McTurnResult,
  MoveIntent,
  TaskIntent,
  heuristicEquip,
  heuristicHotbarSlot,
  heuristicMove,
  heuristicTask,
  heuristicVoiceSay,
  parseHuntTarget
} from "./actions";

/**
 * Rule-based natural language → intent (no LLM).
 * Fills gaps when the model fails or for common conversational phrasing.
 */
export function parseNaturalLanguageTurn(message: string): McTurnResult | null {
  const m = message.trim();
  if (!m || m.length > 400) {
    return null;
  }
  const lower = m.toLowerCase();

  const move = parseNaturalMove(lower) ?? heuristicMove(message);
  const craftItem = parseCraftItemRequest(message) ?? undefined;
  const huntTarget = parseHuntTarget(message) ?? undefined;
  const chain = parseOwnerTaskChain(message);
  let task = chain[0] ?? parseNaturalTask(lower) ?? heuristicTask(message);

  if (craftItem || huntTarget) {
    task = "none";
  }

  const hasIntent =
    move !== "none" ||
    task !== "none" ||
    chain.length > 0 ||
    Boolean(craftItem) ||
    Boolean(huntTarget) ||
    isConversationalQuery(lower);

  if (!hasIntent) {
    return null;
  }

  const say = isConversationalQuery(lower) ? heuristicVoiceSay(message) : "";

  return {
    say,
    move,
    lookAt: move !== "none" ? "owner" : "none",
    task,
    equip: heuristicEquip(message),
    hotbarSlot: heuristicHotbarSlot(message),
    craftItem,
    taskTarget: huntTarget
  };
}

function isConversationalQuery(lower: string): boolean {
  return /\b(what are you|what're you|how are you|can you hear|are you ok|who are you|what do you see)\b/.test(
    lower
  );
}

function parseNaturalMove(lower: string): MoveIntent | null {
  if (/\b(stay here|wait here|hold position|don't move|do not move)\b/.test(lower)) {
    return "stop";
  }
  if (/\b(teleport|warp|tp)\b.*\b(me|here|us)\b/.test(lower)) {
    return "teleport_to_owner";
  }
  if (/\b(stick with|stay with|keep up with|walk with)\b/.test(lower)) {
    return "follow_owner";
  }
  if (/\b(come (over|here|back)|get over here|come closer|join me|where are you)\b/.test(lower)) {
    return "come_to_owner";
  }
  return null;
}

function parseNaturalTask(lower: string): TaskIntent | null {
  if (/\b(we need|i need|get us|grab us|could use|can you get).{0,40}\b(wood|logs|trees)\b/.test(lower)) {
    return "gather_wood";
  }
  if (/\b(we need|i need|get|mine|dig).{0,40}\b(coal)\b/.test(lower)) {
    return "gather_coal";
  }
  if (/\b(we need|i need|get|mine).{0,40}\b(stone|cobble)\b/.test(lower)) {
    return "gather_stone";
  }
  if (/\b(go (?:and )?)?(chop|cut|gather|collect|farm).{0,30}\b(trees?|wood|logs?)\b/.test(lower)) {
    return "gather_wood";
  }
  if (/\b(go (?:and )?)?(mine|dig|gather).{0,30}\b(coal)\b/.test(lower)) {
    return "gather_coal";
  }
  if (/\b(make|craft|build|create).{0,25}\b(tools?|pickaxe|sword|axe)\b/.test(lower)) {
    return "craft_tools";
  }
  if (/\b(make|craft|place|put).{0,30}\b(torches?|shelter|workbench|table)\b/.test(lower)) {
    return "craft_survival";
  }
  if (/\b(stash|store|put away|deposit|dump).{0,30}\b(chest|inventory|stuff)\b/.test(lower)) {
    return "deposit_chest";
  }
  if (/\b(defend|protect|clear|kill|fight).{0,40}\b(zombies?|mobs?|creepers?|monsters?|hostiles?)\b/.test(lower)) {
    return "fight_mobs";
  }
  if (/\b(tonight|before dark|getting dark).{0,30}\b(wood|tools|shelter)\b/.test(lower)) {
    return "gather_wood";
  }
  return null;
}

/** Merge NL parse into an LLM turn without overriding explicit LLM choices. */
export function mergeNaturalLanguageIntoTurn(
  turn: McTurnResult,
  message: string
): McTurnResult {
  const nl = parseNaturalLanguageTurn(message);
  if (!nl) {
    return turn;
  }
  return {
    say: turn.say || nl.say,
    move: turn.move === "none" ? nl.move : turn.move,
    lookAt: turn.lookAt === "none" && nl.lookAt !== "none" ? nl.lookAt : turn.lookAt,
    task: turn.task === "none" ? nl.task : turn.task,
    taskAmount: turn.taskAmount ?? nl.taskAmount,
    equip: turn.equip === "none" || !turn.equip ? nl.equip : turn.equip,
    hotbarSlot: turn.hotbarSlot ?? nl.hotbarSlot,
    craftItem: turn.craftItem ?? nl.craftItem,
    taskTarget: turn.taskTarget ?? nl.taskTarget
  };
}
