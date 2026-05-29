package com.luna.companionbridge;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import net.minecraft.client.Minecraft;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.biome.Biome;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraftforge.registries.ForgeRegistries;

import java.util.HashSet;
import java.util.Set;

public final class StateCollector {
    private StateCollector() {
    }

    public static JsonObject collect() {
        Minecraft minecraft = Minecraft.getInstance();
        LocalPlayer player = minecraft.player;
        Level level = minecraft.level;

        JsonObject root = new JsonObject();
        root.addProperty("type", "state_update");

        JsonObject payload = new JsonObject();
        payload.add("player", playerSnapshot(player));
        payload.add("world", worldSnapshot(level, player));
        payload.add("recentBuildEvents", BuildEventTracker.recentEvents());
        root.add("payload", payload);
        return root;
    }

    private static JsonObject playerSnapshot(LocalPlayer player) {
        JsonObject json = new JsonObject();
        if (player == null) {
            json.addProperty("username", "unknown");
            json.add("position", vec3(0, 64, 0));
            json.addProperty("yaw", 0);
            json.addProperty("pitch", 0);
            json.addProperty("health", 0);
            json.addProperty("hunger", 0);
            return json;
        }

        json.addProperty("username", player.getGameProfile().getName());
        json.add("position", vec3(player.getX(), player.getY(), player.getZ()));
        json.addProperty("yaw", player.getYRot());
        json.addProperty("pitch", player.getXRot());
        json.addProperty("health", player.getHealth());
        json.addProperty("hunger", player.getFoodData().getFoodLevel());

        ItemStack held = player.getMainHandItem();
        if (!held.isEmpty()) {
            ResourceLocation id = ForgeRegistries.ITEMS.getKey(held.getItem());
            if (id != null) {
                json.addProperty("heldItem", id.toString());
            }
        }
        return json;
    }

    private static JsonObject worldSnapshot(Level level, LocalPlayer player) {
        JsonObject json = new JsonObject();
        if (level == null) {
            json.addProperty("dimension", "minecraft:overworld");
            return json;
        }

        ResourceLocation dimension = level.dimension().location();
        json.addProperty("dimension", dimension.toString());
        json.addProperty("timeOfDay", level.getDayTime() % 24000L);

        if (player != null) {
            BlockPos pos = player.blockPosition();
            Biome biome = level.getBiome(pos).value();
            ResourceLocation biomeId = level.registryAccess().registryOrThrow(Registries.BIOME).getKey(biome);
            if (biomeId != null) {
                json.addProperty("biome", biomeId.toString());
            }
            json.add("nearbyBlocks", nearbyBlocks(level, pos));
        }
        return json;
    }

    private static JsonArray nearbyBlocks(Level level, BlockPos center) {
        Set<String> blocks = new HashSet<>();
        for (int x = -2; x <= 2; x++) {
            for (int y = -1; y <= 2; y++) {
                for (int z = -2; z <= 2; z++) {
                    BlockState state = level.getBlockState(center.offset(x, y, z));
                    ResourceLocation id = ForgeRegistries.BLOCKS.getKey(state.getBlock());
                    if (id != null && !state.isAir()) {
                        blocks.add(id.toString());
                    }
                }
            }
        }

        JsonArray array = new JsonArray();
        blocks.stream().sorted().limit(12).forEach(array::add);
        return array;
    }

    private static JsonObject vec3(double x, double y, double z) {
        JsonObject json = new JsonObject();
        json.addProperty("x", x);
        json.addProperty("y", y);
        json.addProperty("z", z);
        return json;
    }
}
