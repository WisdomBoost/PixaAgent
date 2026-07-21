import type {
  ChatMessage,
  ChatRequest,
  ChatResult,
  ModelProvider,
  StreamDelta,
  ToolCall,
  UsageInfo,
} from "./types";
import { RateLimitError, classifyRateLimit } from "./errors";

const API_URL = "https://openrouter.ai/api/v1/chat/completions";

/* ---------- pure helpers (unit-tested) ---------- */

/**
 * Split an SSE buffer into complete event payloads (the part after "data: ")
 * and the unconsumed tail. Comment lines (": ...") are dropped.
 */
export function parseSseChunk(buffer: string): { events: string[]; rest: string } {
  const events: string[] = [];
  // Events are separated by a blank line; tolerate \n\n and \r\n\r\n.
  const parts = buffer.split(/\r?\n\r?\n/);
  const rest = parts.pop() ?? "";
  for (const part of parts) {
    for (const line of part.split(/\r?\n/)) {
      if (line.startsWith("data: ")) {
        events.push(line.slice(6));
      } else if (line.startsWith("data:")) {
        events.push(line.slice(5).trimStart());
      }
      // lines starting with ":" are SSE comments (OpenRouter keep-alives) — ignored
    }
  }
  return { events, rest };
}

export interface StreamedToolCallDelta {
  index: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

export type ToolCallAccumulator = Record<number, ToolCall>;

/** Merge streamed tool_calls fragments (OpenAI delta format) into complete calls. */
export function accumulateToolCallDelta(
  acc: ToolCallAccumulator,
  deltas: StreamedToolCallDelta[]
): void {
  for (const d of deltas) {
    const existing = acc[d.index] ?? { id: "", name: "", arguments: "" };
    if (d.id) existing.id = d.id;
    if (d.function?.name) existing.name = (existing.name ?? "") + d.function.name;
    if (d.function?.arguments) existing.arguments += d.function.arguments;
    acc[d.index] = existing;
  }
}

/**
 * Extract OpenRouter's usage-accounting block from a parsed SSE chunk, if present.
 * Requires `usage: { include: true }` in the request. `cost` is the provider's actual
 * billed USD amount for the request — null (not 0) means the field was absent, e.g.
 * some free models don't report it.
 */
export function extractUsage(parsed: any): UsageInfo | null {
  const u = parsed?.usage;
  if (!u || typeof u !== "object") return null;
  return {
    promptTokens: Number(u.prompt_tokens) || 0,
    completionTokens: Number(u.completion_tokens) || 0,
    totalTokens: Number(u.total_tokens) || 0,
    costUsd: typeof u.cost === "number" ? u.cost : null,
  };
}

/* ---------- OpenAI-compatible wire mapping ---------- */

interface WireMessage {
  role: string;
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

function toWire(messages: ChatMessage[]): WireMessage[] {
  return messages.map((m) => {
    const wire: WireMessage = { role: m.role, content: m.content };
    if (m.toolCalls?.length) {
      wire.tool_calls = m.toolCalls.map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: c.arguments },
      }));
      if (wire.content === "") wire.content = null;
    }
    if (m.toolCallId) wire.tool_call_id = m.toolCallId;
    return wire;
  });
}

/* ---------- provider ---------- */

/**
 * OpenAI-compatible chat client.
 *
 * Serves OpenRouter by default, but works with ANY OpenAI-compatible endpoint —
 * NVIDIA NIM, a company gateway, or a self-hosted server (Ollama, vLLM,
 * LM Studio, llama.cpp) — by passing a different id/endpoint. Local servers
 * that need no credentials pass `requiresApiKey: false`.
 */
export class OpenRouterProvider implements ModelProvider {
  readonly id: string;
  private endpoint: string;
  private requiresApiKey: boolean;
  private displayName: string;

  constructor(
    private getApiKey: () => Promise<string | undefined>,
    opts: { id?: string; endpoint?: string; requiresApiKey?: boolean; displayName?: string } = {}
  ) {
    this.id = opts.id ?? "openrouter";
    this.endpoint = opts.endpoint ?? API_URL;
    this.requiresApiKey = opts.requiresApiKey !== false;
    this.displayName = opts.displayName ?? this.id;
  }

  /** True when this client talks to OpenRouter itself (enables its extensions). */
  private get isOpenRouter(): boolean {
    return this.endpoint === API_URL;
  }

  async chat(
    req: ChatRequest,
    onDelta: (d: StreamDelta) => void,
    signal: AbortSignal
  ): Promise<ChatResult> {
    const apiKey = await this.getApiKey();
    if (!apiKey && this.requiresApiKey) {
      throw new Error(
        `No API key set for "${this.displayName}". Run "Pixa: Set Provider API Key" and choose ${this.id}.`
      );
    }

    const body: Record<string, unknown> = {
      model: req.model,
      messages: toWire(req.messages),
      stream: true,
      temperature: req.temperature ?? 0.2,
      max_tokens: req.maxTokens ?? 8192,
      tools: req.tools.length
        ? req.tools.map((t) => ({
            type: "function",
            function: { name: t.name, description: t.description, parameters: t.parameters },
          }))
        : undefined,
    };
    // Cost accounting is an OpenRouter extension; other OpenAI-compatible
    // servers may reject unknown fields, so only send it to OpenRouter.
    if (this.isOpenRouter) body.usage = { include: true };

    // Combine the caller's abort signal with a 30-second connect timeout so a
    // slow or hung external host never blocks the UI indefinitely.
    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => timeoutController.abort(), 30_000);
    const combinedSignal = AbortSignal.any
      ? AbortSignal.any([signal, timeoutController.signal])
      : (() => {
          const c = new AbortController();
          signal.addEventListener("abort", () => c.abort(signal.reason), { once: true });
          timeoutController.signal.addEventListener("abort", () => c.abort(new Error("Request timed out after 30s — the provider is not responding")), { once: true });
          return c.signal;
        })();

    let res: Response;
    try {
      res = await fetch(this.endpoint, {
        method: "POST",
        signal: combinedSignal,
        headers: {
          "Content-Type": "application/json",
          // Keyless local servers (Ollama, LM Studio) get no auth header.
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          // OpenRouter-only attribution headers.
          ...(this.isOpenRouter ? { "HTTP-Referer": "https://pixa.dev", "X-Title": "Pixa IDE" } : {}),
        },
        body: JSON.stringify(body),
      });
    } finally {
      // Once we have the response (or an error), the connect phase is done;
      // cancel the connect timeout so it doesn't fire during the streaming phase.
      clearTimeout(timeoutId);
    }

    if (res.status === 429) {
      const text = await res.text().catch(() => "");
      throw new RateLimitError(
        parseRetryAfter(res.headers.get("retry-after"), text),
        friendlyError(429, text),
        classifyRateLimit(text),
        text
      );
    }
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      throw new Error(friendlyError(res.status, text));
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let finishReason = "stop";
    let usage: UsageInfo | null = null;
    const toolAcc: ToolCallAccumulator = {};

    for (;;) {
      // Respect abort between chunks so Stop takes effect immediately even
      // if the server keeps the connection open.
      if (signal.aborted) {
        await reader.cancel();
        break;
      }
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { events, rest } = parseSseChunk(buffer);
      buffer = rest;
      for (const ev of events) {
        if (ev === "[DONE]") continue;
        let parsed: any;
        try {
          parsed = JSON.parse(ev);
        } catch {
          continue; // partial/garbled event — skip
        }
        if (parsed.error) {
          if (parsed.error.code === 429) {
            const raw = JSON.stringify(parsed.error);
            throw new RateLimitError(
              Number(parsed.error.metadata?.retry_after_seconds) || 30,
              friendlyError(429, raw),
              classifyRateLimit(raw),
              raw
            );
          }
          throw new Error(`OpenRouter: ${parsed.error.message ?? JSON.stringify(parsed.error)}`);
        }
        const chunkUsage = extractUsage(parsed);
        if (chunkUsage) usage = chunkUsage;
        const choice = parsed.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta ?? {};
        if (typeof delta.content === "string" && delta.content.length) {
          content += delta.content;
          onDelta({ text: delta.content });
        }
        if (Array.isArray(delta.tool_calls)) {
          accumulateToolCallDelta(toolAcc, delta.tool_calls);
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }
    }

    const toolCalls = Object.keys(toolAcc)
      .map(Number)
      .sort((a, b) => a - b)
      .map((i) => toolAcc[i])
      .filter((c) => c.name);

    return { content, toolCalls, finishReason, usage };
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

/** Prefer the Retry-After header, then the body's retry_after_seconds, else a safe default. */
export function parseRetryAfter(header: string | null, body: string): number {
  const fromHeader = header ? Number(header) : NaN;
  if (Number.isFinite(fromHeader) && fromHeader > 0) return fromHeader;
  try {
    const j = JSON.parse(body);
    const s = Number(j?.error?.metadata?.retry_after_seconds);
    if (Number.isFinite(s) && s > 0) return s;
  } catch {
    // ignore
  }
  return 30;
}

/** Turn OpenRouter's raw error JSON into a short, human-readable line. */
export function friendlyError(status: number, body: string): string {
  let inner = "";
  try {
    inner = JSON.parse(body)?.error?.message ?? "";
  } catch {
    inner = "";
  }
  const base = inner || truncate(body, 300);
  switch (status) {
    case 429:
      return `Rate limited by the provider. Free models share a global quota — ${base}`;
    case 402:
      return `Out of credits for this model: ${base} Lower pixa.maxTokens, switch to a free model, or add credit at openrouter.ai/settings/credits.`;
    case 401:
      return `Auth failed (401). Re-run "Pixa: Set OpenRouter API Key". ${base}`;
    case 404:
      return `Model not found (404): ${base} The slug may be retired — pick another model.`;
    default:
      return `OpenRouter error ${status}: ${base}`;
  }
}
