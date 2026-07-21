import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { OpenRouterProvider } from "../src/providers/openrouter";
import { providersToModels, chatCompletionsUrl } from "../src/providers/config";

/**
 * End-to-end cover for the headline open-source promise: Pixa runs against a
 * SELF-HOSTED OpenAI-compatible server (Ollama, vLLM, LM Studio, llama.cpp)
 * with no API key and no code changes.
 *
 * A real local server is stood up rather than mocking fetch, so this catches
 * wire-level regressions — a stray Authorization header or an OpenRouter-only
 * body field would make a real local server 400, and a mock would hide that.
 */

interface Captured {
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  body: any;
}

let server: Server;
let baseUrl: string;
let captured: Captured | null = null;

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      captured = { url: req.url, headers: req.headers, body: JSON.parse(raw) };
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n`);
      res.write(`data: {"choices":[{"delta":{"content":" from local"}}]}\n\n`);
      res.write(
        `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read_file","arguments":"{\\"path\\":\\"a.ts\\"}"}}]}}]}\n\n`
      );
      res.write(`data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n`);
      res.write(`data: [DONE]\n\n`);
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/v1`;
});

afterAll(() => {
  server.close();
});

function localProvider() {
  return new OpenRouterProvider(async () => undefined, {
    id: "local-llm",
    endpoint: chatCompletionsUrl(baseUrl),
    requiresApiKey: false,
    displayName: "My Local LLM",
  });
}

const basicReq = {
  model: "qwen2.5-coder",
  messages: [{ role: "user" as const, content: "hi" }],
  tools: [],
};

describe("self-hosted OpenAI-compatible provider", () => {
  it("flattens a keyless local provider config into a namespaced model entry", () => {
    const { models, errors } = providersToModels({
      "local-llm": {
        name: "My Local LLM",
        baseUrl,
        requiresApiKey: false,
        models: { "qwen2.5-coder": { name: "Qwen2.5 Coder", contextWindow: 32768 } },
      },
    });

    expect(errors).toEqual([]);
    expect(models[0].id).toBe("local-llm:qwen2.5-coder");
    expect(models[0].provider).toBe("local-llm");
    expect(models[0].contextWindow).toBe(32768);
  });

  it("appends /chat/completions to a base URL ending in /v1", () => {
    expect(chatCompletionsUrl(baseUrl)).toBe(`${baseUrl}/chat/completions`);
  });

  it("streams content incrementally from a local server", async () => {
    const deltas: string[] = [];
    const result = await localProvider().chat(
      { ...basicReq, maxTokens: 256 },
      (d) => deltas.push(d.text),
      new AbortController().signal
    );

    expect(result.content).toBe("Hello from local");
    expect(deltas.join("")).toBe("Hello from local");
  });

  it("assembles tool calls from a local server", async () => {
    const result = await localProvider().chat(
      { ...basicReq, tools: [{ name: "read_file", description: "read", parameters: { type: "object", properties: {} } }] },
      () => {},
      new AbortController().signal
    );

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("read_file");
    expect(result.toolCalls[0].arguments).toBe('{"path":"a.ts"}');
    expect(result.finishReason).toBe("tool_calls");
  });

  it("sends no Authorization header when the local server needs no key", async () => {
    await localProvider().chat(basicReq, () => {}, new AbortController().signal);
    expect(captured!.headers.authorization).toBeUndefined();
  });

  it("leaks no OpenRouter-only fields to a non-OpenRouter server", async () => {
    await localProvider().chat(basicReq, () => {}, new AbortController().signal);

    // A real local server rejects unknown body fields / ignores these headers;
    // sending them is the classic "works on OpenRouter, 400s on Ollama" bug.
    expect(captured!.headers["http-referer"]).toBeUndefined();
    expect(captured!.headers["x-title"]).toBeUndefined();
    expect(captured!.body.usage).toBeUndefined();
  });

  it("sends a well-formed OpenAI-shaped request body", async () => {
    await localProvider().chat(
      {
        ...basicReq,
        maxTokens: 256,
        tools: [{ name: "read_file", description: "read", parameters: { type: "object", properties: {} } }],
      },
      () => {},
      new AbortController().signal
    );

    expect(captured!.body.model).toBe("qwen2.5-coder");
    expect(captured!.body.stream).toBe(true);
    expect(captured!.body.max_tokens).toBe(256);
    expect(captured!.body.tools[0].type).toBe("function");
    expect(captured!.body.tools[0].function.name).toBe("read_file");
  });

  it("still sends Authorization for a keyed provider on the same code path", async () => {
    const keyed = new OpenRouterProvider(async () => "sk-test123", {
      id: "gateway",
      endpoint: chatCompletionsUrl(baseUrl),
      requiresApiKey: true,
    });

    await keyed.chat(basicReq, () => {}, new AbortController().signal);
    expect(captured!.headers.authorization).toBe("Bearer sk-test123");
  });

  it("fails with a clear message when a keyed provider has no key set", async () => {
    const keyed = new OpenRouterProvider(async () => undefined, {
      id: "gateway",
      endpoint: chatCompletionsUrl(baseUrl),
      requiresApiKey: true,
      displayName: "Company Gateway",
    });

    await expect(keyed.chat(basicReq, () => {}, new AbortController().signal)).rejects.toThrow(
      /Company Gateway/
    );
  });
});
