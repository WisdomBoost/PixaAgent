import type {
  ChatMessage,
  ChatRequest,
  ChatResult,
  ModelProvider,
  StreamDelta,
  ToolCall,
} from "./types";

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

export class OpenRouterProvider implements ModelProvider {
  readonly id = "openrouter";

  constructor(private getApiKey: () => Promise<string | undefined>) {}

  async chat(
    req: ChatRequest,
    onDelta: (d: StreamDelta) => void,
    signal: AbortSignal
  ): Promise<ChatResult> {
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      throw new Error("No OpenRouter API key set. Run the \"Pixa: Set OpenRouter API Key\" command.");
    }

    const body = {
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

    const res = await fetch(API_URL, {
      method: "POST",
      signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://pixa.dev",
        "X-Title": "Pixa IDE",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      throw new Error(`OpenRouter error ${res.status}: ${truncate(text, 500)}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let finishReason = "stop";
    const toolAcc: ToolCallAccumulator = {};

    for (;;) {
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
          throw new Error(`OpenRouter: ${parsed.error.message ?? JSON.stringify(parsed.error)}`);
        }
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

    return { content, toolCalls, finishReason };
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
