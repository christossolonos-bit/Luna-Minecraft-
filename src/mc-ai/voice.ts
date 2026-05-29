import { VoiceListener } from "./stt";
import { loadMcTtsConfig, speak, McTtsConfig } from "./tts";

export type McVoiceOptions = {
  enabled: boolean;
  sttEnabled: boolean;
  ttsEnabled: boolean;
  onTranscript: (text: string) => void;
};

export class McVoice {
  private listener: VoiceListener | null = null;
  private speaking = false;
  private pttActive = false;
  private transcribing = false;
  private readonly ttsConfig: McTtsConfig;

  constructor(private readonly options: McVoiceOptions) {
    this.ttsConfig = loadMcTtsConfig();
  }

  /** True while mic PTT, whisper, or TTS is active — defer heavy bot tasks. */
  isBusy(): boolean {
    return this.speaking || this.pttActive || this.transcribing;
  }

  start(): void {
    if (!this.options.enabled || !this.options.sttEnabled) {
      if (this.options.ttsEnabled) {
        console.log(`[voice] TTS: ${this.ttsConfig.voice}`);
      }
      return;
    }
    this.listener = new VoiceListener({
      onTranscript: (text) => {
        this.transcribing = false;
        if (!this.speaking) {
          this.options.onTranscript(text);
        }
      },
      onReady: () => {
        const key = (process.env.MC_STT_PTT_KEY ?? "v").toUpperCase();
        const mode = (process.env.MC_STT_MODE ?? "ptt").toLowerCase();
        if (mode === "vad") {
          console.log("[voice] Whisper mic ready — speak to Luna.");
        } else {
          console.log(`[voice] Push-to-talk ready — hold ${key} while speaking.`);
        }
      },
      onPtt: (down) => {
        if (down) {
          if (this.pttActive) {
            return;
          }
          this.pttActive = true;
          this.transcribing = false;
          process.stdout.write("\r[voice] listening…          ");
        } else {
          if (!this.pttActive) {
            return;
          }
          this.pttActive = false;
          this.transcribing = true;
          process.stdout.write("\r[voice] transcribing…       \n");
        }
      },
      onError: (msg) => {
        this.transcribing = false;
        console.error(`[voice] ${msg}`);
      }
    });
    this.listener.start();
    console.log(`[voice] STT: faster-whisper | TTS: ${this.ttsConfig.voice}`);
  }

  async speak(text: string): Promise<void> {
    if (!this.options.ttsEnabled || !text.trim()) {
      return;
    }
    this.speaking = true;
    this.listener?.pause();
    try {
      await speak(text, this.ttsConfig);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[voice/tts] ${msg}`);
    } finally {
      this.speaking = false;
      this.listener?.resume();
    }
  }

  stop(): void {
    this.listener?.stop();
    this.listener = null;
  }
}

export function voiceEnabledFromEnv(): { enabled: boolean; stt: boolean; tts: boolean } {
  const master = process.env.MC_AI_VOICE !== "false";
  const stt = master && process.env.MC_AI_VOICE_STT !== "false";
  const tts = master && process.env.MC_AI_VOICE_TTS !== "false";
  return { enabled: master, stt, tts };
}
