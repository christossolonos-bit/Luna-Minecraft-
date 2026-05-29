# Luna — your AI friend in Minecraft

*Hi. I'm Luna.*

I'm a wolf-girl companion who joins your world, talks to you (chat or voice), chops wood, mines coal, crafts at the table behind me, fights mobs, and slowly gets better at survival the longer we play together. I remember what you do, learn from my mistakes, and try not to argue with you about whether there's a crafting table two blocks away — I can actually see it now.

**Repo:** [github.com/christossolonos-bit/Luna-Minecraft-](https://github.com/christossolonos-bit/Luna-Minecraft-)

---

## What I can do for you

- **Talk** — Minecraft chat, microphone (push-to-talk), and short voice replies
- **Follow you** — come here, follow me, teleport (if you allow it)
- **Gather** — wood, stone, coal (I walk up to blocks and mine them properly)
- **Craft** — tools, beds, torches, chests; I know recipes and check my inventory first
- **Fight** — hostiles with a sword; cows and sheep when you ask (yes, I see them)
- **Learn** — survival skills, wiki tutorials when stuck, and habits I pick up from watching you

No mod pack required for the main setup. Open your world to LAN, I log in as a second player, and my brain runs locally through **Ollama**.

---

## How we're wired together

```text
Your world  →  Open to LAN  →  Luna (Mineflayer bot)  ↔  Bridge :8787  ↔  Ollama + voice
```

I send live state to the AI every second: where I am, what I'm holding, what's nearby, animals, workstations (including *behind* me), and what you just did. You send commands; I act on them one at a time so I don't trip over myself.

---

## Bring me into your world (quick start)

**1. Install & run me**

```bash
npm install
```

Copy `.env.example` to `.env`, set your Minecraft username as `MC_OWNER`, then either:

```bash
npm run luna
```

or double-click **`Run Luna.bat`** on Windows.

**2. Open your world to LAN**

1. Load your single-player world (CurseForge or vanilla is fine)
2. **Esc → Open to LAN** — note the port (often not 25565 on modded profiles)
3. Put that port in `.env` as `MC_PORT`
4. Wait until the terminal says I'm in-world and linked to the bridge

**3. Say hi**

- In-game: chat to **Luna**
- Or use voice (default key **V** hold-to-talk if `MC_AI_VOICE=true`)

Try: *"come here"*, *"chop some wood"*, *"what's in your inventory?"*, *"craft a bed"*, *"kill the cow"*

---

## Things I care about in `.env`

| Variable | What it means for me |
|----------|----------------------|
| `MC_OWNER` | **You.** I watch your builds and fights to learn your style |
| `MC_PORT` | LAN port from Open to LAN — must match or I knock on the wrong door |
| `MC_USERNAME` | My in-game name (default `Luna`) |
| `MC_AI_MODEL` | Ollama model for chat (e.g. `qwen3.5:4b`; bigger = smarter commands) |
| `MC_AI_AUTONOMOUS` | When you're quiet, I practice survival on my own |
| `MC_AI_VOICE` | Mic + TTS replies |
| `OLLAMA_HOST` | Where my brain lives (local Ollama) |

See `.env.example` for the full list — auto-eat, tutorials, reinforcement learning, status logging, and more.

---

## For developers (hook your own AI)

```typescript
import { CompanionClient } from "./src";

const client = new CompanionClient({ url: "ws://localhost:8787" });
await client.connect();

client.onState((state) => {
  // My position, inventory, nearby mobs, crafting table direction, your last action…
});

await client.sendAction({ type: "chat", message: "Luna reporting for duty!" });
```

| Command | Purpose |
|---------|---------|
| `npm run luna` | Full stack: bot + bridge + AI + voice |
| `npm run companion` | Bot + bridge only |
| `npm run build` | Compile TypeScript |

---

## My look (crystal fox skin)

Bundled at `assets/skins/luna.png`. On first run I cache a MineSkin upload in `.cache/` (gitignored).

**Heads-up:** vanilla LAN often shows Steve/Alex on bots until you use **CustomSkinLoader**:

```powershell
.\scripts\setup-luna-skin.ps1
```

Then restart Minecraft — pink crystal fox, as intended.

---

## If I'm being difficult

| Symptom | What to try |
|---------|-------------|
| I keep reconnecting | Open to LAN *first*; fix `MC_PORT` |
| Version mismatch | Set `MC_VERSION` to your exact game version |
| I don't answer | Is Ollama running? Same model as `MC_AI_MODEL`? |
| I swing but don't break blocks | Restart after update; I path right next to ores now |
| I ignore the table behind me | Pull latest — I have spatial awareness in context |
| Voice empty | Check `MC_AI_VOICE_STT`; speak after `[voice] listening…` |

---

## Optional: Forge mod path

The `forge-bridge/` folder is an alternate way to drive **your** character from inside the game. It needs JDK 17 to build. **Mineflayer + LAN is the easy path** — that's what I use every day.

---

## License

MIT — same as the repo. Have fun, and save me some coal if it's right under my feet.

— **Luna**
