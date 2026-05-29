import WebSocket from "ws";
import { actionResultSchema, playerChatSchema, stateUpdateSchema } from "./protocol";
import { SafetyGuard } from "./safety";
import {
  ActionResult,
  CompanionAction,
  CompanionState,
  PlayerChatMessage,
  SafetyPolicy
} from "./types";

export type CompanionClientOptions = {
  url: string;
  reconnectMs?: number;
  safety?: Partial<SafetyPolicy>;
  actionTimeoutMs?: number;
};

type StateHandler = (state: CompanionState) => void;
type ActionResultHandler = (result: ActionResult) => void;
type ChatHandler = (chat: PlayerChatMessage["payload"]) => void;

export class CompanionClient {
  private ws: WebSocket | null = null;
  private latestState: CompanionState | null = null;
  private readonly stateHandlers = new Set<StateHandler>();
  private readonly actionResultHandlers = new Set<ActionResultHandler>();
  private readonly chatHandlers = new Set<ChatHandler>();
  private readonly reconnectMs: number;
  private readonly actionTimeoutMs: number;
  private readonly safety: SafetyGuard;
  private readonly url: string;
  private manuallyClosed = false;
  private pendingAction: {
    resolve: (result: ActionResult) => void;
    timer: NodeJS.Timeout;
    actionType: string;
  } | null = null;

  constructor(options: CompanionClientOptions) {
    this.url = options.url;
    this.reconnectMs = options.reconnectMs ?? 1000;
    this.actionTimeoutMs = options.actionTimeoutMs ?? 8000;
    this.safety = new SafetyGuard(options.safety);
  }

  connect(): Promise<void> {
    this.manuallyClosed = false;
    return this.openSocket();
  }

  close(): void {
    this.manuallyClosed = true;
    this.clearPendingAction("Client closed.");
    this.ws?.close();
  }

  /** Free the action slot so a new command can run (e.g. owner interrupted a long task). */
  cancelPendingAction(reason = "Interrupted for new command."): void {
    this.clearPendingAction(reason);
  }

  onState(handler: StateHandler): () => void {
    this.stateHandlers.add(handler);
    return () => this.stateHandlers.delete(handler);
  }

  onActionResult(handler: ActionResultHandler): () => void {
    this.actionResultHandlers.add(handler);
    return () => this.actionResultHandlers.delete(handler);
  }

  onPlayerChat(handler: ChatHandler): () => void {
    this.chatHandlers.add(handler);
    return () => this.chatHandlers.delete(handler);
  }

  getState(): CompanionState | null {
    return this.latestState;
  }

  async sendAction(action: CompanionAction): Promise<ActionResult> {
    if (!this.latestState) {
      return {
        ok: false,
        action: action.type,
        reason: "No state available yet. Is Minecraft running with the bridge mod?"
      };
    }

    const rejectedReason = this.safety.validate(action, this.latestState);
    if (rejectedReason) {
      return {
        ok: false,
        action: action.type,
        reason: rejectedReason
      };
    }

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return {
        ok: false,
        action: action.type,
        reason: "WebSocket is not connected."
      };
    }

    if (this.pendingAction) {
      return {
        ok: false,
        action: action.type,
        reason: "Another action is still in progress."
      };
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingAction = null;
        resolve({
          ok: false,
          action: action.type,
          reason: "Action timed out waiting for Minecraft."
        });
      }, this.actionTimeoutMs);

      this.pendingAction = { resolve, timer, actionType: action.type };

      this.ws?.send(
        JSON.stringify({
          type: "action_request",
          payload: action
        })
      );
    });
  }

  private openSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      let opened = false;

      ws.on("open", () => {
        opened = true;
        ws.send(JSON.stringify({ type: "hello", role: "ai" }));
        resolve();
      });

      ws.on("message", (raw) => {
        try {
          const parsed = JSON.parse(raw.toString());
          const parsedState = stateUpdateSchema.safeParse(parsed);
          if (parsedState.success) {
            this.latestState = parsedState.data.payload;
            this.stateHandlers.forEach((handler) => handler(this.latestState as CompanionState));
            return;
          }

          const parsedChat = playerChatSchema.safeParse(parsed);
          if (parsedChat.success) {
            this.chatHandlers.forEach((handler) => handler(parsedChat.data.payload));
            return;
          }

          const parsedResult = actionResultSchema.safeParse(parsed);
          if (parsedResult.success) {
            const result: ActionResult = {
              ok: parsedResult.data.payload.ok,
              action: parsedResult.data.payload.action as CompanionAction["type"],
              reason: parsedResult.data.payload.reason
            };
            this.actionResultHandlers.forEach((handler) => handler(result));
            if (
              this.pendingAction &&
              (this.pendingAction.actionType === result.action || parsedResult.data.payload.ok)
            ) {
              clearTimeout(this.pendingAction.timer);
              this.pendingAction.resolve(result);
              this.pendingAction = null;
            }
          }
        } catch {
          // Intentionally ignore malformed packets.
        }
      });

      ws.on("close", () => {
        this.clearPendingAction("Connection closed.");
        if (!this.manuallyClosed) {
          this.scheduleReconnect();
        }
      });

      ws.on("error", (err) => {
        if (!opened) {
          reject(err);
        }
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.manuallyClosed) {
      return;
    }
    setTimeout(() => {
      void this.openSocket().catch(() => {
        this.scheduleReconnect();
      });
    }, this.reconnectMs);
  }

  private clearPendingAction(reason: string): void {
    if (!this.pendingAction) {
      return;
    }
    clearTimeout(this.pendingAction.timer);
    this.pendingAction.resolve({
      ok: false,
      action: this.pendingAction.actionType as CompanionAction["type"],
      reason
    });
    this.pendingAction = null;
  }
}
