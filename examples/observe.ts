import { CompanionClient } from "../src";

/**
 * Watch Luna observe you: position, blocks you place/break, and chat.
 * Set MC_OWNER in .env to your exact Minecraft username first.
 */
async function main() {
  const client = new CompanionClient({ url: "ws://localhost:8787" });
  await client.connect();

  console.log("Observing... Build near Luna. Type in Minecraft chat to talk to your AI.");
  console.log("(Press Ctrl+C to stop)\n");

  const seenBuilds = new Set<string>();

  client.onState((state) => {
    if (state.owner) {
      const o = state.owner;
      console.log(
        `[you] pos=(${o.position.x.toFixed(1)}, ${o.position.y.toFixed(1)}, ${o.position.z.toFixed(1)}) held=${o.heldItem ?? "empty"}`
      );
    }

    for (const event of state.recentBuildEvents) {
      const key = `${event.kind}:${event.blockId}:${event.position.x},${event.position.y},${event.position.z}`;
      if (seenBuilds.has(key)) {
        continue;
      }
      seenBuilds.add(key);
      const who = state.owner ? "you" : "someone";
      console.log(`[learn] ${who} ${event.kind} ${event.blockId} at ${JSON.stringify(event.position)}`);
    }
  });

  client.onPlayerChat((chat) => {
    console.log(`[chat] ${chat.username}: ${chat.message}`);
  });

  await new Promise(() => {});
}

void main();
