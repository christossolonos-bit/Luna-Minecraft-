import { TaskIntent } from "./actions";

/** Multi-step commands from natural language (no LLM). */
export function parseOwnerTaskChain(message: string): TaskIntent[] {
  const m = message.toLowerCase().trim();
  if (!m) {
    return [];
  }

  if (/\b(full routine|stock up|survival routine|do everything|gear up fully)\b/.test(m)) {
    return ["gather_wood", "craft_tools", "gather_stone", "gather_coal", "craft_survival", "deposit_chest"];
  }

  if (/\b(early game|starter kit|start survival|begin survival)\b/.test(m)) {
    return ["gather_wood", "craft_tools", "gather_stone", "gather_coal", "craft_survival"];
  }

  const chain: TaskIntent[] = [];

  const add = (task: TaskIntent) => {
    if (task !== "none" && !chain.includes(task)) {
      chain.push(task);
    }
  };

  if (/\b(wood|trees?|logs?)\b/.test(m)) {
    add("gather_wood");
  }
  if (/\b(stone|cobble)\b/.test(m)) {
    add("gather_stone");
  }
  if (/\b(coal)\b/.test(m)) {
    add("gather_coal");
  }
  if (/\b(tools?|pickaxe|sword|axe)\b/.test(m)) {
    add("craft_tools");
  }
  if (/\b(torches?|armor|bread|furnace|gear|survival)\b/.test(m)) {
    add("craft_survival");
  }
  if (/\b(chest|deposit|stash|store)\b/.test(m)) {
    add("deposit_chest");
  }
  if (/\b(fight|zombies?|mobs?|hostiles?|defend)\b/.test(m)) {
    add("fight_mobs");
  }

  const hasThen =
    /\b(then|and then|after that|next|afterwards)\b/.test(m) ||
    (m.includes(",") && chain.length > 0);

  if (hasThen && chain.length >= 2) {
    return chain.slice(0, 6);
  }

  if (/\b(gather wood and craft|chop wood and (make|craft)|wood then tools)\b/.test(m)) {
    return ["gather_wood", "craft_tools"];
  }
  if (/\b(craft tools and (mine|get) stone|tools then stone)\b/.test(m)) {
    return ["craft_tools", "gather_stone"];
  }
  if (/\b(mine stone and (get|mine) coal|stone then coal)\b/.test(m)) {
    return ["gather_stone", "gather_coal"];
  }
  if (/\b(get wood.{0,20}craft tools|chop.{0,20}make tools)\b/.test(m)) {
    return ["gather_wood", "craft_tools"];
  }
  if (/\b(chop|gather|mine).{0,40}(deposit|chest|stash)\b/.test(m)) {
    const partial: TaskIntent[] = [];
    if (/wood|tree|log/.test(m)) {
      partial.push("gather_wood");
    }
    if (/stone|cobble/.test(m)) {
      partial.push("gather_stone");
    }
    partial.push("deposit_chest");
    return partial;
  }

  return [];
}
