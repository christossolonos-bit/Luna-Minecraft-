# Luna — Minecraft companion

Luna joins your **Open to LAN** world as a second player.

**Simple mode (default):**

| What | How |
|------|-----|
| **Follow** | Chat: `follow me` — `stop` to cancel |
| **Teleport** | Chat: `tp to me` (needs `MC_ALLOW_TP=true`) |
| **Gather wood** | Chat: `gather wood` — chops a tree bottom-to-top (log pillars to climb), stashes logs in a **double chest** on the way down |
| **Stash** | Chat: `put in chest` |
| **Take tools** | Chat: `take pickaxe` or `take axe` (from nearby chest) |
| **Sleep** | Get in your bed at night — she uses or places her own bed |

Set `MC_AI_MODE=full` for the older full AI stack (Ollama, voice, gather, etc.).

**Repo:** [github.com/christossolonos-bit/Luna-Minecraft-](https://github.com/christossolonos-bit/Luna-Minecraft-)

---

## Quick start

1. `npm install`
2. Copy `.env.example` → `.env`, set `MC_OWNER` and `MC_PORT` (from Open to LAN)
3. **`Run Luna.bat`** or `npm run luna`

---

## `.env` essentials

| Variable | Purpose |
|----------|---------|
| `MC_OWNER` | Your Minecraft username |
| `MC_VERSION` | `1.21.1` — must match F3 in-game |
| `MC_PORT` | LAN port |
| `MC_AI_MODE` | `simple` (default) or `full` |
| `MC_ALLOW_TP` | `true` for `tp to me` |
| `MC_SYNC_OWNER_SLEEP` | `true` — sleep with you |
