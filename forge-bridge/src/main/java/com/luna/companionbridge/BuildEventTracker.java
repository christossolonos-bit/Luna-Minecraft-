package com.luna.companionbridge;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import net.minecraft.core.BlockPos;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraftforge.event.level.BlockEvent;
import net.minecraftforge.eventbus.api.SubscribeEvent;

import java.util.ArrayDeque;
import java.util.Deque;

public final class BuildEventTracker {
    private static final int MAX_EVENTS = 40;
    private static final Deque<JsonObject> EVENTS = new ArrayDeque<>();

    @SubscribeEvent
    public void onBlockBroken(BlockEvent.BreakEvent event) {
        if (event.getLevel().isClientSide()) {
            return;
        }
        addEvent("break_block", event.getState(), event.getPos());
    }

    @SubscribeEvent
    public void onBlockPlaced(BlockEvent.EntityPlaceEvent event) {
        if (event.getLevel().isClientSide()) {
            return;
        }
        addEvent("place_block", event.getPlacedBlock(), event.getPos());
    }

    public static JsonArray recentEvents() {
        JsonArray array = new JsonArray();
        synchronized (EVENTS) {
            for (JsonObject event : EVENTS) {
                array.add(event);
            }
        }
        return array;
    }

    private static void addEvent(String kind, BlockState state, BlockPos pos) {
        ResourceLocation id = net.minecraftforge.registries.ForgeRegistries.BLOCKS.getKey(state.getBlock());
        if (id == null) {
            return;
        }

        JsonObject event = new JsonObject();
        event.addProperty("kind", kind.equals("place_block") ? "place_block" : "break_block");
        event.addProperty("blockId", id.toString());
        event.addProperty("at", System.currentTimeMillis());

        JsonObject position = new JsonObject();
        position.addProperty("x", pos.getX());
        position.addProperty("y", pos.getY());
        position.addProperty("z", pos.getZ());
        event.add("position", position);

        synchronized (EVENTS) {
            EVENTS.addLast(event);
            while (EVENTS.size() > MAX_EVENTS) {
                EVENTS.removeFirst();
            }
        }
    }
}
