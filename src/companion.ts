import "dotenv/config";
import { startBridge } from "./bridge";
import { startMineflayerGame } from "./mineflayer-bot";

const port = Number(process.env.MC_SDK_PORT ?? "8787");

startBridge({ port });

void startMineflayerGame({
  bridgeUrl: `ws://127.0.0.1:${port}`
});

console.log("");
console.log("=== Luna Companion (Mineflayer) ===");
console.log("1) Open your Minecraft single-player world");
const mcPort = process.env.MC_PORT ?? "25565";
console.log(`2) Esc → Open to LAN (your port: ${mcPort})`);
console.log("3) Or run everything: npm run luna  (or double-click Run Luna.bat)");
console.log("");
