import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { CompanionState } from "../types";
import { McAiConfig } from "./config";
import { parseTurnResponse, McTurnResult } from "./actions";
import { ollamaChat, ChatMessage } from "./ollama";
import { buildMcSystemPrompt } from "./persona";
import { formatCompanionContextForLlm } from "./companion-context";

export class McBrain {
  private readonly memory: ChatMessage[] = [];
  private readonly seenBuildKeys = new Set<string>();
  private learningSummary = "";
  private observationSummary = "";
  private autonomousSummary = "";
  private survivalSummary = "";
  private tutorialSummary = "";
  private statusSummary = "";

  constructor(private readonly config: McAiConfig) {
    this.loadMemory();
  }

  setAutonomousSummary(summary: string): void {
    this.autonomousSummary = summary;
  }

  setSurvivalSummary(summary: string): void {
    this.survivalSummary = summary;
  }

  setTutorialSummary(summary: string): void {
    this.tutorialSummary = summary;
  }

  setStatusSummary(summary: string): void {
    this.statusSummary = summary;
  }

  setLearningSummary(summary: string): void {
    this.learningSummary = summary;
  }

  setObservationSummary(summary: string): void {
    this.observationSummary = summary;
  }

  private loadMemory(): void {
    try {
      const raw = readFileSync(this.config.memoryFile, "utf-8");
      const parsed = JSON.parse(raw) as ChatMessage[];
      if (Array.isArray(parsed)) {
        for (const msg of parsed.slice(-this.config.memoryTurns * 2)) {
          if (msg.role && msg.content) {
            this.memory.push({ role: msg.role, content: msg.content });
          }
        }
      }
    } catch {
      // no memory file yet
    }
  }

  private persistMemory(): void {
    try {
      mkdirSync(dirname(this.config.memoryFile), { recursive: true });
      writeFileSync(this.config.memoryFile, JSON.stringify(this.memory, null, 2), "utf-8");
    } catch {
      // best effort
    }
  }

  private gameContext(state: CompanionState | null): string {
    if (!state) {
      return "GAME STATE: not connected to Minecraft yet.";
    }

    const core = formatCompanionContextForLlm(state, {
      ownerName: this.config.owner,
      statusLine: this.statusSummary || undefined
    });

    const extras: string[] = [];
    if (this.learningSummary) {
      extras.push(this.learningSummary);
    }
    if (this.observationSummary) {
      extras.push(this.observationSummary);
    }
    if (this.survivalSummary) {
      extras.push(this.survivalSummary);
    } else if (this.autonomousSummary) {
      extras.push(this.autonomousSummary);
    }
    if (this.tutorialSummary) {
      extras.push(this.tutorialSummary);
    }

    const full = extras.length ? `${core}\n${extras.join("\n")}` : core;

    if (process.env.MC_AI_LOG_CONTEXT === "true") {
      console.log(`[context] ${full.length} chars → LLM\n${full.slice(0, 1200)}${full.length > 1200 ? "…" : ""}`);
    }

    return full;
  }

  async replyTurn(
    message: string,
    state: CompanionState | null,
    source = "Minecraft chat"
  ): Promise<McTurnResult> {
    const userContent =
      `[${this.config.owner} via ${source}]: ${message.trim()}\n\n` +
      `--- GAME STATE (live from Minecraft) ---\n${this.gameContext(state)}`.trim();

    const messages: ChatMessage[] = [
      { role: "system", content: buildMcSystemPrompt(this.config.owner) },
      ...this.memory.slice(-this.config.memoryTurns * 2),
      { role: "user", content: userContent }
    ];

    const raw = await ollamaChat({
      host: this.config.ollamaHost,
      model: this.config.model,
      messages,
      numPredict: Math.max(this.config.numPredict, 128),
      temperature: this.config.temperature
    });

    const turn = parseTurnResponse(raw, message);

    if (turn.say) {
      this.memory.push({ role: "user", content: userContent });
      this.memory.push({ role: "assistant", content: turn.say });
      while (this.memory.length > this.config.memoryTurns * 2) {
        this.memory.shift();
      }
      this.persistMemory();
    }

    return turn;
  }

  async reply(
    message: string,
    state: CompanionState | null,
    source = "Minecraft chat"
  ): Promise<string> {
    const turn = await this.replyTurn(message, state, source);
    return turn.say;
  }

  /** Returns a prompt for a new build event, or null if already seen. */
  popNewBuildEvent(state: CompanionState | null): string | null {
    if (!state) {
      return null;
    }
    for (const ev of state.recentBuildEvents) {
      const key = `${ev.kind}:${ev.blockId}:${ev.position.x},${ev.position.y},${ev.position.z}`;
      if (this.seenBuildKeys.has(key)) {
        continue;
      }
      this.seenBuildKeys.add(key);
      const verb = ev.kind === "place_block" ? "placed" : "broke";
      return `(They ${verb} ${ev.blockId}.) React in one short line.`;
    }
    return null;
  }
}

export function chunkChat(text: string, limit: number): string[] {
  const cleaned = text.trim();
  if (!cleaned) {
    return [];
  }
  const parts: string[] = [];
  let rest = cleaned;
  while (rest.length > 0) {
    parts.push(rest.slice(0, limit));
    rest = rest.slice(limit).trimStart();
  }
  return parts;
}
