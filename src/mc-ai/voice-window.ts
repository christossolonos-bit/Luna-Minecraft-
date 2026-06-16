export function voiceTtsEnabled(): boolean {
  return process.env.MC_AI_VOICE !== "false" && process.env.MC_AI_VOICE_TTS !== "false";
}

/** On by default when TTS is enabled — set MC_TTS_WINDOW=false to disable. */
export function voiceWindowEnabled(): boolean {
  if (process.env.MC_TTS_WINDOW === "false") {
    return false;
  }
  if (process.env.MC_TTS_WINDOW === "true") {
    return true;
  }
  return voiceTtsEnabled();
}

export function voiceWindowPort(): number {
  return Number(process.env.MC_VOICE_WINDOW_PORT ?? "8791") || 8791;
}

export function voiceWindowHealthUrl(): string {
  return `http://127.0.0.1:${voiceWindowPort()}/health`;
}

export function voiceWindowUrl(): string {
  const port = voiceWindowPort();
  return (process.env.MC_TTS_WINDOW_URL ?? `http://127.0.0.1:${port}/speak`).trim();
}

export function localTtsPlaybackEnabled(): boolean {
  if (process.env.MC_TTS_LOCAL_PLAYBACK === "true") {
    return true;
  }
  if (process.env.MC_TTS_LOCAL_PLAYBACK === "false") {
    return false;
  }
  // Window mode: play only in the voice window so OBS can capture one app.
  return !voiceWindowEnabled();
}

export async function sendToVoiceWindow(text: string): Promise<boolean> {
  if (!voiceWindowEnabled()) {
    return false;
  }
  const cleaned = text.trim();
  if (!cleaned) {
    return false;
  }

  const url = voiceWindowUrl();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: cleaned }),
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) {
      console.warn(`[voice/window] ${url} returned ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[voice/window] could not reach voice window (${url}): ${msg}`);
    console.warn("[voice/window] Start Run Luna Voice.bat for OBS capture.");
    return false;
  }
}
