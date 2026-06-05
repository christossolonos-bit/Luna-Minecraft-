const THINK_BLOCK_RE = /<\s*(think|thinking|reasoning)\s*>[\s\S]*?<\s*\/\s*\1\s*>/gi;
const THINK_TAG_RE = /<\s*\/?\s*(think|thinking|reasoning)\s*>/gi;

export function stripThinkBlocks(text: string): string {
  return text.replace(THINK_BLOCK_RE, "").replace(THINK_TAG_RE, "").trim();
}

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type OllamaChatOptions = {
  host: string;
  model: string;
  messages: ChatMessage[];
  numPredict: number;
  temperature: number;
  think?: boolean;
};

function withNoThinkDirective(messages: ChatMessage[]): ChatMessage[] {
  const out = messages.map((m) => ({ ...m }));
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i]!.role === "user") {
      const content = out[i]!.content.trimEnd();
      if (!content.includes("/no_think")) {
        out[i] = { ...out[i]!, content: `${content}\n\n/no_think` };
      }
      break;
    }
  }
  return out;
}

function parseThinkFlag(explicit?: boolean): boolean {
  if (explicit !== undefined) {
    return explicit;
  }
  const raw = (process.env.MC_AI_THINK ?? "false").trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes" || raw === "on";
}

export async function checkOllamaHealth(host: string, model: string): Promise<string | null> {
  const base = host.replace(/\/$/, "");
  try {
    const response = await fetch(`${base}/api/tags`, {
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) {
      return `Ollama at ${base} returned HTTP ${response.status}.`;
    }
    const data = (await response.json()) as { models?: { name: string }[] };
    const names = data.models?.map((m) => m.name) ?? [];
    const hasModel = names.some((n) => n === model || n.startsWith(`${model}:`) || n.startsWith(model));
    if (!hasModel) {
      return `Model "${model}" not in Ollama. Run: ollama pull ${model}`;
    }
    return null;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (detail === "fetch failed" || detail.includes("ECONNREFUSED") || detail.includes("connect")) {
      return `Cannot reach Ollama at ${base} — start the Ollama app (system tray), then try again.`;
    }
    return `Ollama check failed: ${detail}`;
  }
}

/** Qwen sometimes returns `{"error":"no_think"}` when /no_think is appended — not a usable reply. */
export function isBrokenOllamaContent(text: string): boolean {
  const t = text.trim();
  if (!t) {
    return true;
  }
  if (/no_think/i.test(t)) {
    return true;
  }
  if (t.startsWith("{") && t.includes("error")) {
    try {
      const data = JSON.parse(t) as { error?: unknown; say?: unknown };
      if (data.error != null) {
        return true;
      }
      if (typeof data.say !== "string" || !String(data.say).trim()) {
        return true;
      }
    } catch {
      // not JSON — keep
    }
  }
  return false;
}

async function ollamaChatOnce(
  options: OllamaChatOptions,
  think: boolean,
  appendNoThink: boolean
): Promise<string> {
  const url = `${options.host}/api/chat`;
  const messages =
    appendNoThink && think === false
      ? withNoThinkDirective(options.messages)
      : options.messages;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(120_000),
      body: JSON.stringify({
        model: options.model,
        messages,
        stream: false,
        think,
        keep_alive: "15m",
        options: {
          num_predict: options.numPredict,
          temperature: options.temperature,
          num_ctx: 2048
        }
      })
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (detail === "fetch failed" || detail.includes("ECONNREFUSED") || detail.includes("connect")) {
      throw new Error(
        `Cannot reach Ollama at ${options.host} — start the Ollama app, then try again.`
      );
    }
    throw err;
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Ollama ${response.status}: ${body.slice(0, 200) || response.statusText}`);
  }

  const data = (await response.json()) as { message?: { content?: string } };
  return stripThinkBlocks(data.message?.content ?? "");
}

export async function ollamaChat(options: OllamaChatOptions): Promise<string> {
  const thinkFirst = parseThinkFlag(options.think);
  let content = await ollamaChatOnce(options, thinkFirst, thinkFirst === false);
  if (isBrokenOllamaContent(content)) {
    console.warn("[ollama] bad model payload — retrying with thinking enabled");
    content = await ollamaChatOnce({ ...options, think: true }, true, false);
  }
  if (isBrokenOllamaContent(content)) {
    console.warn("[ollama] retry still empty — second attempt without /no_think");
    content = await ollamaChatOnce(options, false, false);
  }
  return content;
}
