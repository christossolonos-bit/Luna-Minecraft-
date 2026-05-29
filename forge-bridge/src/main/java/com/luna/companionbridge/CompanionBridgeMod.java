package com.luna.companionbridge;

import net.minecraftforge.common.MinecraftForge;
import net.minecraftforge.fml.common.Mod;
import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.Logger;

@Mod(CompanionBridgeMod.MOD_ID)
public class CompanionBridgeMod {
    public static final String MOD_ID = "luna_companion_bridge";
    public static final Logger LOGGER = LogManager.getLogger(MOD_ID);

    public CompanionBridgeMod() {
        MinecraftForge.EVENT_BUS.register(new BuildEventTracker());
        LOGGER.info("Luna Companion Bridge loaded. Connect bridge with: npm run dev");
    }
}
