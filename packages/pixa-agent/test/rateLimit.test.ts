import { describe, it, expect } from "vitest";
import { AgentLoop } from "../src/agent/loop";
import { RateLimitError } from "../src/providers/errors";
import { parseRetryAfter, friendlyError } from "../src/providers/openrouter";
import { ProviderRegistry } from "../src/providers/registry";
import type { ChatResult, ModelEntry, ModelProvider } from "../src/providers/types";
import { ToolRegistry } from "../src/tools/registry";
import type { AgentEvent } from "../src/agent/events";
import type { ToolContext } from "../src/tools/types";
import type { RepoIndex } from "../src/indexer/types";
import { ChangeSet } from "../src/edits/changeSet";

const model: ModelEntry = {
  id: "m",
  label: "M",
  provider: "flaky",
  slug: "flaky/model",
  contextWindow: 100000,
  supportsTools: true,
};

const index: RepoIndex = { getProjectMap: async () => "", getFileOutline: async () => "", refresh: () => {} };

function ctx(events: AgentEvent[]): ToolContext {
  return {
    workspaceRoot: "/tmp",
    changeSet: new ChangeSet(),
    index,
    approvals: { requestApproval: async () => true },
    readWorkspaceFile: async () => null,
    emit: (e) => events.push(e),
  };
}

describe("parseRetryAfter", () => {
  it("prefers the Retry-After header", () => {
    expect(parseRetryAfter("12", "{}")).toBe(12);
  });
  it("falls back to body metadata then a default", () => {
    expect(parseRetryAfter(null, JSON.stringify({ error: { metadata: { retry_after_seconds: 7 } } }))).toBe(7);
    expect(parseRetryAfter(null, "not json")).toBe(30);
  });
});

describe("friendlyError", () => {
  it("explains 402 and 429 in plain language", () => {
    expect(friendlyError(402, "{}")).toMatch(/credit/i);
    expect(friendlyError(429, "{}")).toMatch(/rate limit/i);
  });
});

describe("AgentLoop rate-limit retry", () => {
  it("retries after a 429 then succeeds", async () => {
    let calls = 0;
    const provider: ModelProvider = {
      id: "flaky",
      async chat(): Promise<ChatResult> {
        calls++;
        if (calls === 1) throw new RateLimitError(0, "rate limited");
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
      ctx: ctx(events),
      workspaceInfo: async () => ({ workspaceName: "w", os: "os" }),
    });

    await loop.run("hi", "m", new AbortController().signal);

    expect(calls).toBe(2);
    expect(events.some((e) => e.type === "status" && /free-tier limit|limit reached/i.test(e.text))).toBe(true);
    expect(events.some((e) => e.type === "assistant-done")).toBe(true);
    expect(events.some((e) => e.type === "error")).toBe(false);
  }, 20000);

  it("falls back to the next free model when one pool is exhausted", async () => {
    const modelA: ModelEntry = { id: "a", label: "Free A", provider: "flaky", slug: "x/a:free", contextWindow: 100000, supportsTools: true };
    const modelB: ModelEntry = { id: "b", label: "Free B", provider: "flaky", slug: "x/b:free", contextWindow: 100000, supportsTools: true };
    const provider: ModelProvider = {
      id: "flaky",
      async chat(req): Promise<ChatResult> {
        if (req.model === "x/a:free") throw new RateLimitError(0, "pool exhausted");
        return { content: "done on B", toolCalls: [], finishReason: "stop" };
      },
    };
    const registry = new ProviderRegistry();
    registry.register(provider);
    const events: AgentEvent[] = [];
    const loop = new AgentLoop({
      registry,
      tools: new ToolRegistry(),
      models: [modelA, modelB],
      ctx: ctx(events),
      workspaceInfo: async () => ({ workspaceName: "w", os: "os" }),
    });

    await loop.run("hi", "a", new AbortController().signal);

    expect(events.some((e) => e.type === "status" && /switching to Free B/i.test(e.text))).toBe(true);
    expect(events.some((e) => e.type === "assistant-done")).toBe(true);
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(loop.history.at(-1)?.content).toBe("done on B");
  });

  it("names the model that actually just failed in each hop, not the original pick", async () => {
    const a: ModelEntry = { id: "a", label: "Free A", provider: "flaky", slug: "x/a:free", contextWindow: 1e5, supportsTools: true };
    const b: ModelEntry = { id: "b", label: "Free B", provider: "flaky", slug: "x/b:free", contextWindow: 1e5, supportsTools: true };
    const c: ModelEntry = { id: "c", label: "Free C", provider: "flaky", slug: "x/c:free", contextWindow: 1e5, supportsTools: true };
    const provider: ModelProvider = {
      id: "flaky",
      async chat(req): Promise<ChatResult> {
        if (req.model === "x/c:free") return { content: "done", toolCalls: [], finishReason: "stop" };
        throw new RateLimitError(0, "pool exhausted");
      },
    };
    const registry = new ProviderRegistry();
    registry.register(provider);
    const events: AgentEvent[] = [];
    const loop = new AgentLoop({
      registry,
      tools: new ToolRegistry(),
      models: [a, b, c],
      ctx: ctx(events),
      workspaceInfo: async () => ({ workspaceName: "w", os: "os" }),
    });

    await loop.run("hi", "a", new AbortController().signal);

    const hopMessages = events
      .filter((e): e is Extract<AgentEvent, { type: "status" }> => e.type === "status" && /pool is exhausted/.test(e.text))
      .map((e) => e.text);
    // The first hop must blame "Free A" (what actually just failed) — the
    // original bug always blamed whatever `modelId` was passed to run(),
    // which never changes across hops.
    expect(hopMessages[0]).toMatch(/"Free A" pool is exhausted/);
    // If a second hop happens it must blame the model that failed THAT time
    // (Free B), never re-blame Free A again.
    if (hopMessages[1]) expect(hopMessages[1]).toMatch(/"Free B" pool is exhausted/);
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  it("stops after MAX_FALLBACK_HOPS consecutive failures and surfaces the raw provider text", async () => {
    const free: ModelEntry[] = ["a", "b", "c", "d", "e"].map((id) => ({
      id,
      label: `Free ${id.toUpperCase()}`,
      provider: "flaky",
      slug: `x/${id}:free`,
      contextWindow: 1e5,
      supportsTools: true,
    }));
    const provider: ModelProvider = {
      id: "flaky",
      async chat(): Promise<ChatResult> {
        throw new RateLimitError(0, "always busy", "upstream", '{"error":{"message":"synthetic upstream busy"}}');
      },
    };
    const registry = new ProviderRegistry();
    registry.register(provider);
    const events: AgentEvent[] = [];
    const loop = new AgentLoop({
      registry,
      tools: new ToolRegistry(),
      models: free,
      ctx: ctx(events),
      workspaceInfo: async () => ({ workspaceName: "w", os: "os" }),
    });

    await loop.run("hi", "a", new AbortController().signal);

    const hopMessages = events.filter((e) => e.type === "status" && /pool is exhausted/.test((e as any).text));
    // Exactly MAX_FALLBACK_HOPS(2) hops: original model "a" + 2 hops = 3
    // models tried, never cycling through all 5 free entries.
    expect(hopMessages).toHaveLength(2);
    const error = events.find((e) => e.type === "error") as Extract<AgentEvent, { type: "error" }>;
    expect(error).toBeTruthy();
    expect(error.message).toMatch(/account-wide/i);
    expect(error.message).toContain("synthetic upstream busy"); // raw text surfaced for diagnosis
  });

  it("remembers the healthy model and hops straight to it next time, updating the active model", async () => {
    const picked: ModelEntry = { id: "picked", label: "Picked", provider: "flaky", slug: "x/picked:free", contextWindow: 1e5, supportsTools: true };
    const good: ModelEntry = { id: "good", label: "Good", provider: "flaky", slug: "x/good:free", contextWindow: 1e5, supportsTools: true };
    const other: ModelEntry = { id: "other", label: "Other", provider: "flaky", slug: "x/other:free", contextWindow: 1e5, supportsTools: true };
    const provider: ModelProvider = {
      id: "flaky",
      async chat(req): Promise<ChatResult> {
        if (req.model === "x/good:free") return { content: "ok", toolCalls: [], finishReason: "stop" };
        throw new RateLimitError(0, "busy"); // picked and other are always congested
      },
    };
    const registry = new ProviderRegistry();
    registry.register(provider);
    const events: AgentEvent[] = [];
    const loop = new AgentLoop({
      registry,
      tools: new ToolRegistry(),
      models: [picked, good, other],
      ctx: ctx(events),
      workspaceInfo: async () => ({ workspaceName: "w", os: "os" }),
    });

    // First run: picked fails, hops (possibly via other) and eventually lands on good.
    await loop.run("one", "picked", new AbortController().signal);
    expect(events.some((e) => e.type === "active-model-changed" && (e as any).modelId === "good")).toBe(true);
    expect(loop.history.at(-1)?.content).toBe("ok");

    // Second run on the same picked model: the single hop must go straight to
    // the known-good model, so exactly one hop message appears.
    events.length = 0;
    await loop.run("two", "picked", new AbortController().signal);
    const hopMessages = events.filter((e) => e.type === "status" && /pool is exhausted/.test((e as any).text));
    expect(hopMessages).toHaveLength(1);
    expect((hopMessages[0] as any).text).toMatch(/switching to Good/);
  });

  it("does NOT hop models on an account-wide quota — explains instead", async () => {
    const modelA: ModelEntry = { id: "a", label: "Free A", provider: "flaky", slug: "x/a:free", contextWindow: 100000, supportsTools: true };
    const modelB: ModelEntry = { id: "b", label: "Free B", provider: "flaky", slug: "x/b:free", contextWindow: 100000, supportsTools: true };
    let calls = 0;
    const provider: ModelProvider = {
      id: "flaky",
      async chat(): Promise<ChatResult> {
        calls++;
        throw new RateLimitError(0, "daily free quota exceeded", "account");
      },
    };
    const registry = new ProviderRegistry();
    registry.register(provider);
    const events: AgentEvent[] = [];
    const loop = new AgentLoop({
      registry,
      tools: new ToolRegistry(),
      models: [modelA, modelB],
      ctx: ctx(events),
      workspaceInfo: async () => ({ workspaceName: "w", os: "os" }),
    });

    await loop.run("hi", "a", new AbortController().signal);

    expect(calls).toBe(1); // no retry, no hop — quota is account-wide
    expect(events.some((e) => e.type === "status" && /switching/i.test(e.text))).toBe(false);
    expect(events.some((e) => e.type === "error" && /daily free-model quota/i.test(e.message))).toBe(true);
  });

  it("gives up after the retry cap and surfaces an error", async () => {
    const provider: ModelProvider = {
      id: "flaky",
      async chat(): Promise<ChatResult> {
        throw new RateLimitError(0, "always limited");
      },
    };
    const registry = new ProviderRegistry();
    registry.register(provider);
    const events: AgentEvent[] = [];
    const loop = new AgentLoop({
      registry,
      tools: new ToolRegistry(),
      models: [model],
      ctx: ctx(events),
      workspaceInfo: async () => ({ workspaceName: "w", os: "os" }),
    });

    await loop.run("hi", "m", new AbortController().signal);

    expect(events.some((e) => e.type === "error" && /limited/i.test(e.message))).toBe(true);
  });
});
