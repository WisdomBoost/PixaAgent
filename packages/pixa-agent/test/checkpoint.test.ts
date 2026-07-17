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
  provider: "scripted",
  slug: "scripted/model",
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

function noopTools(): ToolRegistry {
  const tools = new ToolRegistry();
  tools.register({
    schema: { name: "read_file", description: "read", parameters: { type: "object", properties: {} } },
    execute: async () => "file contents",
  });
  return tools;
}

describe("AgentLoop checkpointing", () => {
  it("checkpoints after every tool-calling iteration, not just at the end", async () => {
    let turn = 0;
    const provider: ModelProvider = {
      id: "scripted",
      async chat(): Promise<ChatResult> {
        turn++;
        if (turn <= 3) {
          return {
            content: "",
            toolCalls: [{ id: `c${turn}`, name: "read_file", arguments: "{}" }],
            finishReason: "tool_calls",
          };
        }
        return { content: "done", toolCalls: [], finishReason: "stop" };
      },
    };
    const registry = new ProviderRegistry();
    registry.register(provider);

    // Each checkpoint snapshots how much history existed at that moment —
    // proving progress is durable mid-task, not only after the run ends.
    const snapshots: number[] = [];
    const loop = new AgentLoop({
      registry,
      tools: noopTools(),
      models: [model],
      ctx: ctx([]),
      workspaceInfo: async () => ({ workspaceName: "w", os: "os" }),
      onCheckpoint: () => snapshots.push(loop.history.length),
    });

    await loop.run("long task", "m", new AbortController().signal);

    // Three tool-calling iterations => three checkpoints.
    expect(snapshots).toHaveLength(3);
    // History grows monotonically, so later checkpoints hold strictly more work.
    expect(snapshots[0]).toBeLessThan(snapshots[1]);
    expect(snapshots[1]).toBeLessThan(snapshots[2]);
  });

  it("works when the host provides no checkpoint hook", async () => {
    const provider: ModelProvider = {
      id: "scripted",
      async chat(): Promise<ChatResult> {
        return { content: "done", toolCalls: [], finishReason: "stop" };
      },
    };
    const registry = new ProviderRegistry();
    registry.register(provider);
    const loop = new AgentLoop({
      registry,
      tools: noopTools(),
      models: [model],
      ctx: ctx([]),
      workspaceInfo: async () => ({ workspaceName: "w", os: "os" }),
      // onCheckpoint intentionally omitted — must not throw.
    });

    await expect(loop.run("hi", "m", new AbortController().signal)).resolves.toBeUndefined();
  });
});
