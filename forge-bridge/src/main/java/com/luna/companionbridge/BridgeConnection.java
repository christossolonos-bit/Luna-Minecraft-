package com.luna.companionbridge;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.java_websocket.client.WebSocketClient;
import org.java_websocket.handshake.ServerHandshake;

import java.net.URI;

public final class BridgeConnection {
    private static final BridgeConnection INSTANCE = new BridgeConnection();
    private WebSocketClient client;

    public static BridgeConnection get() {
        return INSTANCE;
    }

    public boolean isConnected() {
        return client != null && client.isOpen();
    }

    public void connect() {
        if (isConnected()) {
            return;
        }

        URI uri = URI.create("ws://" + BridgeConfig.HOST + ":" + BridgeConfig.PORT);
        client = new WebSocketClient(uri) {
            @Override
            public void onOpen(ServerHandshake handshake) {
                send("{\"type\":\"hello\",\"role\":\"game\"}");
                CompanionBridgeMod.LOGGER.info("Connected to Luna SDK bridge at {}", uri);
            }

            @Override
            public void onMessage(String message) {
                try {
                    JsonObject envelope = JsonParser.parseString(message).getAsJsonObject();
                    if (!envelope.has("type")) {
                        return;
                    }
                    String type = envelope.get("type").getAsString();
                    if ("action_request".equals(type) && envelope.has("payload")) {
                        ClientEvents.queueAction(envelope.getAsJsonObject("payload"));
                    }
                } catch (Exception error) {
                    CompanionBridgeMod.LOGGER.warn("Failed to parse bridge message: {}", error.getMessage());
                }
            }

            @Override
            public void onClose(int code, String reason, boolean remote) {
                CompanionBridgeMod.LOGGER.warn("Bridge disconnected ({}): {}", code, reason);
            }

            @Override
            public void onError(Exception ex) {
                CompanionBridgeMod.LOGGER.warn("Bridge socket error: {}", ex.getMessage());
            }
        };

        client.connect();
    }

    public void disconnect() {
        if (client != null) {
            client.close();
            client = null;
        }
    }

    public void sendState(JsonObject state) {
        send(state.toString());
    }

    public void send(String message) {
        if (isConnected()) {
            client.send(message);
        }
    }
}
