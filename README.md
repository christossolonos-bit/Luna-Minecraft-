# Minecraft Companion SDK (Mineflayer)

Control a Minecraft companion bot and stream live state to your AI over a local WebSocket bridge.

**No mod building. No JDK.** Works with worlds launched from CurseForge or vanilla.

## How it works

```text
[Your world] ← Open to LAN ← [Mineflayer bot "Luna"] ←→ [Bridge :8787] ←→ [Your AI / SDK]
```

The bot joins your LAN world as a second player. Your AI connects to the same bridge and sends actions (move, mine, place, chat).

## Quick start

```bash
npm install
npm run companion
```

Then in Minecraft:

1. Open your single-player world
2. **Esc → Open to LAN** (note the port — default `25565`)
3. Wait for terminal: `[bot] In world and linked to SDK bridge.`

Test the SDK (second terminal):

```bash
npx tsx examples/quickstart.ts
```

## Environment variables

Copy `.env.example` and set as needed:

| Variable | Default | Purpose |
|----------|---------|---------|
| `MC_SDK_PORT` | `8787` | WebSocket bridge port |
| `MC_HOST` | `localhost` | LAN server host |
| `MC_PORT` | `25565` | LAN port from Open to LAN |
| `MC_USERNAME` | `Luna` | Bot name in-world |
| `MC_VERSION` | auto | Set e.g. `1.20.1` if connect fails |
| `MC_OWNER` | — | Your username (tracks *your* build events) |

## CurseForge notes

- Use a profile whose Minecraft version matches `MC_VERSION` (or leave auto).
- **Open to LAN** must be enabled while playing.
- If LAN uses a non-default port, set `MC_PORT` to match.
- Modded blocks still work; the bot uses normal player actions.

## SDK usage (for your AI companion)

```typescript
import { CompanionClient } from "./src";

const client = new CompanionClient({ url: "ws://localhost:8787" });
await client.connect();

client.onState((state) => {
  // bot position, held item, nearby blocks, recent build events (incl. yours if MC_OWNER set)
});

await client.sendAction({ type: "chat", message: "Ready to help with your build!" });
```

## Scripts

| Command | What it does |
|---------|----------------|
| `npm run companion` | Bridge + Mineflayer bot (main) |
| `npm run dev` | Bridge only (no bot) |
| `npm run build` | Compile TypeScript |

## Optional: Forge mod path

The `forge-bridge/` folder is an alternate in-game approach (controls your own character). It requires JDK 17 to build. **Mineflayer is the recommended simple path.**

## Luna's skin (crystal fox girl)

Your skin file is bundled at `assets/skins/luna.png` (copied from your Luna Highlights art).

The bot uploads it to [MineSkin](https://mineskin.org/) on first run (cached in `.cache/luna-skin.json`) and applies it to the Luna bot profile.

**Important for vanilla Open to LAN:** Minecraft often still shows Steve/Alex for offline bots. To **see** Luna's skin on your screen:

1. Install the [CustomSkinLoader](https://github.com/xfl03/MCCustomSkinLoader) mod in your **1.21.1** profile (Forge/Fabric).
2. Run:

```powershell
.\scripts\setup-luna-skin.ps1
```

3. Restart Minecraft. Luna should appear with the pink crystal fox skin.

Optional `.env`:

```env
MC_SKIN_PATH=assets/skins/luna.png
MC_SKIN_MODEL=slim
```

## Troubleshooting

- **Bot keeps retrying** — Open to LAN first, confirm `MC_PORT`.
- **Version errors** — Set `MC_VERSION=1.20.1` (or your exact version).
- **No state in SDK** — Run `npm run companion` before `quickstart.ts`.
- **Track your building** — Set `MC_OWNER` to your Minecraft username.
