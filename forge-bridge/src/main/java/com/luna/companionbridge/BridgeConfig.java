package com.luna.companionbridge;

public final class BridgeConfig {
    public static final String HOST = System.getenv().getOrDefault("MC_SDK_HOST", "localhost");
    public static final int PORT = Integer.parseInt(System.getenv().getOrDefault("MC_SDK_PORT", "8787"));
    public static final int STATE_TICK_INTERVAL = 10;

    private BridgeConfig() {
    }
}
