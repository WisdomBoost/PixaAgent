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
    expect(events.some((e) => e.type === "status" && /rate limit/i.test(e.text))).toBe(true);
    expect(events.some((e) => e.type === "assistant-done")).toBe(true);
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

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
