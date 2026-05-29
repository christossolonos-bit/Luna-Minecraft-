import { z } from "zod";

const vec3Schema = z.object({
  x: z.number(),
  y: z.number(),
  z: z.number()
});

const buildEventSchema = z.object({
  kind: z.union([z.literal("place_block"), z.literal("break_block")]),
  blockId: z.string(),
  position: vec3Schema,
  at: z.number()
});

const ownerActivitySchema = z.object({
  kind: z.enum(["break_block", "place_block", "kill_mob", "equip_item", "craft_item"]),
  detail: z.string(),
  at: z.number()
});

const nearbyMobSchema = z.object({
  name: z.string(),
  distance: z.number(),
  hostile: z.boolean()
});

const structureDirectionSchema = z.enum([
  "ahead",
  "behind",
  "left",
  "right",
  "above",
  "below",
  "here",
  "nearby"
]);

const nearbyStructureSchema = z.object({
  kind: z.string(),
  distance: z.number(),
  direction: structureDirectionSchema
});

export const helloSchema = z.object({
  type: z.literal("hello"),
  role: z.union([z.literal("game"), z.literal("ai")])
});

const playerSnapshotSchema = z.object({
  username: z.string(),
  position: vec3Schema,
  yaw: z.number(),
  pitch: z.number(),
  health: z.number(),
  hunger: z.number(),
  heldItem: z.string().optional()
});

const inventorySlotSchema = z.object({
  name: z.string(),
  count: z.number()
});

const hotbarSlotSchema = z.object({
  slot: z.number(),
  name: z.string().nullable(),
  count: z.number()
});

export const stateUpdateSchema = z.object({
  type: z.literal("state_update"),
  payload: z.object({
    player: playerSnapshotSchema,
    owner: playerSnapshotSchema.optional(),
    world: z.object({
      dimension: z.string(),
      biome: z.string().optional(),
      timeOfDay: z.number().optional(),
      nearbyBlocks: z.array(z.string()).optional()
    }),
    recentBuildEvents: z.array(buildEventSchema),
    recentOwnerActivity: z.array(ownerActivitySchema).optional(),
    nearbyMobs: z.array(nearbyMobSchema).optional(),
    inventory: z.array(inventorySlotSchema).optional(),
    inventorySummary: z.string().optional(),
    hotbar: z.array(hotbarSlotSchema).optional(),
    selectedHotbarSlot: z.number().optional(),
    nearbyChest: z.boolean().optional(),
    nearbyCraftingTable: z.boolean().optional(),
    nearbyStructures: z.array(nearbyStructureSchema).optional(),
    facingLabel: z.string().optional()
  })
});

export const actionRequestSchema = z.object({
  type: z.literal("action_request"),
  payload: z.union([
    z.object({
      type: z.literal("move_to"),
      target: vec3Schema,
      sprint: z.boolean().optional()
    }),
    z.object({
      type: z.literal("look_at"),
      target: vec3Schema
    }),
    z.object({
      type: z.literal("mine_block"),
      target: vec3Schema,
      blockIdHint: z.string().optional()
    }),
    z.object({
      type: z.literal("place_block"),
      target: vec3Schema,
      blockId: z.string()
    }),
    z.object({
      type: z.literal("chat"),
      message: z.string().min(1)
    }),
    z.object({
      type: z.literal("stop_all")
    }),
    z.object({
      type: z.literal("teleport_to_owner")
    }),
    z.object({
      type: z.literal("equip_tool"),
      tool: z.enum(["sword", "pickaxe", "axe", "shovel"])
    }),
    z.object({
      type: z.literal("equip_hotbar"),
      slot: z.number().min(1).max(9)
    }),
    z.object({
      type: z.literal("run_task"),
      task: z.enum([
        "gather_wood",
        "gather_stone",
        "gather_coal",
        "craft_tools",
        "craft_survival",
        "deposit_chest",
        "fight_mobs",
        "hunt_animal"
      ]),
      amount: z.number().optional(),
      target: z.string().optional()
    }),
    z.object({
      type: z.literal("eat")
    }),
    z.object({
      type: z.literal("craft_item"),
      item: z.string().min(1),
      count: z.number().optional()
    })
  ])
});

export const playerChatSchema = z.object({
  type: z.literal("player_chat"),
  payload: z.object({
    username: z.string(),
    message: z.string(),
    at: z.number()
  })
});

export const actionResultSchema = z.object({
  type: z.literal("action_result"),
  payload: z.object({
    ok: z.boolean(),
    action: z.string(),
    reason: z.string().optional()
  })
});

export type HelloMessage = z.infer<typeof helloSchema>;
export type StateUpdateMessage = z.infer<typeof stateUpdateSchema>;
export type ActionRequestMessage = z.infer<typeof actionRequestSchema>;
export type ActionResultMessage = z.infer<typeof actionResultSchema>;
