import { Bot } from "mineflayer";
import { ActionResult } from "./types";

/** Edible items, best nutrition / safety first. */
export const FOOD_PRIORITY = [
  "cooked_beef",
  "cooked_porkchop",
  "cooked_mutton",
  "cooked_chicken",
  "cooked_rabbit",
  "cooked_cod",
  "cooked_salmon",
  "bread",
  "baked_potato",
  "golden_carrot",
  "apple",
  "carrot",
  "potato",
  "melon_slice",
  "sweet_berries",
  "glow_berries",
  "dried_kelp",
  "beetroot",
  "pumpkin_pie",
  "rabbit_stew",
  "mushroom_stew",
  "suspicious_stew",
  "beetroot_soup",
  "golden_apple",
  "rotten_flesh"
] as const;

const FOOD_SET = new Set<string>(FOOD_PRIORITY);

const GOLDEN_FOODS = ["enchanted_golden_apple", "golden_apple"];

export function isFoodItem(name: string): boolean {
  if (FOOD_SET.has(name) || GOLDEN_FOODS.includes(name)) {
    return true;
  }
  return name.includes("stew") || name.endsWith("_soup") || name === "honey_bottle";
}

export function findBestFood(bot: Bot, urgentHealth: boolean) {
  if (urgentHealth) {
    for (const name of GOLDEN_FOODS) {
      const stack = bot.inventory.items().find((i) => i.name === name);
      if (stack) {
        return stack;
      }
    }
  }
  for (const name of FOOD_PRIORITY) {
    const stack = bot.inventory.items().find((i) => i.name === name);
    if (stack) {
      return stack;
    }
  }
  return bot.inventory.items().find((i) => isFoodItem(i.name)) ?? null;
}

export async function eatBestFood(bot: Bot): Promise<ActionResult> {
  const urgentHealth = bot.health < 10;
  const food = findBestFood(bot, urgentHealth);
  if (!food) {
    return { ok: false, action: "eat", reason: "No food in inventory." };
  }

  const isGolden = GOLDEN_FOODS.includes(food.name);
  if (!isGolden && bot.food >= 20) {
    return { ok: false, action: "eat", reason: "Hunger full — need golden food to heal more." };
  }

  bot.pathfinder.setGoal(null);
  bot.clearControlStates();

  await bot.equip(food, "hand");
  try {
    await bot.consume();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, action: "eat", reason: message };
  }

  const label = food.name.replace(/_/g, " ");
  console.log(`[bot] Ate ${label} (health ${bot.health.toFixed(0)}, food ${bot.food})`);
  return {
    ok: true,
    action: "eat",
    reason: `ate ${label}; health ${bot.health.toFixed(0)}, food ${bot.food}`
  };
}
