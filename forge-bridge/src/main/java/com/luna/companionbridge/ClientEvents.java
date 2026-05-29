package com.luna.companionbridge;

import com.google.gson.JsonObject;
import net.minecraft.client.Minecraft;
import net.minecraftforge.api.distmarker.Dist;
import net.minecraftforge.event.TickEvent;
import net.minecraftforge.eventbus.api.SubscribeEvent;
import net.minecraftforge.fml.common.Mod;

import java.util.Queue;
import java.util.concurrent.ConcurrentLinkedQueue;

@Mod.EventBusSubscriber(modid = CompanionBridgeMod.MOD_ID, bus = Mod.EventBusSubscriber.Bus.FORGE, value = Dist.CLIENT)
public final class ClientEvents {
    private static final Queue<JsonObject> ACTION_QUEUE = new ConcurrentLinkedQueue<>();
    private static int tickCounter;
    private static boolean wasInWorld;

    private ClientEvents() {
    }

    public static void queueAction(JsonObject action) {
        ACTION_QUEUE.add(action);
    }

    @SubscribeEvent
    public static void onClientTick(TickEvent.ClientTickEvent event) {
        if (event.phase != TickEvent.Phase.END) {
            return;
        }

        Minecraft minecraft = Minecraft.getInstance();
        boolean inWorld = minecraft.player != null && minecraft.level != null;

        if (inWorld && !wasInWorld) {
            BridgeConnection.get().connect();
        }
        if (!inWorld && wasInWorld) {
            BridgeConnection.get().disconnect();
        }
        wasInWorld = inWorld;

        if (!inWorld) {
            return;
        }

        processQueuedActions();
        ActionHandler.tick(minecraft.player);

        tickCounter++;
        if (tickCounter % BridgeConfig.STATE_TICK_INTERVAL == 0 && BridgeConnection.get().isConnected()) {
            BridgeConnection.get().sendState(StateCollector.collect());
        }
    }

    private static void processQueuedActions() {
        JsonObject action;
        while ((action = ACTION_QUEUE.poll()) != null) {
            JsonObject result = ActionHandler.handle(action);
            BridgeConnection.get().send(result.toString());
        }
    }
}
