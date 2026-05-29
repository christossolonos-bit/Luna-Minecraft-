export type McAiConfig = {
  bridgeUrl: string;
  owner: string;
  ollamaHost: string;
  model: string;
  numPredict: number;
  temperature: number;
  memoryTurns: number;
  replyCooldownMs: number;
  buildComments: boolean;
  buildCommentCooldownMs: number;
  mcChatLimit: number;
  memoryFile: string;
};

export function loadMcAiConfig(): McAiConfig {
  const port = process.env.MC_SDK_PORT ?? "8787";
  return {
    bridgeUrl: process.env.MC_AI_BRIDGE_URL ?? `ws://127.0.0.1:${port}`,
    owner: (process.env.MC_OWNER ?? "solonaras").trim(),
    ollamaHost: (process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434").replace(/\/$/, ""),
    model: (process.env.MC_AI_MODEL ?? "qwen3.5:4b").trim(),
    numPredict: Math.max(32, Number(process.env.MC_AI_NUM_PREDICT ?? "96") || 96),
    temperature: Number(process.env.MC_AI_TEMPERATURE ?? "0.75") || 0.75,
    memoryTurns: Math.max(0, Number(process.env.MC_AI_MEMORY_TURNS ?? "8") || 8),
    replyCooldownMs: Math.max(0, Number(process.env.MC_AI_REPLY_COOLDOWN_MS ?? "800") || 800),
    buildComments: process.env.MC_AI_BUILD_COMMENTS === "true",
    buildCommentCooldownMs: Math.max(
      5000,
      Number(process.env.MC_AI_BUILD_COMMENT_COOLDOWN_MS ?? "60000") || 60000
    ),
    mcChatLimit: Math.min(256, Math.max(40, Number(process.env.MC_AI_CHAT_LIMIT ?? "100") || 100)),
    memoryFile: process.env.MC_AI_MEMORY_FILE ?? "data/mc_ai_memory.json"
  };
}
