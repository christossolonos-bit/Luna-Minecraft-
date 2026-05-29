import { Bot } from "mineflayer";
import { InventorySlot, HotbarSlot } from "./types";

const QUICK_BAR_START = 36;
const QUICK_BAR_COUNT = 9;

export type InventoryContext = {
  items: InventorySlot[];
  hotbar: HotbarSlot[];
  /** Selected hotbar key 1–9 */
  selectedSlot: number;
  heldItem?: string;
  summary: string;
};

export type ToolCategory = "sword" | "pickaxe" | "axe" | "shovel";

const SWORD_NAMES = ["netherite_sword", "diamond_sword", "iron_sword", "stone_sword", "wooden_sword"];
const PICK_NAMES = [
  "netherite_pickaxe",
  "diamond_pickaxe",
  "iron_pickaxe",
  "stone_pickaxe",
  "wooden_pickaxe"
];
const AXE_NAMES = ["netherite_axe", "diamond_axe", "iron_axe", "stone_axe", "wooden_axe"];
const SHOVEL_NAMES = [
  "netherite_shovel",
  "diamond_shovel",
  "iron_shovel",
  "stone_shovel",
  "wooden_shovel"
];

export function buildInventoryContext(bot: Bot): InventoryContext {
  const hotbar: HotbarSlot[] = [];
  for (let i = 0; i < QUICK_BAR_COUNT; i++) {
    const stack = bot.inventory.slots[QUICK_BAR_START + i];
    hotbar.push({
      slot: i + 1,
      name: stack?.name ?? null,
      count: stack?.count ?? 0
    });
  }

  const selectedSlot = (bot.quickBarSlot ?? 0) + 1;
  const held = bot.heldItem?.name;

  const map = new Map<string, number>();
  for (const item of bot.inventory.items()) {
    map.set(item.name, (map.get(item.name) ?? 0) + item.count);
  }
  const items = [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  const hotbarText = hotbar
    .map((s) => (s.name ? `${s.slot}:${s.name}x${s.count}` : `${s.slot}:empty`))
    .join(", ");
  const invLimit = Number(process.env.MC_AI_CONTEXT_INV_ITEMS ?? "24") || 24;
  const backpackText = items
    .slice(0, invLimit)
    .map((i) => `${i.name}x${i.count}`)
    .join(", ");
  const backpackMore =
    items.length > invLimit ? ` (+${items.length - invLimit} more item types)` : "";

  const summary = [
    `Hotbar (UI keys 1-9): ${hotbarText}.`,
    `Selected slot ${selectedSlot}${held ? ` — holding ${held}` : " — empty hand"}.`,
    backpackText ? `Backpack: ${backpackText}${backpackMore}.` : "Backpack empty."
  ].join(" ");

  return { items, hotbar, selectedSlot, heldItem: held, summary };
}

export function findBestTool(bot: Bot, category: ToolCategory) {
  const list =
    category === "sword"
      ? SWORD_NAMES
      : category === "pickaxe"
        ? PICK_NAMES
        : category === "axe"
          ? AXE_NAMES
          : SHOVEL_NAMES;
  for (const name of list) {
    const stack = bot.inventory.items().find((i) => i.name === name);
    if (stack) {
      return stack;
    }
  }
  return null;
}

export async function equipToolCategory(bot: Bot, category: ToolCategory): Promise<boolean> {
  const stack = findBestTool(bot, category);
  if (!stack) {
    return false;
  }
  await bot.equip(stack, "hand");
  return true;
}

export async function equipHotbarSlot(bot: Bot, slot1to9: number): Promise<boolean> {
  const index = Math.max(1, Math.min(9, Math.floor(slot1to9))) - 1;
  bot.setQuickBarSlot(index);
  const stack = bot.inventory.slots[QUICK_BAR_START + index];
  if (stack) {
    await bot.equip(stack, "hand");
  }
  return true;
}

export async function prepareToolsForTask(bot: Bot, task: string): Promise<void> {
  if (task === "gather_wood") {
    if (await equipToolCategory(bot, "axe")) {
      return;
    }
  }
  if (task === "gather_stone" || task === "gather_coal") {
    if (await equipToolCategory(bot, "pickaxe")) {
      return;
    }
  }
  if (task === "fight_mobs" || task === "hunt_animal") {
    await equipToolCategory(bot, "sword");
    if (task === "hunt_animal" && !(await equipToolCategory(bot, "sword"))) {
      await equipToolCategory(bot, "axe");
    }
  }
}

export function formatInventoryReply(ctx: InventoryContext): string {
  const lines = [
    `Hotbar: ${ctx.hotbar.map((s) => (s.name ? `[${s.slot}] ${s.name} x${s.count}` : `[${s.slot}] empty`)).join(", ")}`,
    `Selected: slot ${ctx.selectedSlot}${ctx.heldItem ? ` (${ctx.heldItem})` : ""}`
  ];
  if (ctx.items.length > 0) {
    lines.push(`Items: ${ctx.items.map((i) => `${i.name} x${i.count}`).join(", ")}`);
  }
  return lines.join(". ");
}
