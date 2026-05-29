import mineflayer, { Bot } from "mineflayer";
import { pathfinder, Movements, goals } from "mineflayer-pathfinder";
import { plugin as collectBlockPlugin } from "mineflayer-collectblock";
import { Vec3 as Vec3Class } from "vec3";
import WebSocket from "ws";
import { actionRequestSchema } from "./protocol";
import {
  applySkinSettings,
  buildSkinSession,
  loadSkinProfile,
  LunaSkinSession,
  resolveSkinPath
} from "./skin";
import {
  buildInventoryContext,
  equipHotbarSlot,
  equipToolCategory,
  prepareToolsForTask
} from "./bot-inventory";
import {
  hasNearbyChest,
  hasNearbyCraftingTable,
  runBotTask
} from "./bot-tasks";
import {
  isHostileMob,
  ownerNearCraftingTable,
  readPlayerHeldItem,
  sampleNearbyMobs
} from "./bot-combat";
import { eatBestFood } from "./bot-eat";
import { craftSpecificItem } from "./bot-craft";
import { abortActiveMining, mineBlockReliably, pickaxeOrAxeForBlock } from "./bot-gather";
import { scanNearbyStructures, yawToCompassLabel } from "./spatial-awareness";
import {
  ActionResult,
  BuildEvent,
  CompanionAction,
  CompanionState,
  OwnerActivityEvent,
  Vec3
} from "./types";

export type MineflayerGameOptions = {
  bridgeUrl?: string;
  host?: string;
  port?: number;
  username?: string;
  version?: string;
  ownerUsername?: string;
  reconnectMs?: number;
};

const MAX_BUILD_EVENTS = 40;
const MAX_OWNER_ACTIVITY = 40;
const DEFAULT_RECONNECT_MS = 10_000;
const MAX_RECONNECT_MS = 60_000;

/** Avoid dual-stack localhost (::1 + 127.0.0.1) which doubles sockets on Windows. */
function normalizeLoopbackHost(host: string): string {
  const h = host.trim().toLowerCase();
  if (h === "localhost") {
    return "127.0.0.1";
  }
  if (h === "::1") {
    return "127.0.0.1";
  }
  return host.trim();
}

function errorDetail(err: unknown): string {
  if (err instanceof Error) {
    const agg = err as Error & { code?: string; errors?: unknown[] };
    if (agg.code) {
      return `${agg.code}: ${err.message}`.trim();
    }
    if (Array.isArray(agg.errors) && agg.errors.length > 0) {
      return agg.errors
        .map((e) => {
          const sub = e as Error & { code?: string };
          return `${sub.code ?? ""} ${sub.message ?? String(e)}`.trim();
        })
        .join("; ");
    }
    return err.message;
  }
  return String(err);
}

function isSocketExhaustion(err: unknown): boolean {
  const detail = errorDetail(err);
  return /ENOBUFS|EADDRINUSE|WSAENOBUFS|buffer space|queue was full/i.test(detail);
}

export async function startMineflayerGame(options: MineflayerGameOptions = {}): Promise<void> {
  const host = normalizeLoopbackHost(options.host ?? process.env.MC_HOST ?? "127.0.0.1");
  const port = options.port ?? Number(process.env.MC_PORT ?? "25565");
  const username = options.username ?? process.env.MC_USERNAME ?? "Luna";
  const version = options.version ?? process.env.MC_VERSION;
  const bridgePort = process.env.MC_SDK_PORT ?? "8787";
  const bridgeUrl =
    options.bridgeUrl ??
    process.env.MC_AI_BRIDGE_URL ??
    `ws://127.0.0.1:${bridgePort}`;
  const ownerUsername = options.ownerUsername ?? process.env.MC_OWNER;
  if (!ownerUsername) {
    console.warn(
      "[bot] Set MC_OWNER in .env to your Minecraft username so Luna can observe your building."
    );
  }
  const reconnectMs = options.reconnectMs ?? DEFAULT_RECONNECT_MS;

  let reconnectAttempt = 0;
  let firstConnect = true;

  const startupDelayMs = Number(process.env.MC_BOT_STARTUP_DELAY_MS ?? "3000") || 3000;

  const buildEvents: BuildEvent[] = [];
  const ownerActivity: OwnerActivityEvent[] = [];
  const skinModel = (process.env.MC_SKIN_MODEL === "classic" ? "classic" : "slim") as
    | "slim"
    | "classic";
  const skinPath = resolveSkinPath();
  const useMineSkin = process.env.MC_USE_MINESKIN === "true";
  let skinSession: LunaSkinSession | null = null;

  if (useMineSkin && skinPath) {
    try {
      const profile = await loadSkinProfile(skinPath, skinModel);
      skinSession = buildSkinSession(username, profile);
      console.log(`[bot] MineSkin profile loaded from ${skinPath} (${skinModel}).`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[bot] MineSkin upload failed: ${message}`);
    }
  } else if (skinPath) {
    console.log(
      `[bot] Using offline login. Luna's look comes from CustomSkinLoader (LocalSkin/skins/Luna.png).`
    );
  } else {
    console.warn("[bot] No Luna skin file found. Set MC_SKIN_PATH or add assets/skins/luna.png");
  }

  const connectBot = (): Promise<Bot> =>
    new Promise((resolve, reject) => {
      console.log(`[bot] Connecting to ${host}:${port} as "${username}"...`);
      console.log("[bot] In Minecraft: Esc → Open to LAN (then this bot can join).");

      const bot = mineflayer.createBot({
        host,
        port,
        username,
        version: version || undefined,
        auth: skinSession
          ? (client, options) => {
              client.username = username;
              client.uuid = skinSession!.selectedProfile.id;
              client.session = skinSession!;
              if (options.connect) {
                options.connect(client);
              }
            }
          : "offline"
      });

      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        fn();
      };

      bot.once("spawn", () => {
        applySkinSettings(bot);
        finish(() => resolve(bot));
      });
      bot.once("error", (err) => {
        try {
          bot.quit();
        } catch {
          // ignore cleanup errors
        }
        finish(() => reject(err));
      });
      bot.on("error", (err) => {
        const msg = errorDetail(err);
        console.warn("[bot] Error:", msg || "(connection error)");
        if (isSocketExhaustion(err)) {
          console.warn(
            "[bot] Windows ran out of network buffers — Luna will wait longer before retrying. Close extra Luna/terminal windows."
          );
        } else if (msg.includes("unsupported protocol") || msg.includes("ECONNREFUSED")) {
          console.warn("[bot] Check: world is Open to LAN, MC_PORT matches, MC_VERSION matches F3 screen.");
        }
      });
      bot.on("kicked", (reason) => {
        const reasonText = formatKickReason(reason);
        console.warn("[bot] Kicked:", reasonText);
        if (reasonText.includes("duplicate_login")) {
          console.warn(
            "[bot] Luna was already online. Waiting before reconnect (only one npm run companion at a time)."
          );
        }
      });
      bot.on("end", () => console.warn("[bot] Disconnected from Minecraft."));
    });

  const runSession = async (): Promise<{ duplicateLogin: boolean }> => {
    const bot = await connectBot();
    bot.loadPlugin(pathfinder);
    bot.loadPlugin(collectBlockPlugin);
    try {
      const { plugin: toolPlugin } = await import("mineflayer-tool");
      bot.loadPlugin(toolPlugin);
    } catch {
      console.warn("[bot] mineflayer-tool not loaded — auto tool equip may be limited.");
    }

    const movements = new Movements(bot);
    movements.canDig = true;
    movements.allowSprinting = true;
    bot.pathfinder.setMovements(movements);

    const bridge = await connectBridge(bridgeUrl);
    trackBuildEvents(bot, buildEvents, username, ownerUsername);
    if (ownerUsername) {
      trackOwnerActivity(bot, ownerActivity, username, ownerUsername);
      setupRespawnNearOwner(bot, ownerUsername);
    }

    if (ownerUsername) {
      bot.on("chat", (speaker, message) => {
        if (speaker === username || speaker !== ownerUsername) {
          return;
        }
        if (bridge.readyState === WebSocket.OPEN) {
          bridge.send(
            JSON.stringify({
              type: "player_chat",
              payload: { username: speaker, message, at: Date.now() }
            })
          );
        }
      });
    }

    let duplicateLogin = false;
    let cleanedUp = false;

    const cleanup = () => {
      if (cleanedUp) {
        return;
      }
      cleanedUp = true;
      clearInterval(stateInterval);
      if (bridge.readyState === WebSocket.OPEN) {
        bridge.close();
      }
      if (bot.entity) {
        bot.quit();
      }
    };

    const stateInterval = setInterval(() => {
      if (bridge.readyState === WebSocket.OPEN && bot.entity) {
        bridge.send(
          JSON.stringify({
            type: "state_update",
            payload: collectState(bot, buildEvents, ownerUsername, ownerActivity)
          })
        );
      }
    }, Number(process.env.MC_STATE_INTERVAL_MS ?? "1000") || 1000);

    bridge.on("message", (raw) => {
      void handleBridgeMessage(bot, bridge, raw.toString(), buildEvents, ownerUsername, ownerActivity);
    });

    bridge.on("close", cleanup);

    bot.on("kicked", (reason) => {
      if (formatKickReason(reason).includes("duplicate_login")) {
        duplicateLogin = true;
      }
    });

    bridge.send(
      JSON.stringify({
        type: "state_update",
        payload: collectState(bot, buildEvents, ownerUsername, ownerActivity)
      })
    );
    console.log("[bot] In world and linked to SDK bridge.");

    await new Promise<void>((resolve) => {
      bot.once("end", () => {
        cleanup();
        resolve();
      });
    });

    return { duplicateLogin };
  };

  for (;;) {
    let waitMs = reconnectMs;
    if (firstConnect) {
      console.log(`[bot] Waiting ${startupDelayMs / 1000}s for network stack to settle…`);
      await sleep(startupDelayMs);
      firstConnect = false;
    }
    try {
      const result = await runSession();
      reconnectAttempt = 0;
      if (result.duplicateLogin) {
        waitMs = Math.max(reconnectMs, 15_000);
      }
    } catch (err) {
      const message = errorDetail(err);
      console.warn(`[bot] Session ended: ${message || "(unknown error)"}`);
      if (isSocketExhaustion(err)) {
        reconnectAttempt += 1;
        waitMs = Math.min(MAX_RECONNECT_MS, reconnectMs * 2 ** reconnectAttempt);
        console.warn(`[bot] Backing off ${waitMs / 1000}s (socket exhaustion). Run Stop Luna.bat if this keeps happening.`);
      } else if (message.includes("ECONNREFUSED")) {
        waitMs = reconnectMs;
      }
    }
    console.log(`[bot] Retrying in ${waitMs / 1000}s...`);
    await sleep(waitMs);
  }
}

function formatKickReason(reason: unknown): string {
  try {
    return JSON.stringify(reason);
  } catch {
    return String(reason);
  }
}

function connectBridge(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "hello", role: "game" }));
      resolve(ws);
    });
    ws.on("error", reject);
  });
}

async function handleBridgeMessage(
  bot: Bot,
  bridge: WebSocket,
  raw: string,
  buildEvents: BuildEvent[],
  ownerUsername?: string,
  ownerActivity?: OwnerActivityEvent[]
): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }

  const action = actionRequestSchema.safeParse(parsed);
  if (!action.success) {
    return;
  }

  const result = await executeAction(bot, action.data.payload, buildEvents, ownerUsername);
  bridge.send(JSON.stringify({ type: "action_result", payload: result }));
  bridge.send(
    JSON.stringify({
      type: "state_update",
      payload: collectState(bot, buildEvents, ownerUsername, ownerActivity)
    })
  );
}

async function executeAction(
  bot: Bot,
  action: CompanionAction,
  buildEvents: BuildEvent[],
  ownerUsername?: string
): Promise<{ ok: boolean; action: string; reason?: string }> {
  try {
    switch (action.type) {
      case "move_to":
        return await moveTo(bot, action);
      case "look_at":
        return await lookAt(bot, action);
      case "mine_block":
        return await mineBlock(bot, action, buildEvents);
      case "place_block":
        return await placeBlock(bot, action, buildEvents);
      case "chat":
        bot.chat(action.message);
        return { ok: true, action: "chat" };
      case "stop_all":
        abortActiveMining(bot);
        return { ok: true, action: "stop_all" };
      case "teleport_to_owner":
        return teleportToOwner(bot, ownerUsername);
      case "equip_tool":
        return await equipToolAction(bot, action);
      case "equip_hotbar":
        return await equipHotbarAction(bot, action);
      case "run_task":
        return await runTask(bot, action);
      case "eat":
        return await eatBestFood(bot);
      case "craft_item": {
        const r = await craftSpecificItem(bot, action.item, 48, action.count ?? 1);
        return { ok: r.ok, action: "craft_item", reason: r.reason };
      }
      default:
        return { ok: false, action: "unknown", reason: "Unsupported action." };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, action: action.type, reason: message };
  }
}

async function equipToolAction(
  bot: Bot,
  action: Extract<CompanionAction, { type: "equip_tool" }>
): Promise<ActionResult> {
  const ok = await equipToolCategory(bot, action.tool);
  if (!ok) {
    return { ok: false, action: "equip_tool", reason: `No ${action.tool} in inventory.` };
  }
  const held = bot.heldItem?.name ?? action.tool;
  console.log(`[bot] Equipped ${held} (hotbar slot ${(bot.quickBarSlot ?? 0) + 1})`);
  return { ok: true, action: "equip_tool", reason: `holding ${held}` };
}

async function equipHotbarAction(
  bot: Bot,
  action: Extract<CompanionAction, { type: "equip_hotbar" }>
): Promise<ActionResult> {
  await equipHotbarSlot(bot, action.slot);
  const held = bot.heldItem?.name ?? "empty";
  console.log(`[bot] Selected hotbar slot ${action.slot} — ${held}`);
  return { ok: true, action: "equip_hotbar", reason: `slot ${action.slot}: ${held}` };
}

async function teleportToOwner(bot: Bot, ownerUsername?: string): Promise<ActionResult> {
  const owner = ownerUsername ?? process.env.MC_OWNER;
  if (!owner) {
    return { ok: false, action: "teleport_to_owner", reason: "MC_OWNER not set in .env" };
  }
  if (process.env.MC_ALLOW_TP === "false") {
    return { ok: false, action: "teleport_to_owner", reason: "Teleport disabled (MC_ALLOW_TP=false)." };
  }

  bot.pathfinder.setGoal(null);
  bot.clearControlStates();
  const cmd = `/tp ${bot.username} ${owner}`;
  bot.chat(cmd);
  console.log(`[bot] ${cmd}`);
  return { ok: true, action: "teleport_to_owner", reason: `teleported to ${owner}` };
}

async function runTask(
  bot: Bot,
  action: Extract<CompanionAction, { type: "run_task" }>
): Promise<ActionResult> {
  console.log(`[bot] Task: ${action.task}${action.amount ? ` x${action.amount}` : ""}`);
  const result = await runBotTask(bot, action.task, {
    amount: action.amount,
    target: action.target
  });
  if (result.detail) {
    console.log(`[bot] ${result.detail}`);
  }
  return {
    ok: result.ok,
    action: "run_task",
    reason: result.reason ?? result.detail
  };
}

async function moveTo(
  bot: Bot,
  action: Extract<CompanionAction, { type: "move_to" }>
): Promise<ActionResult> {
  const GoalBlock = goals.GoalBlock;
  bot.pathfinder.setGoal(
    new GoalBlock(
      Math.floor(action.target.x),
      Math.floor(action.target.y),
      Math.floor(action.target.z)
    )
  );

  try {
    await waitForGoal(bot, 15000);
    return { ok: true, action: "move_to" };
  } catch {
    bot.pathfinder.setGoal(null);
    return { ok: false, action: "move_to", reason: "stuck: pathfinding timed out" };
  }
}

async function lookAt(
  bot: Bot,
  action: Extract<CompanionAction, { type: "look_at" }>
): Promise<ActionResult> {
  const target = action.target;
  await bot.lookAt(new Vec3Class(target.x, target.y, target.z), true);
  return { ok: true, action: "look_at" };
}

async function mineBlock(
  bot: Bot,
  action: Extract<CompanionAction, { type: "mine_block" }>,
  buildEvents: BuildEvent[]
): Promise<ActionResult> {
  const block = bot.blockAt(vecToBlockPos(action.target));
  if (!block || block.name === "air") {
    return { ok: false, action: "mine_block", reason: "No block at target." };
  }

  await mineBlockReliably(bot, block, { tool: pickaxeOrAxeForBlock(block.name) });
  pushBuildEvent(buildEvents, {
    kind: "break_block",
    blockId: block.name,
    position: blockPosToVec(block.position),
    at: Date.now()
  });
  return { ok: true, action: "mine_block" };
}

async function placeBlock(
  bot: Bot,
  action: Extract<CompanionAction, { type: "place_block" }>,
  buildEvents: BuildEvent[]
): Promise<ActionResult> {
  const blockName = action.blockId.replace("minecraft:", "");
  const item = bot.registry.itemsByName[blockName];
  if (!item) {
    return { ok: false, action: "place_block", reason: `Unknown block item: ${action.blockId}` };
  }

  const itemStack = bot.inventory.items().find((stack) => stack.name === blockName);
  if (!itemStack) {
    return { ok: false, action: "place_block", reason: `Block not in inventory: ${blockName}` };
  }

  await bot.equip(itemStack, "hand");

  const target = vecToBlockPos(action.target);
  const reference = bot.blockAt(target.offset(0, -1, 0)) ?? bot.blockAt(target.offset(1, 0, 0));
  if (!reference) {
    return { ok: false, action: "place_block", reason: "No reference block to place against." };
  }

  const face = reference.position.offset(0, 1, 0).equals(target)
    ? new Vec3Class(0, 1, 0)
    : new Vec3Class(-1, 0, 0);
  await bot.placeBlock(reference, face);

  pushBuildEvent(buildEvents, {
    kind: "place_block",
    blockId: blockName,
    position: action.target,
    at: Date.now()
  });
  return { ok: true, action: "place_block" };
}

function collectState(
  bot: Bot,
  buildEvents: BuildEvent[],
  ownerUsername?: string,
  ownerActivity: OwnerActivityEvent[] = []
): CompanionState {
  const pos = bot.entity.position;
  const held = bot.heldItem;

  const inv = buildInventoryContext(bot);

  const state: CompanionState = {
    player: {
      username: bot.username,
      position: { x: pos.x, y: pos.y, z: pos.z },
      yaw: bot.entity.yaw,
      pitch: bot.entity.pitch,
      health: bot.health,
      hunger: bot.food,
      heldItem: held?.name
    },
    world: {
      dimension: "minecraft:overworld",
      timeOfDay: bot.time.timeOfDay,
      nearbyBlocks: sampleNearbyBlocks(bot)
    },
    recentBuildEvents: [...buildEvents],
    recentOwnerActivity: [...ownerActivity],
    nearbyMobs: sampleNearbyMobs(bot),
    inventory: inv.items,
    inventorySummary: inv.summary,
    hotbar: inv.hotbar,
    selectedHotbarSlot: inv.selectedSlot,
    nearbyChest: hasNearbyChest(bot),
    nearbyCraftingTable: hasNearbyCraftingTable(bot),
    nearbyStructures: scanNearbyStructures(bot, 12),
    facingLabel: yawToCompassLabel(bot.entity.yaw)
  };

  if (ownerUsername && bot.players[ownerUsername]?.entity) {
    const ownerEntity = bot.players[ownerUsername]!.entity!;
    const ownerHeld = readPlayerHeldItem(bot, ownerUsername);
    state.owner = {
      username: ownerUsername,
      position: {
        x: ownerEntity.position.x,
        y: ownerEntity.position.y,
        z: ownerEntity.position.z
      },
      yaw: ownerEntity.yaw,
      pitch: ownerEntity.pitch,
      health: 20,
      hunger: 20,
      heldItem: ownerHeld
    };
  }

  return state;
}

function sampleNearbyBlocks(bot: Bot): string[] {
  const names = new Set<string>();
  const center = bot.entity.position.floored();

  for (let x = -2; x <= 2; x++) {
    for (let y = -1; y <= 2; y++) {
      for (let z = -2; z <= 2; z++) {
        const block = bot.blockAt(center.offset(x, y, z));
        if (block && block.name !== "air") {
          names.add(block.name);
        }
      }
    }
  }

  return [...names].sort().slice(0, 12);
}

function pushOwnerActivity(events: OwnerActivityEvent[], event: OwnerActivityEvent): void {
  events.push(event);
  while (events.length > MAX_OWNER_ACTIVITY) {
    events.shift();
  }
}

function readOwnerPosition(bot: Bot, ownerUsername: string): Vec3 | null {
  const owner = bot.players[ownerUsername]?.entity;
  if (!owner) {
    return null;
  }
  const p = owner.position;
  return { x: p.x, y: p.y, z: p.z };
}

function standNearOwner(ownerPos: Vec3, standOff = 2): Vec3 {
  return {
    x: Math.floor(ownerPos.x + standOff),
    y: Math.floor(ownerPos.y),
    z: Math.floor(ownerPos.z)
  };
}

function setupRespawnNearOwner(bot: Bot, ownerUsername: string): void {
  if (process.env.MC_RESPAWN_NEAR_OWNER === "false") {
    return;
  }

  let ownerPosAtDeath: Vec3 | null = null;

  bot.on("death", () => {
    ownerPosAtDeath = readOwnerPosition(bot, ownerUsername);
    console.log("[bot] Luna died — will return near you after respawn.");
  });

  bot.on("respawn", () => {
    void returnNearOwnerAfterRespawn(bot, ownerUsername, ownerPosAtDeath);
    ownerPosAtDeath = null;
  });
}

async function returnNearOwnerAfterRespawn(
  bot: Bot,
  ownerUsername: string,
  fallback: Vec3 | null
): Promise<void> {
  await sleep(1500);

  const live = readOwnerPosition(bot, ownerUsername);
  const ref = live ?? fallback;
  if (!ref) {
    console.warn("[bot] You are not in the world — cannot return Luna to you.");
    return;
  }

  const target = standNearOwner(ref);
  console.log(
    `[bot] Respawned — heading to you at (${target.x}, ${target.y}, ${target.z})`
  );

  if (process.env.MC_RESPAWN_TP !== "false") {
    const tp = await teleportToOwner(bot, ownerUsername);
    if (tp.ok) {
      await sleep(800);
      const ownerEntity = bot.players[ownerUsername]?.entity;
      if (ownerEntity && bot.entity && bot.entity.position.distanceTo(ownerEntity.position) < 6) {
        console.log("[bot] Teleported back near you.");
        return;
      }
    }
  }

  try {
    const GoalBlock = goals.GoalBlock;
    bot.pathfinder.setGoal(new GoalBlock(target.x, target.y, target.z));
    await waitForGoal(bot, 90_000);
    bot.pathfinder.setGoal(null);
    console.log("[bot] Back near you after respawn.");
  } catch {
    bot.pathfinder.setGoal(null);
    console.warn("[bot] Could not walk to you after respawn — come get me or /tp Luna.");
  }
}

function trackOwnerActivity(
  bot: Bot,
  ownerActivity: OwnerActivityEvent[],
  _botUsername: string,
  ownerUsername: string
): void {
  let lastHeld = readPlayerHeldItem(bot, ownerUsername);
  let wasNearTable = ownerNearCraftingTable(bot, ownerUsername);

  bot.on("blockUpdate", (oldBlock, newBlock) => {
    if (!oldBlock || !newBlock) {
      return;
    }
    const pos = blockPosToVec(newBlock.position);
    if (!isOwnerNearby(bot, ownerUsername, pos)) {
      return;
    }
    if (oldBlock.name === "air" && newBlock.name !== "air") {
      pushOwnerActivity(ownerActivity, {
        kind: "place_block",
        detail: newBlock.name,
        at: Date.now()
      });
    } else if (newBlock.name === "air" && oldBlock.name !== "air") {
      pushOwnerActivity(ownerActivity, {
        kind: "break_block",
        detail: oldBlock.name,
        at: Date.now()
      });
    }
  });

  bot.on("entityGone", (entity) => {
    const name = entity.name ?? "";
    if (!isHostileMob(name)) {
      return;
    }
    const owner = bot.players[ownerUsername]?.entity;
    if (!owner || owner.position.distanceTo(entity.position) > 12) {
      return;
    }
    const weapon = readPlayerHeldItem(bot, ownerUsername) ?? "hand";
    pushOwnerActivity(ownerActivity, {
      kind: "kill_mob",
      detail: `${name}|${weapon}`,
      at: Date.now()
    });
    console.log(`[observe] ${ownerUsername} killed ${name} (${weapon})`);
  });

  setInterval(() => {
    if (!bot.entity) {
      return;
    }
    const held = readPlayerHeldItem(bot, ownerUsername);
    const nearTable = ownerNearCraftingTable(bot, ownerUsername);
    if (held && held !== lastHeld) {
      if (nearTable && (held.endsWith("_sword") || held.endsWith("_pickaxe") || held.endsWith("_axe"))) {
        pushOwnerActivity(ownerActivity, {
          kind: "craft_item",
          detail: held,
          at: Date.now()
        });
        console.log(`[observe] ${ownerUsername} crafted ${held}`);
      } else if (held.endsWith("_sword")) {
        pushOwnerActivity(ownerActivity, {
          kind: "equip_item",
          detail: held,
          at: Date.now()
        });
      }
      lastHeld = held;
    }
    if (nearTable && !wasNearTable && held) {
      wasNearTable = true;
    } else if (!nearTable) {
      wasNearTable = false;
    }
  }, 1000);
}

function trackBuildEvents(
  bot: Bot,
  buildEvents: BuildEvent[],
  botUsername: string,
  ownerUsername?: string
): void {
  bot.on("blockUpdate", (oldBlock, newBlock) => {
    if (!oldBlock || !newBlock) {
      return;
    }

    const pos = blockPosToVec(newBlock.position);
    const changedByOwner = ownerUsername
      ? isOwnerNearby(bot, ownerUsername, pos)
      : isOtherPlayerNearby(bot, botUsername, pos);

    if (!changedByOwner) {
      return;
    }

    if (oldBlock.name === "air" && newBlock.name !== "air") {
      pushBuildEvent(buildEvents, {
        kind: "place_block",
        blockId: newBlock.name,
        position: pos,
        at: Date.now()
      });
    } else if (newBlock.name === "air" && oldBlock.name !== "air") {
      pushBuildEvent(buildEvents, {
        kind: "break_block",
        blockId: oldBlock.name,
        position: pos,
        at: Date.now()
      });
    }
  });
}

function isOwnerNearby(bot: Bot, ownerUsername: string, pos: Vec3): boolean {
  const owner = bot.players[ownerUsername]?.entity;
  if (!owner) {
    return false;
  }
  return owner.position.distanceTo(new Vec3Class(pos.x, pos.y, pos.z)) < 8;
}

function isOtherPlayerNearby(bot: Bot, botUsername: string, pos: Vec3): boolean {
  for (const player of Object.values(bot.players)) {
    if (!player.entity || player.username === botUsername) {
      continue;
    }
    if (player.entity.position.distanceTo(new Vec3Class(pos.x, pos.y, pos.z)) < 8) {
      return true;
    }
  }
  return false;
}

function pushBuildEvent(events: BuildEvent[], event: BuildEvent): void {
  events.push(event);
  while (events.length > MAX_BUILD_EVENTS) {
    events.shift();
  }
}

function vecToBlockPos(vec: Vec3): Vec3Class {
  return new Vec3Class(Math.floor(vec.x), Math.floor(vec.y), Math.floor(vec.z));
}

function blockPosToVec(pos: { x: number; y: number; z: number }): Vec3 {
  return { x: pos.x, y: pos.y, z: pos.z };
}

function waitForGoal(bot: Bot, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Pathfinding timed out."));
    }, timeoutMs);

    const onGoal = () => {
      cleanup();
      resolve();
    };

    const cleanup = () => {
      clearTimeout(timer);
      bot.removeListener("goal_reached", onGoal);
      bot.removeListener("path_stop", onGoal);
    };

    bot.on("goal_reached", onGoal);
    bot.on("path_stop", onGoal);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
