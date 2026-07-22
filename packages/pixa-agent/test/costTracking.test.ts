import { describe, it, expect } from "vitest";
import { AgentLoop } from "../src/agent/loop";
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
  provider: "billed",
  slug: "billed/model",
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

describe("AgentLoop cost tracking", () => {
  it("emits per-request usage and accumulates a running session total across tool-calling turns", async () => {
    let call = 0;
    const provider: ModelProvider = {
      id: "billed",
      async chat(): Promise<ChatResult> {
        call++;
        if (call === 1) {
          return {
            content: "",
            toolCalls: [{ id: "c1", name: "noop", arguments: "{}" }],
            finishReason: "tool_calls",
            usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150, costUsd: 0.001 },
          };
        }
        return {
          content: "done",
          toolCalls: [],
          finishReason: "stop",
          usage: { promptTokens: 200, completionTokens: 20, totalTokens: 220, costUsd: 0.0005 },
        };
      },
    };
    const registry = new ProviderRegistry();
    registry.register(provider);
    const tools = new ToolRegistry();
    tools.register({
      schema: { name: "noop", description: "no-op", parameters: { type: "object", properties: {} } },
      execute: async () => "ok",
    });
    const events: AgentEvent[] = [];
    const loop = new AgentLoop({
      registry,
      tools,
      models: [model],
      ctx: ctx(events),
      workspaceInfo: async () => ({ workspaceName: "w", os: "os" }),
    });

    await loop.run("do a thing", "m", new AbortController().signal);

    const usageEvents = events.filter((e) => e.type === "usage") as Extract<AgentEvent, { type: "usage" }>[];
    expect(usageEvents).toHaveLength(2);
    expect(usageEvents[0].requestCostUsd).toBeCloseTo(0.001);
    expect(usageEvents[0].sessionCostUsd).toBeCloseTo(0.001);
    expect(usageEvents[1].requestCostUsd).toBeCloseTo(0.0005);
    expect(usageEvents[1].sessionCostUsd).toBeCloseTo(0.0015); // accumulated across both turns
  });

  it("does not count null cost (unreported by provider) toward the session total", async () => {
    const provider: ModelProvider = {
      id: "billed",
      async chat(): Promise<ChatResult> {
        return {
          content: "done",
          toolCalls: [],
          finishReason: "stop",
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, costUsd: null },
        };
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

    const usage = events.find((e) => e.type === "usage") as Extract<AgentEvent, { type: "usage" }>;
    expect(usage.requestCostUsd).toBeNull();
    expect(usage.sessionCostUsd).toBe(0);
  });

  it("includes provider and model identity on usage events for dashboard aggregation", async () => {
    const provider: ModelProvider = {
      id: "billed",
      async chat(): Promise<ChatResult> {
        return {
          content: "done",
          toolCalls: [],
          finishReason: "stop",
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, costUsd: 0.002 },
        };
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

    await loop.run("first", "m", new AbortController().signal);

    const usage = events.find((e) => e.type === "usage") as Extract<AgentEvent, { type: "usage" }> & {
      providerId: string;
      modelId: string;
      modelLabel: string;
    };
    expect(usage.providerId).toBe("billed");
    expect(usage.modelId).toBe("m");
    expect(usage.modelLabel).toBe("M");
  });

  it("resets the session total on reset()", async () => {
    const provider: ModelProvider = {
      id: "billed",
      async chat(): Promise<ChatResult> {
        return {
          content: "done",
          toolCalls: [],
          finishReason: "stop",
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, costUsd: 0.002 },
        };
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

    await loop.run("first", "m", new AbortController().signal);
    loop.reset();
    events.length = 0;
    await loop.run("second", "m", new AbortController().signal);

    const usage = events.find((e) => e.type === "usage") as Extract<AgentEvent, { type: "usage" }>;
    expect(usage.sessionCostUsd).toBeCloseTo(0.002); // not 0.004 — reset() zeroed the running total
  });
});
