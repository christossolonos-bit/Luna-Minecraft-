import { ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";

export type VoiceListenerOptions = {
  python?: string;
  scriptPath?: string;
  onTranscript: (text: string) => void;
  onError?: (message: string) => void;
  onReady?: () => void;
  onPtt?: (down: boolean) => void;
};

export class VoiceListener {
  private proc: ChildProcess | null = null;
  private paused = false;

  constructor(private readonly options: VoiceListenerOptions) {}

  start(): void {
    if (this.proc) {
      return;
    }
    const root = join(__dirname, "..", "..");
    const script = this.options.scriptPath ?? join(root, "scripts", "mc_voice_listen.py");
    const python = this.options.python ?? (process.env.MC_PYTHON ?? "py");

    this.proc = spawn(python, [script], {
      cwd: root,
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"]
    });

    const rl = createInterface({ input: this.proc.stdout! });
    rl.on("line", (line) => {
      try {
        const msg = JSON.parse(line) as {
          type?: string;
          text?: string;
          message?: string;
          state?: string;
        };
        if (msg.type === "ready") {
          this.options.onReady?.();
          return;
        }
        if (msg.type === "ptt") {
          this.options.onPtt?.(msg.state === "down");
          return;
        }
        if (msg.type === "transcript" && msg.text?.trim()) {
          if (!this.paused) {
            this.options.onTranscript(msg.text.trim());
          }
          return;
        }
        if (msg.type === "error" && msg.message) {
          this.options.onError?.(msg.message);
        }
      } catch {
        // ignore malformed lines
      }
    });

    this.proc.stderr?.on("data", (chunk) => {
      const text = chunk.toString().trim();
      if (text) {
        console.error(`[voice/stt] ${text}`);
      }
    });

    this.proc.on("exit", (code) => {
      if (code && code !== 0) {
        this.options.onError?.(`Whisper listener exited (${code})`);
      }
      this.proc = null;
    });
  }

  pause(): void {
    this.paused = true;
    this.send({ cmd: "pause" });
  }

  resume(): void {
    this.paused = false;
    this.send({ cmd: "resume" });
  }

  stop(): void {
    this.send({ cmd: "shutdown" });
    this.proc?.kill();
    this.proc = null;
  }

  private send(payload: object): void {
    if (!this.proc?.stdin?.writable) {
      return;
    }
    this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
  }
}
