import crypto from "crypto";
import fs from "fs";
import path from "path";

export type SkinProfile = {
  textureValue: string;
  textureSignature?: string;
  model: "slim" | "classic";
};

export type LunaSkinSession = {
  accessToken: string;
  clientToken: string;
  selectedProfile: {
    id: string;
    name: string;
    properties: Array<{ name: string; value: string; signature?: string }>;
  };
};

export function resolveSkinPath(): string | null {
  const candidates = [
    process.env.MC_SKIN_PATH,
    path.join(process.cwd(), "assets", "skins", "luna.png"),
    "D:\\Music for distrokid\\Luna Highlights\\2023_05_19_crystal-fox-girl--pink-version--21614895.png"
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

export async function loadSkinProfile(
  skinPath: string,
  model: "slim" | "classic" = "slim"
): Promise<SkinProfile> {
  const stat = fs.statSync(skinPath);
  const cacheDir = path.join(process.cwd(), ".cache");
  const cacheFile = path.join(cacheDir, "luna-skin.json");

  if (fs.existsSync(cacheFile)) {
    const cache = JSON.parse(fs.readFileSync(cacheFile, "utf8")) as {
      sourceMtime: number;
      sourceSize: number;
      profile: SkinProfile;
    };
    if (cache.sourceMtime === stat.mtimeMs && cache.sourceSize === stat.size) {
      return cache.profile;
    }
  }

  const buffer = fs.readFileSync(skinPath);
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: "image/png" }), path.basename(skinPath));

  const response = await fetch(`https://api.mineskin.org/generate/upload?model=${model}`, {
    method: "POST",
    body: form
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`MineSkin upload failed (${response.status}): ${body}`);
  }

  const json = (await response.json()) as {
    data?: { texture?: { value: string; signature?: string } };
  };

  const texture = json.data?.texture;
  if (!texture?.value) {
    throw new Error("MineSkin response did not include texture data.");
  }

  const profile: SkinProfile = {
    textureValue: texture.value,
    textureSignature: texture.signature,
    model
  };

  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(
    cacheFile,
    JSON.stringify({ sourceMtime: stat.mtimeMs, sourceSize: stat.size, profile }, null, 2)
  );

  return profile;
}

export function buildSkinSession(username: string, skin: SkinProfile): LunaSkinSession {
  const clientToken = crypto.randomUUID().replace(/-/g, "");
  const id = crypto.randomUUID().replace(/-/g, "");

  return {
    accessToken: "0",
    clientToken,
    selectedProfile: {
      id,
      name: username,
      properties: [
        {
          name: "textures",
          value: skin.textureValue,
          signature: skin.textureSignature
        }
      ]
    }
  };
}

export function applySkinSettings(bot: import("mineflayer").Bot): void {
  bot.setSettings({
    skinParts: {
      showCape: true,
      showJacket: true,
      showLeftSleeve: true,
      showRightSleeve: true,
      showLeftPants: true,
      showRightPants: true,
      showHat: true
    }
  });
}
