package com.luna.companionbridge;

import com.google.gson.JsonObject;
import net.minecraft.client.Minecraft;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.network.chat.Component;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.item.BlockItem;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.Vec3;
import net.minecraftforge.registries.ForgeRegistries;

public final class ActionHandler {
    private static Vec3 moveTarget;
    private static boolean sprintMove;
    private static boolean miningActive;
    private static BlockPos miningPos;

    private ActionHandler() {
    }

    public static void tick(LocalPlayer player) {
        if (player == null) {
            return;
        }
        tickMovement(player);
        tickMining(player);
    }

    public static JsonObject handle(JsonObject payload) {
        String type = payload.get("type").getAsString();
        Minecraft minecraft = Minecraft.getInstance();
        LocalPlayer player = minecraft.player;

        if (player == null || minecraft.level == null) {
            return failure(type, "Player is not in a world.");
        }

        return switch (type) {
            case "move_to" -> moveTo(player, payload);
            case "look_at" -> lookAt(player, payload);
            case "mine_block" -> mineBlock(minecraft, payload);
            case "place_block" -> placeBlock(minecraft, payload);
            case "chat" -> chat(player, payload);
            case "stop_all" -> stopAll(player, payload);
            default -> failure(type, "Unsupported action.");
        };
    }

    public static void stopAll(LocalPlayer player) {
        moveTarget = null;
        miningActive = false;
        miningPos = null;
        player.getNavigation().stop();
        Minecraft.getInstance().gameMode.stopDestroyBlock();
    }

    private static JsonObject moveTo(LocalPlayer player, JsonObject payload) {
        JsonObject target = payload.getAsJsonObject("target");
        moveTarget = new Vec3(target.get("x").getAsDouble(), target.get("y").getAsDouble(), target.get("z").getAsDouble());
        sprintMove = payload.has("sprint") && payload.get("sprint").getAsBoolean();
        player.getNavigation().moveTo(moveTarget.x, moveTarget.y, moveTarget.z, sprintMove ? 1.2D : 0.9D);
        return success("move_to");
    }

    private static JsonObject lookAt(LocalPlayer player, JsonObject payload) {
        JsonObject target = payload.getAsJsonObject("target");
        Vec3 eye = player.getEyePosition();
        Vec3 look = new Vec3(target.get("x").getAsDouble(), target.get("y").getAsDouble(), target.get("z").getAsDouble());
        Vec3 delta = look.subtract(eye);
        double horizontal = Math.sqrt(delta.x * delta.x + delta.z * delta.z);
        float pitch = (float) (-Math.toDegrees(Math.atan2(delta.y, horizontal)));
        float yaw = (float) (Math.toDegrees(Math.atan2(-delta.x, delta.z)));
        player.setYRot(yaw);
        player.setXRot(pitch);
        return success("look_at");
    }

    private static JsonObject mineBlock(Minecraft minecraft, JsonObject payload) {
        JsonObject target = payload.getAsJsonObject("target");
        miningPos = BlockPos.containing(target.get("x").getAsDouble(), target.get("y").getAsDouble(), target.get("z").getAsDouble());
        miningActive = true;
        minecraft.gameMode.startDestroyBlock(miningPos, Direction.UP);
        return success("mine_block");
    }

    private static JsonObject placeBlock(Minecraft minecraft, JsonObject payload) {
        String blockId = payload.get("blockId").getAsString();
        JsonObject target = payload.getAsJsonObject("target");
        BlockPos placePos = BlockPos.containing(target.get("x").getAsDouble(), target.get("y").getAsDouble(), target.get("z").getAsDouble());

        LocalPlayer player = minecraft.player;
        if (player == null) {
            return failure("place_block", "No player.");
        }

        int slot = findHotbarSlot(player, blockId);
        if (slot < 0) {
            return failure("place_block", "Block not found in hotbar: " + blockId);
        }

        int previous = player.getInventory().selected;
        player.getInventory().selected = slot;

        BlockHitResult hit = new BlockHitResult(Vec3.atCenterOf(placePos), Direction.UP, placePos.below(), false);
        boolean placed = minecraft.gameMode.useItemOn(player, InteractionHand.MAIN_HAND, hit).consumesAction();
        player.getInventory().selected = previous;

        return placed ? success("place_block") : failure("place_block", "Could not place block.");
    }

    private static JsonObject chat(LocalPlayer player, JsonObject payload) {
        String message = payload.get("message").getAsString();
        if (player.connection != null) {
            player.connection.sendChat(message);
        } else {
            player.displayClientMessage(Component.literal(message), false);
        }
        return success("chat");
    }

    private static JsonObject stopAll(LocalPlayer player, JsonObject payload) {
        stopAll(player);
        return success("stop_all");
    }

    private static void tickMovement(LocalPlayer player) {
        if (moveTarget == null) {
            return;
        }
        if (player.position().distanceTo(moveTarget) < 1.25D) {
            moveTarget = null;
            player.getNavigation().stop();
            return;
        }
        if (!player.getNavigation().isInProgress()) {
            player.getNavigation().moveTo(moveTarget.x, moveTarget.y, moveTarget.z, sprintMove ? 1.2D : 0.9D);
        }
    }

    private static void tickMining(Minecraft minecraft) {
        if (!miningActive || miningPos == null) {
            return;
        }
        boolean finished = minecraft.gameMode.continueDestroyBlock(miningPos, Direction.UP);
        if (finished) {
            miningActive = false;
            miningPos = null;
        }
    }

    private static int findHotbarSlot(LocalPlayer player, String blockId) {
        ResourceLocation wanted = ResourceLocation.tryParse(blockId.contains(":") ? blockId : "minecraft:" + blockId);
        if (wanted == null) {
            return -1;
        }

        for (int slot = 0; slot < 9; slot++) {
            ItemStack stack = player.getInventory().getItem(slot);
            if (stack.isEmpty() || !(stack.getItem() instanceof BlockItem blockItem)) {
                continue;
            }
            BlockState state = blockItem.getBlock().defaultBlockState();
            ResourceLocation id = ForgeRegistries.BLOCKS.getKey(state.getBlock());
            if (wanted.equals(id)) {
                return slot;
            }
        }
        return -1;
    }

    private static JsonObject success(String action) {
        JsonObject root = new JsonObject();
        root.addProperty("type", "action_result");
        JsonObject payload = new JsonObject();
        payload.addProperty("ok", true);
        payload.addProperty("action", action);
        root.add("payload", payload);
        return root;
    }

    private static JsonObject failure(String action, String reason) {
        JsonObject root = new JsonObject();
        root.addProperty("type", "action_result");
        JsonObject payload = new JsonObject();
        payload.addProperty("ok", false);
        payload.addProperty("action", action);
        payload.addProperty("reason", reason);
        root.add("payload", payload);
        return root;
    }
}
