import { WebSocket, WebSocketServer } from "ws";
import {
  actionRequestSchema,
  actionResultSchema,
  helloSchema,
  playerChatSchema,
  stateUpdateSchema
} from "./protocol";
import { CompanionState } from "./types";

export type BridgeOptions = {
  port?: number;
};

export function startBridge(options: BridgeOptions = {}): WebSocketServer {
  const port = options.port ?? Number(process.env.MC_SDK_PORT ?? "8787");
  const wss = new WebSocketServer({ port });

  wss.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `[bridge] Port ${port} is already in use — close the other Luna window or run "Stop Luna.bat".`
      );
      process.exit(1);
    }
    console.error("[bridge] Error:", err.message);
    process.exit(1);
  });

  let gameClient: WebSocket | null = null;
  const aiClients = new Set<WebSocket>();
  const pendingActions = new Map<WebSocket, string>();
  let latestState: CompanionState | null = null;

  function broadcastState(state: CompanionState): void {
    for (const ai of aiClients) {
      sendState(ai, state);
    }
  }

  wss.on("connection", (ws) => {
    let role: "game" | "ai" | null = null;

    ws.on("message", (raw) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        sendActionResult(ws, { ok: false, action: "unknown", reason: "Malformed JSON." });
        return;
      }

      const hello = helloSchema.safeParse(parsed);
      if (hello.success && role === null) {
        role = hello.data.role;
        if (role === "game") {
          if (gameClient && gameClient !== ws) {
            gameClient.close();
          }
          gameClient = ws;
          console.log("[bridge] Minecraft bot connected.");
        } else {
          aiClients.add(ws);
          console.log("[bridge] AI/SDK client connected.");
          if (latestState) {
            sendState(ws, latestState);
          }
        }
        return;
      }

      const stateUpdate = stateUpdateSchema.safeParse(parsed);
      if (stateUpdate.success && ws === gameClient) {
        latestState = stateUpdate.data.payload;
        broadcastState(latestState);
        return;
      }

      const playerChat = playerChatSchema.safeParse(parsed);
      if (playerChat.success && ws === gameClient) {
        for (const ai of aiClients) {
          ai.send(JSON.stringify(playerChat.data));
        }
        return;
      }

      const actionResult = actionResultSchema.safeParse(parsed);
      if (actionResult.success && ws === gameClient) {
        for (const [aiWs, actionType] of pendingActions.entries()) {
          if (actionResult.data.payload.action === actionType || parsedResultMatches(actionResult.data.payload, actionType)) {
            aiWs.send(JSON.stringify(actionResult.data));
            pendingActions.delete(aiWs);
            break;
          }
        }
        return;
      }

      const action = actionRequestSchema.safeParse(parsed);
      if (action.success && role === "ai") {
        if (gameClient && gameClient.readyState === WebSocket.OPEN) {
          pendingActions.set(ws, action.data.payload.type);
          gameClient.send(JSON.stringify(action.data));
          return;
        }
        sendActionResult(ws, {
          ok: false,
          action: action.data.payload.type,
          reason: "No Minecraft bot connected. Open your world to LAN and run npm run companion."
        });
        return;
      }

      if (role === null) {
        ws.close(1008, "Send hello first: { type: 'hello', role: 'game' | 'ai' }");
      }
    });

    ws.on("close", () => {
      if (ws === gameClient) {
        gameClient = null;
        console.log("[bridge] Minecraft bot disconnected.");
      }
      aiClients.delete(ws);
      pendingActions.delete(ws);
    });
  });

  console.log(`[bridge] Listening on ws://localhost:${port}`);
  return wss;
}

function parsedResultMatches(
  payload: { ok: boolean; action: string },
  actionType: string
): boolean {
  return payload.ok && payload.action === actionType;
}

function sendState(ws: WebSocket, state: CompanionState): void {
  ws.send(JSON.stringify({ type: "state_update", payload: state }));
}

function sendActionResult(
  ws: WebSocket,
  payload: { ok: boolean; action: string; reason?: string }
): void {
  ws.send(JSON.stringify({ type: "action_result", payload }));
}
