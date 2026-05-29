export type Vec3 = {
  x: number;
  y: number;
  z: number;
};

export type PlayerSnapshot = {
  username: string;
  position: Vec3;
  yaw: number;
  pitch: number;
  health: number;
  hunger: number;
  heldItem?: string;
};

export type BuildEvent = {
  kind: "place_block" | "break_block";
  blockId: string;
  position: Vec3;
  at: number;
};

export type OwnerActivityEvent = {
  kind: "break_block" | "place_block" | "kill_mob" | "equip_item" | "craft_item";
  detail: string;
  at: number;
};

export type NearbyMob = {
  name: string;
  distance: number;
  hostile: boolean;
};

export type NearbyStructure = {
  kind: string;
  distance: number;
  direction: "ahead" | "behind" | "left" | "right" | "above" | "below" | "here" | "nearby";
};

export type WorldSnapshot = {
  dimension: string;
  biome?: string;
  timeOfDay?: number;
  nearbyBlocks?: string[];
};

export type InventorySlot = {
  name: string;
  count: number;
};

export type HotbarSlot = {
  /** 1–9 (on-screen hotbar keys) */
  slot: number;
  name: string | null;
  count: number;
};

export type CompanionState = {
  player: PlayerSnapshot;
  /** You (MC_OWNER), when online in the world — for observation / learning. */
  owner?: PlayerSnapshot;
  world: WorldSnapshot;
  recentBuildEvents: BuildEvent[];
  recentOwnerActivity?: OwnerActivityEvent[];
  nearbyMobs?: NearbyMob[];
  inventory?: InventorySlot[];
  /** Hotbar slots 1–9 and backpack summary for the AI */
  inventorySummary?: string;
  hotbar?: HotbarSlot[];
  selectedHotbarSlot?: number;
  nearbyChest?: boolean;
  nearbyCraftingTable?: boolean;
  /** Crafting table, furnace, chest, etc. with direction from Luna's view */
  nearbyStructures?: NearbyStructure[];
  /** e.g. "facing north" */
  facingLabel?: string;
};

export type PlayerChatMessage = {
  type: "player_chat";
  payload: {
    username: string;
    message: string;
    at: number;
  };
};

export type CompanionAction =
  | {
      type: "move_to";
      target: Vec3;
      sprint?: boolean;
    }
  | {
      type: "look_at";
      target: Vec3;
    }
  | {
      type: "mine_block";
      target: Vec3;
      blockIdHint?: string;
    }
  | {
      type: "place_block";
      target: Vec3;
      blockId: string;
    }
  | {
      type: "chat";
      message: string;
    }
  | {
      type: "stop_all";
    }
  | {
      type: "teleport_to_owner";
    }
  | {
      type: "equip_tool";
      tool: "sword" | "pickaxe" | "axe" | "shovel";
    }
  | {
      type: "equip_hotbar";
      /** Hotbar UI slot 1–9 */
      slot: number;
    }
  | {
      type: "run_task";
      task:
        | "gather_wood"
        | "gather_stone"
        | "gather_coal"
        | "craft_tools"
        | "craft_survival"
        | "deposit_chest"
        | "fight_mobs"
        | "hunt_animal";
      amount?: number;
      target?: string;
    }
  | {
      type: "eat";
    }
  | {
      type: "craft_item";
      item: string;
      count?: number;
    };

export type SafetyPolicy = {
  maxMoveDistance: number;
  allowBreakBlocks: boolean;
  allowPlaceBlocks: boolean;
  allowChat: boolean;
  protectedRadiusAroundPlayer: number;
};

export type ActionResult = {
  ok: boolean;
  action: CompanionAction["type"];
  reason?: string;
};
