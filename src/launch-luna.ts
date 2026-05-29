import "dotenv/config";
import { spawn, ChildProcess } from "node:child_process";
import { join } from "node:path";
import WebSocket from "ws";
import { checkOllamaHealth } from "./mc-ai/ollama";

const ROOT = join(__dirname, "..");
const port = Number(process.env.MC_SDK_PORT ?? "8787");
const bridgeUrl = `ws://127.0.0.1:${port}`;
const mcPort = process.env.MC_PORT ?? "25565";
const owner = process.env.MC_OWNER ?? "solonaras";

const children: ChildProcess[] = [];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function spawnNamed(
  name: string,
  npmScript: string,
  onLine?: (line: string) => void
): ChildProcess {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const proc = spawn(npm, ["run", npmScript], {
    cwd: ROOT,
    env: { ...process.env, MC_AI_BRIDGE_URL: bridgeUrl },
    stdio: ["ignore", "pipe", "pipe"],
    shell: true,
    windowsHide: true
  });

  const handleChunk = (chunk: Buffer, stream: NodeJS.WriteStream) => {
    const text = chunk.toString();
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      stream.write(`[${name}] ${line}\n`);
      onLine?.(line);
    }
  };

  proc.stdout?.on("data", (chunk) => handleChunk(chunk, process.stdout));
  proc.stderr?.on("data", (chunk) => handleChunk(chunk, process.stderr));
  proc.on("exit", (code, signal) => {
    if (signal) {
      console.log(`[${name}] stopped (${signal})`);
    } else if (code && code !== 0) {
      console.error(`[${name}] exited with code ${code}`);
    }
  });

  children.push(proc);
  return proc;
}

function waitForCompanionBridge(timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => {
        reject(new Error(`Companion bridge did not start within ${timeoutMs / 1000}s`));
      });
    }, timeoutMs);

    spawnNamed("companion", "companion", (line) => {
      if (/EADDRINUSE|address already in use/i.test(line)) {
        finish(() => {
          reject(
            new Error(
              `Port ${port} is already in use. Close the other Luna window or run "Stop Luna.bat", then try again.`
            )
          );
        });
        return;
      }
      if (/\[bridge\] Listening on/.test(line)) {
        finish(resolve);
      }
    });
  });
}

async function waitForBridge(timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let enobufsHits = 0;
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(bridgeUrl);
        const timer = setTimeout(() => {
          ws.terminate();
          reject(new Error("timeout"));
        }, 5000);
        ws.on("open", () => {
          clearTimeout(timer);
          ws.close();
          resolve();
        });
        ws.on("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/ENOBUFS|buffer space|queue was full/i.test(msg)) {
        enobufsHits += 1;
        const wait = Math.min(8000, 1500 * enobufsHits);
        console.warn(`[launcher] Windows socket exhaustion (ENOBUFS) — waiting ${wait / 1000}s…`);
        await sleep(wait);
      } else {
        await sleep(800);
      }
    }
  }
  return false;
}

function shutdown(): void {
  for (const proc of children) {
    if (!proc.killed) {
      proc.kill("SIGTERM");
    }
  }
}

async function main(): Promise<void> {
  console.log("");
  console.log("=== Luna Minecraft — all-in-one ===");
  console.log("");
  console.log("Before you play:");
  console.log(`  1. Open Minecraft ${process.env.MC_VERSION ?? "1.21.1"} single-player world`);
  console.log(`  2. Esc → Open to LAN  (port in .env: ${mcPort})`);
  console.log(`  3. Ollama running with ${process.env.MC_AI_MODEL ?? "qwen3.5:4b"}`);
  console.log("");
  console.log(`Owner: ${owner} | Bridge: ${bridgeUrl}`);
  console.log("Ctrl+C stops everything.");
  console.log("");

  process.on("SIGINT", () => {
    console.log("\n[launcher] Shutting down…");
    shutdown();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    shutdown();
    process.exit(0);
  });

  console.log("[launcher] Starting companion (bot + bridge)…");
  // Cleanup runs from Run Luna.bat before npm starts — do NOT run again here
  // (it used to kill the launch-luna node process and exit immediately).

  try {
    await waitForCompanionBridge(60_000);
    console.log("[launcher] Bridge process started — waiting for sockets to settle…");
    await sleep(3000);
    const bridgeOk = await waitForBridge(60_000);
    if (bridgeOk) {
      console.log("[launcher] Bridge ready.");
    } else {
      console.warn(
        "[launcher] Bridge probe failed (Windows ENOBUFS?) — starting AI anyway. Bot will keep retrying Minecraft."
      );
      console.warn("[launcher] Run Stop Luna.bat, wait 5s, or reboot if Luna never joins the world.");
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[launcher] ${msg}`);
    console.error("[launcher] Run Stop Luna.bat, then try again.");
    shutdown();
    process.exit(1);
  }

  console.log("[launcher] Starting Luna AI (chat + voice)…");

  const ollamaHost = (process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434").replace(/\/$/, "");
  const ollamaModel = (process.env.MC_AI_MODEL ?? "qwen3.5:4b").trim();
  const ollamaIssue = await checkOllamaHealth(ollamaHost, ollamaModel);
  if (ollamaIssue) {
    console.warn(`[launcher] WARNING: ${ollamaIssue}`);
    console.warn("[launcher] Start Ollama from the system tray, then talk to Luna again.\n");
  }

  spawnNamed("ai", "luna:ai");

  await new Promise(() => {});
}

void main().catch((err) => {
  console.error("[launcher]", err);
  shutdown();
  process.exit(1);
});
