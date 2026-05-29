import { CompanionState } from "../types";
import { isFoodItem } from "../bot-eat";

export function eatThresholds(): { health: number; hunger: number } {
  const max = 20;
  const health = Number(process.env.MC_AI_EAT_HEALTH ?? String(max / 2));
  const hunger = Number(process.env.MC_AI_EAT_HUNGER ?? String(max / 2));
  return {
    health: Number.isFinite(health) ? health : max / 2,
    hunger: Number.isFinite(hunger) ? hunger : max / 2
  };
}

export function shouldAutoEat(state: CompanionState): boolean {
  if (process.env.MC_AI_AUTO_EAT === "false") {
    return false;
  }
  const { health, hunger } = eatThresholds();
  return state.player.health < health || state.player.hunger < hunger;
}

export function hasFoodInInventory(state: CompanionState): boolean {
  return Boolean(state.inventory?.some((i) => isFoodItem(i.name)));
}
