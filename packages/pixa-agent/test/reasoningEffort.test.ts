/**
 * Tests for the reasoning-effort / thinking-mode feature.
 *
 * Testing plan from the design doc:
 *
 * openrouter.ts (request body)
 *   - Omits `reasoning` when model does not support it, even if reasoningEffort is set.
 *   - Omits `reasoning` when model supports it but reasoningEffort is absent (undefined).
 *   - Includes `reasoning: { effort }` with the correct value when both are set.
 *   - Only sends `reasoning` to the openrouter provider (not custom providers).
 *
 * AgentLoop wiring
 *   - Passes reasoningEffort through to the provider only when model declares supportsReasoningEffort.
 *   - Drops reasoningEffort when falling back to a model that does not support it.
 *
 * providersToModels (config.ts)
 *   - supportsReasoningEffort: true is preserved when the user sets it on a model entry.
 *   - supportsReasoningEffort defaults to undefined when omitted.
 */

import { describe, it, expect, vi } from "vitest";
import { OpenRouterProvider } from "../src/providers/openrouter";
import { AgentLoop } from "../src/agent/loop";
import { ProviderRegistry } from "../src/providers/registry";
import { ToolRegistry } from "../src/tools/registry";
import { providersToModels, type ProvidersConfig } from "../src/providers/config";
import type { ChatResult, ModelEntry, ModelProvider } from "../src/providers/types";
import type { AgentEvent } from "../src/agent/events";
import type { ToolContext } from "../src/tools/types";
import type { RepoIndex } from "../src/indexer/types";
import { ChangeSet } from "../src/edits/changeSet";

/* ─────────────────────────────── helpers ─────────────────────────────── */

const index: RepoIndex = {
  getProjectMap: async () => "",
  getFileOutline: async () => "",
  refresh: () => {},
};

function makeCtx(events: AgentEvent[]): ToolContext {
  return {
    workspaceRoot: "/tmp",
    changeSet: new ChangeSet(),
    index,
    approvals: { requestApproval: async () => true },
    readWorkspaceFile: async () => null,
    emit: (e) => events.push(e),
  };
}

/** Build a minimal SSE response the streaming loop will accept as a normal done result. */
function sseBody(content: string): ReadableStream<Uint8Array> {
  const chunk = `data: ${JSON.stringify({
    choices: [{ delta: { content }, finish_reason: "stop" }],
  })}\n\ndata: [DONE]\n\n`;
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
}

/**
 * Intercept globalThis.fetch, run the provider's chat(), and return the
 * parsed JSON body that was sent in the first fetch call.
 */
async function captureRequestBody(
  provider: OpenRouterProvider,
  req: Parameters<OpenRouterProvider["chat"]>[0],
  signal: AbortSignal
): Promise<Record<string, unknown>> {
  let captured: Record<string, unknown> = {};

  const original = globalThis.fetch;
  globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    captured = JSON.parse(init?.body as string);
    return new Response(sseBody("hello"), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  }) as unknown as typeof fetch;

  try {
    await provider.chat(req, () => {}, signal);
  } finally {
    globalThis.fetch = original;
  }
  return captured;
}

/* ─────────────────────────────── OpenRouterProvider ─────────────────────────────── */

describe("OpenRouterProvider — reasoning field in request body", () => {
  const signal = new AbortController().signal;
  const baseReq = {
    model: "test-model",
    messages: [{ role: "user" as const, content: "hi" }],
    tools: [],
  };

  it("omits `reasoning` when reasoningEffort is absent (undefined)", async () => {
    const provider = new OpenRouterProvider(async () => "sk-test", {
      gatewayUrl: "http://localhost:8080/v1/chat",
    });
    const body = await captureRequestBody(provider, { ...baseReq }, signal);
    expect(body).not.toHaveProperty("reasoning");
  });

  it("omits `reasoning` for a non-openrouter provider even if reasoningEffort is set", async () => {
    // Custom provider (id !== "openrouter") must NOT forward reasoning — unknown
    // fields can cause errors on arbitrary OpenAI-compatible servers.
    const provider = new OpenRouterProvider(async () => "sk-test", {
      id: "custom-provider",
      endpoint: "http://localhost:9999/v1/chat/completions",
      requiresApiKey: true,
    });
    const body = await captureRequestBody(
      provider,
      { ...baseReq, reasoningEffort: "high" },
      signal
    );
    expect(body).not.toHaveProperty("reasoning");
  });

  it("omits `reasoning` when reasoningEffort is undefined even with openrouter provider", async () => {
    const provider = new OpenRouterProvider(async () => "sk-test", {
      gatewayUrl: "http://localhost:8080/v1/chat",
    });
    const body = await captureRequestBody(
      provider,
      { ...baseReq, reasoningEffort: undefined },
      signal
    );
    expect(body).not.toHaveProperty("reasoning");
  });

  it("includes `reasoning: { effort }` for each level when openrouter + effort is set", async () => {
    const provider = new OpenRouterProvider(async () => "sk-test", {
      gatewayUrl: "http://localhost:8080/v1/chat",
    });
    for (const effort of ["low", "medium", "high"] as const) {
      const body = await captureRequestBody(
        provider,
        { ...baseReq, reasoningEffort: effort },
        signal
      );
      expect(body.reasoning).toEqual({ effort });
    }
  });

  it("adds `usage: { include: true }` for openrouter but not for custom providers", async () => {
    const orProvider = new OpenRouterProvider(async () => "sk-test", {
      gatewayUrl: "http://localhost:8080/v1/chat",
    });
    const customProvider = new OpenRouterProvider(async () => "sk-test", {
      id: "custom",
      endpoint: "http://localhost:9999/v1/chat/completions",
    });

    const orBody = await captureRequestBody(orProvider, baseReq, signal);
    const customBody = await captureRequestBody(customProvider, baseReq, signal);

    expect(orBody.usage).toEqual({ include: true });
    expect(customBody).not.toHaveProperty("usage");
  });
});

/* ─────────────────────────────── AgentLoop wiring ─────────────────────────────── */

describe("AgentLoop — reasoning effort is forwarded correctly", () => {
  it("passes reasoningEffort to the provider when model declares supportsReasoningEffort", async () => {
    const capturedRequests: Array<{ reasoningEffort?: string }> = [];

    const model: ModelEntry = {
      id: "thinking-model",
      label: "Thinker",
      provider: "smart",
      slug: "smart/thinker",
      contextWindow: 100_000,
      supportsTools: true,
      supportsReasoningEffort: true,
    };
    const provider: ModelProvider = {
      id: "smart",
      async chat(req): Promise<ChatResult> {
        capturedRequests.push({ reasoningEffort: req.reasoningEffort });
        return { content: "done", toolCalls: [], finishReason: "stop" };
      },
    };

    const registry = new ProviderRegistry();
    registry.register(provider);
    const events: AgentEvent[] = [];
    const loop = new AgentLoop({
      registry,
      tools: new ToolRegistry(),
      models: [model],
      ctx: makeCtx(events),
      workspaceInfo: async () => ({ workspaceName: "w", os: "linux" }),
    });

    await loop.run("hello", "thinking-model", new AbortController().signal, "high");

    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0].reasoningEffort).toBe("high");
  });

  it("does NOT pass reasoningEffort when model lacks supportsReasoningEffort", async () => {
    const capturedRequests: Array<{ reasoningEffort?: string }> = [];

    const model: ModelEntry = {
      id: "plain-model",
      label: "Plain",
      provider: "plain",
      slug: "plain/model",
      contextWindow: 100_000,
      supportsTools: true,
      // supportsReasoningEffort is intentionally absent
    };
    const provider: ModelProvider = {
      id: "plain",
      async chat(req): Promise<ChatResult> {
        capturedRequests.push({ reasoningEffort: req.reasoningEffort });
        return { content: "done", toolCalls: [], finishReason: "stop" };
      },
    };

    const registry = new ProviderRegistry();
    registry.register(provider);
    const events: AgentEvent[] = [];
    const loop = new AgentLoop({
      registry,
      tools: new ToolRegistry(),
      models: [model],
      ctx: makeCtx(events),
      workspaceInfo: async () => ({ workspaceName: "w", os: "linux" }),
    });

    // Caller passes "medium" but the model does not support it — loop must drop it.
    await loop.run("hello", "plain-model", new AbortController().signal, "medium");

    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0].reasoningEffort).toBeUndefined();
  });

  it("drops reasoningEffort when falling back mid-task to a model without support", async () => {
    const capturedRequests: Array<{ modelSlug: string; reasoningEffort?: string }> = [];

    const thinkingModel: ModelEntry = {
      id: "thinking:free",
      label: "Thinker (free)",
      provider: "smart",
      slug: "smart/thinker:free",
      contextWindow: 100_000,
      supportsTools: true,
      supportsReasoningEffort: true,
    };
    const fallbackModel: ModelEntry = {
      id: "fallback:free",
      label: "Fallback (free)",
      provider: "smart",
      slug: "smart/fallback:free",
      contextWindow: 100_000,
      supportsTools: true,
      // supportsReasoningEffort NOT set
    };

    // chatWithRetry retries an "upstream" 429 up to MAX_RATE_LIMIT_RETRIES (4)
    // times before re-throwing to the outer hop logic — so we need the thinking
    // model to fail all 5 calls (1 + 4 retries) before the hop fires.
    const { RateLimitError } = await import("../src/providers/errors");
    const provider: ModelProvider = {
      id: "smart",
      async chat(req): Promise<ChatResult> {
        capturedRequests.push({ modelSlug: req.model, reasoningEffort: req.reasoningEffort });
        if (req.model === "smart/thinker:free") {
          throw new RateLimitError(0, "pool exhausted", "upstream", "");
        }
        return { content: "done", toolCalls: [], finishReason: "stop" };
      },
    };

    const registry = new ProviderRegistry();
    registry.register(provider);
    const events: AgentEvent[] = [];
    const loop = new AgentLoop({
      registry,
      tools: new ToolRegistry(),
      models: [thinkingModel, fallbackModel],
      ctx: makeCtx(events),
      workspaceInfo: async () => ({ workspaceName: "w", os: "linux" }),
    });

    await loop.run("hello", "thinking:free", new AbortController().signal, "high");

    // The thinking model is retried 5 times (1 + MAX_RATE_LIMIT_RETRIES=4) before the hop.
    // All thinking-model calls must carry effort=high.
    const thinkingCalls = capturedRequests.filter((r) => r.modelSlug === "smart/thinker:free");
    expect(thinkingCalls.length).toBeGreaterThanOrEqual(1);
    for (const c of thinkingCalls) {
      expect(c.reasoningEffort).toBe("high");
    }

    // The fallback model call must have effort=undefined (model does not support it).
    const fallbackCalls = capturedRequests.filter((r) => r.modelSlug === "smart/fallback:free");
    expect(fallbackCalls).toHaveLength(1);
    expect(fallbackCalls[0].reasoningEffort).toBeUndefined();
  });
});

/* ─────────────────────────────── providersToModels ─────────────────────────────── */

describe("providersToModels — supportsReasoningEffort field (backward compat)", () => {
  it("preserves supportsReasoningEffort: true when set on a user model config", () => {
    const cfg: ProvidersConfig = {
      mygateway: {
        baseUrl: "http://my-gateway.internal/v1",
        models: { "deepseek-r2": { supportsReasoningEffort: true } },
      },
    };
    const { models } = providersToModels(cfg);
    expect(models[0].supportsReasoningEffort).toBe(true);
  });

  it("leaves supportsReasoningEffort undefined when not set in user config", () => {
    const cfg: ProvidersConfig = {
      ollama: {
        baseUrl: "http://localhost:11434/v1",
        models: { "llama3.3": {} },
      },
    };
    const { models } = providersToModels(cfg);
    // undefined (not false) — we distinguish "doesn't support" from "we don't know"
    expect(models[0].supportsReasoningEffort).toBeUndefined();
  });

  it("existing configs without the field parse cleanly (no errors, correct defaults)", () => {
    const cfg: ProvidersConfig = {
      vllm: {
        baseUrl: "http://localhost:8000/v1",
        models: { "qwen3-coder": { name: "Qwen3 Coder", contextWindow: 1_000_000 } },
      },
    };
    const { models, errors } = providersToModels(cfg);
    expect(errors).toHaveLength(0);
    expect(models[0].id).toBe("vllm:qwen3-coder");
    expect(models[0].supportsReasoningEffort).toBeUndefined();
  });
});
