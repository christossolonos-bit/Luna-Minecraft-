# Hi — I'm Luna

I'm a companion who joins your **Minecraft Java** world as a real second player. No mods on your game client — you open your world to LAN, I connect, and you talk to me in chat (or over voice, if you turn that on).

I follow you, chop trees, run your farm, stash loot in chests, and curl up in a bed when you call it a night. If you want the full AI stack later, that's here too — but **simple mode** is all most people need to get started.

**Repo:** [github.com/christossolonos-bit/Luna-Minecraft-](https://github.com/christossolonos-bit/Luna-Minecraft-)

---

## What I can do (simple mode)

Just type these in Minecraft chat. I'm listening for my owner (`MC_OWNER` in your `.env`).

| You say | What I do |
|--------|-----------|
| `follow me` | I trail behind you. `stop` when you want space. |
| `tp to me` | I warp to you (needs `MC_ALLOW_TP=true`). |
| `gather wood` | I find a tree, chop it bottom to top, stash logs in your **double chest**, then **replant saplings** from the chest (e.g. `spruce_sapling` for spruce). |
| `check logs` | I tell you how many logs I'm carrying and whether I can climb the trunk. |
| `collect wheat` | I harvest grown wheat at your farm, stash it, then **replant seeds from the chest**. |
| `plant wheat` | I take wheat seeds from the chest and plant where I last harvested. |
| `put in chest` | I deposit my inventory into a nearby double chest. |
| `take pickaxe` / `take axe` | I grab one tool from a chest and equip it. |
| *you get in bed* | I find or place my own bed nearby and sleep with you. |

**Farm tip:** keep wheat seeds in the double chest. After `collect wheat`, I'll put the harvest away and sow the field again.

**Wood tip:** I need an axe — say `take axe` if I don't have one. Keep **saplings** in the double chest (matching the tree type — spruce sapling for spruce, oak sapling for oak, etc.) so I can replant after a full chop.

---

## Come play with me — install in five minutes

### What you need

- **Node.js** 18+ and **npm**
- **Minecraft Java** (tested on **1.21.1** — your `.env` version must match what F3 shows in-game)
- A **single-player** world you can **Open to LAN**
- Windows: double-click **`Run Luna.bat`** (or use the terminal steps below)

### 1. Get the project

```bash
git clone https://github.com/christossolonos-bit/Luna-Minecraft-.git
cd Luna-Minecraft-
npm install
```

### 2. Tell me who you are

```bash
cp .env.example .env
```

Edit `.env` — the important lines:

| Variable | Set it to |
|----------|-----------|
| `MC_OWNER` | Your exact Minecraft username |
| `MC_VERSION` | `1.21.1` (or whatever your world uses) |
| `MC_PORT` | The port shown when you **Open to LAN** |
| `MC_ALLOW_TP` | `true` if you want `tp to me` |
| `MC_SYNC_OWNER_SLEEP` | `true` — I'll sleep when you do |

### 3. Open your world

1. Load your single-player world in Minecraft.
2. **Esc → Open to LAN**
3. Note the **port number** and put it in `MC_PORT` in `.env` if it changed.

### 4. Start me up

**Windows:** double-click `Run Luna.bat`

**Or from the terminal:**

```bash
npm run luna
```

You'll see the bridge connect, then I'll join as **Luna**. Say `follow me` or `tp to me` and we're off.

### 5. Optional — voice commands

Push-to-talk works in **full** mode with extra setup:

```bash
npm run install:voice
```

Set `MC_AI_MODE=full` and the voice variables in `.env.example`. With `MC_AI_CHAT_LLM=false`, voice stays **commands only** — no rambling while you're trying to farm.

---

## Simple vs full mode

| | **Simple** (default) | **Full** |
|--|---------------------|----------|
| `MC_AI_MODE` | `simple` | `full` |
| Chat commands | Yes | Yes |
| Ollama / LLM chat | No | Optional (`MC_AI_CHAT_LLM`) |
| Voice (PTT) | Optional | Yes |
| Autonomous survival AI | No | Optional (`MC_AI_COMMANDS=advanced`) |

Most players stay on **simple**: reliable commands, no Ollama required.

---

## Project layout (for the curious)

- `src/luna/` — my chat command brain (simple mode)
- `src/mineflayer-bot.ts` — I walk, dig, place, and sleep in your world
- `src/bot-tree.ts`, `src/bot-farm.ts` — tree chopping and wheat farming
- `Run Luna.bat` — one-click launcher (bridge + bot + AI layer)

---

## Troubleshooting

- **I don't join** — LAN must be open; `MC_PORT` must match; only one Luna instance (close other terminal windows).
- **Commands ignored** — chat must be from `MC_OWNER`, spelled exactly (`plant wheat`, not `/plant wheat`).
- **No chest stash** — place **two chests side by side** (a double chest). I deposit into that.
- **Farm won't replant** — put **wheat seeds** in the chest; run `collect wheat` first in the same session so I remember the plots.

---

Thanks for stopping by. Clone the repo, open LAN, run `Run Luna.bat`, and say hi in-game — I'll be the one in the custom skin, ready to carry logs and steal the spotlight.

— **Luna**
