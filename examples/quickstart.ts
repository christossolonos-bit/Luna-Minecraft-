import { CompanionClient } from "../src";

async function main() {
  const client = new CompanionClient({
    url: "ws://localhost:8787",
    safety: {
      allowBreakBlocks: true,
      allowPlaceBlocks: true,
      maxMoveDistance: 48
    }
  });

  await client.connect();
  console.log("Connected to bridge. Waiting for Minecraft state...");

  client.onState((state) => {
    console.log(
      `[${state.player.username}] pos=(${state.player.position.x.toFixed(1)}, ${state.player.position.y.toFixed(1)}, ${state.player.position.z.toFixed(1)}) held=${state.player.heldItem ?? "empty"}`
    );
  });

  client.onActionResult((result) => {
    console.log("Action result:", result);
  });

  await new Promise((resolve) => setTimeout(resolve, 3000));

  const chat = await client.sendAction({
    type: "chat",
    message: "Luna companion SDK is connected."
  });
  console.log("chat:", chat);

  const state = client.getState();
  if (!state) {
    console.log("No live state yet. Run: npm run companion (with world open to LAN).");
    return;
  }

  const here = state.player.position;
  const move = await client.sendAction({
    type: "move_to",
    target: { x: here.x + 2, y: here.y, z: here.z + 2 }
  });
  console.log("move_to:", move);
}

void main();
