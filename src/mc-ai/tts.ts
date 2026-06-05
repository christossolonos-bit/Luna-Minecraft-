import { execSync, spawn } from "node:child_process";
import { createWriteStream, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UniversalEdgeTTS } from "edge-tts-universal";

export type McTtsConfig = {
  voice: string;
  rate: string;
  pitch: string;
  maxChars: number;
};

/** Default: Microsoft Edge Ava Multilingual (en-US). */
export const DEFAULT_TTS_VOICE = "en-US-AvaMultilingualNeural";

/** Short names from .env → Edge TTS neural voice ids. */
const VOICE_ALIASES: Record<string, string> = {
  ava: DEFAULT_TTS_VOICE,
  "ava-multilingual": DEFAULT_TTS_VOICE,
  "ava-multolingual": DEFAULT_TTS_VOICE,
  "ava-multilingual-neural": DEFAULT_TTS_VOICE,
  aria: "en-US-AriaNeural",
  jenny: "en-US-JennyNeural",
  sonia: "en-GB-SoniaNeural"
};

function normalizeVoiceKey(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, "-");
}

export function resolveTtsVoice(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return DEFAULT_TTS_VOICE;
  }
  if (trimmed.includes("Neural") || trimmed.includes("-")) {
    const alias = VOICE_ALIASES[normalizeVoiceKey(trimmed)];
    if (alias) {
      return alias;
    }
    return trimmed;
  }
  return VOICE_ALIASES[normalizeVoiceKey(trimmed)] ?? trimmed;
}

export function loadMcTtsConfig(): McTtsConfig {
  return {
    voice: resolveTtsVoice(process.env.MC_TTS_VOICE ?? "ava-multilingual"),
    rate: (process.env.MC_TTS_RATE ?? "+0%").trim(),
    pitch: (process.env.MC_TTS_PITCH ?? "+0Hz").trim(),
    maxChars: Math.max(80, Number(process.env.MC_TTS_MAX_CHARS ?? "400") || 400)
  };
}

export function cleanForTts(text: string, maxChars: number): string {
  return text
    .replace(/<\s*\/?\s*(think|thinking|reasoning)\s*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/[*_#`~[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars);
}

export async function synthesizeSpeech(text: string, config: McTtsConfig): Promise<Buffer> {
  const cleaned = cleanForTts(text, config.maxChars);
  if (!cleaned) {
    return Buffer.alloc(0);
  }
  const tts = new UniversalEdgeTTS(cleaned, config.voice, {
    rate: config.rate,
    pitch: config.pitch
  });
  const result = await tts.synthesize();
  return Buffer.from(await result.audio.arrayBuffer());
}

let ffplayPath: string | null | undefined;

function getFfplay(): string | null {
  if (ffplayPath !== undefined) {
    return ffplayPath;
  }
  try {
    const cmd = process.platform === "win32" ? "where ffplay" : "which ffplay";
    const out = execSync(cmd, { encoding: "utf8" });
    ffplayPath = out.split(/\r?\n/).find((l) => l.trim())?.trim() || null;
  } catch {
    ffplayPath = null;
  }
  return ffplayPath;
}

export async function playMp3(buffer: Buffer): Promise<void> {
  if (!buffer.length) {
    return;
  }
  const path = join(tmpdir(), `luna-mc-tts-${Date.now()}.mp3`);
  await new Promise<void>((resolve, reject) => {
    const ws = createWriteStream(path);
    ws.on("error", reject);
    ws.on("finish", resolve);
    ws.end(buffer);
  });

  const player = getFfplay();
  try {
    if (player) {
      await new Promise<void>((resolve, reject) => {
        const proc = spawn(player, ["-nodisp", "-autoexit", "-loglevel", "quiet", path], {
          stdio: "ignore"
        });
        proc.on("error", reject);
        proc.on("close", () => resolve());
      });
      return;
    }
    if (process.platform === "win32") {
      console.warn("[voice/tts] ffplay not found — install ffmpeg on PATH for audio playback.");
    }
  } finally {
    try {
      unlinkSync(path);
    } catch {
      // ignore
    }
  }
}

export async function speak(text: string, config: McTtsConfig): Promise<void> {
  const audio = await synthesizeSpeech(text, config);
  await playMp3(audio);
}
