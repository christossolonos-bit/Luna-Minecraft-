/**
 * Luna simple mode — sleep runs in mineflayer-bot (bot-sleep.ts).
 */

export type LunaAbility = {
  id: string;
  name: string;
  examples: string[];
};

export const LUNA_ABILITIES: LunaAbility[] = [
  {
    id: "follow",
    name: "Follow you",
    examples: ["follow me", "stay with me"]
  },
  {
    id: "stop",
    name: "Stop following",
    examples: ["stop", "stay there", "wait here"]
  },
  {
    id: "teleport",
    name: "Teleport to you",
    examples: ["tp to me", "teleport to me"]
  },
  {
    id: "deposit",
    name: "Put items in chest",
    examples: ["put in chest"]
  },
  {
    id: "take_tools",
    name: "Take tools from chest",
    examples: ["take pickaxe", "take axe"]
  },
  {
    id: "gather_wood",
    name: "Chop a whole tree",
    examples: ["gather wood — asks for axe if missing"]
  },
  {
    id: "check_logs",
    name: "Check log inventory",
    examples: ["check logs — says if she can pillar up to reach higher trunk"]
  },
  {
    id: "collect_wheat",
    name: "Harvest wheat at your farm",
    examples: ["collect wheat — harvests, stashes in chest, replants seeds from chest"]
  },
  {
    id: "plant_wheat",
    name: "Replant the farm",
    examples: ["plant wheat — takes seeds from chest and plants where she last harvested"]
  },
  {
    id: "sleep_with_owner",
    name: "Sleep when you sleep",
    examples: ["Get in your bed — Luna uses or places her own bed nearby."]
  }
];

export function abilitiesHelpText(): string {
  const lines = ["Luna (simple):"];
  for (const a of LUNA_ABILITIES) {
    lines.push(`  • ${a.name} — ${a.examples[0]}`);
  }
  return lines.join("\n");
}
