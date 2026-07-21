import { describe, it, expect } from "vitest";
import { looksLikeUnparsedToolCall } from "../src/agent/taskGraph";

/**
 * Small local models advertise tool support, then write the tool call as prose.
 * The strings below are REAL observed output: the first from qwen2.5-coder:1.5b
 * via Ollama, the second from the same model in the chat panel.
 */
describe("looksLikeUnparsedToolCall", () => {
  it("detects the malformed blob a 1.5B model returns", () => {
    expect(looksLikeUnparsedToolCall('{"name": "", "arguments": {}}')).toBe(true);
  });

  it("detects a populated but text-only tool call", () => {
    expect(looksLikeUnparsedToolCall('{"name": "semantic_search", "arguments": {"query": "hello"}}')).toBe(true);
  });

  it("ignores ordinary prose answers", () => {
    expect(looksLikeUnparsedToolCall("This project is a VS Code extension.")).toBe(false);
    expect(looksLikeUnparsedToolCall("")).toBe(false);
  });

  it("ignores JSON the user legitimately asked for", () => {
    expect(looksLikeUnparsedToolCall('{"port": 8080, "host": "localhost"}')).toBe(false);
  });

  it("ignores a long JSON document that merely mentions the keys", () => {
    const long = '{"name": "x", "arguments": "y", "pad": "' + "z".repeat(2100) + '"}';
    expect(looksLikeUnparsedToolCall(long)).toBe(false);
  });
});
import { isParallelSafe, groupIntoBatches } from "../src/agent/taskGraph";
import type { ChatResult, ModelEntry, ModelProvider, ToolCall } from "../src/providers/types";
import { AgentLoop } from "../src/agent/loop";
import { ProviderRegistry } from "../src/providers/registry";
import { ToolRegistry } from "../src/tools/registry";
import type { AgentEvent } from "../src/agent/events";
import type { ToolContext } from "../src/tools/types";
import type { RepoIndex } from "../src/indexer/types";
import { ChangeSet } from "../src/edits/changeSet";

const call = (name: string, id = name): ToolCall => ({ id, name, arguments: "{}" });

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

/** A tool that records how many copies of itself run at the same time. */
function concurrencyProbe() {
  const state = { inFlight: 0, maxInFlight: 0 };
  const execute = async () => {
    state.inFlight++;
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    await new Promise((r) => setTimeout(r, 10));
    state.inFlight--;
    return "ok";
  };
  return { state, execute };
}

/** Loop harness that issues one turn of tool calls, then finishes. */
async function runWithCalls(toolCalls: ToolCall[], tools: ToolRegistry) {
  let turn = 0;
  const provider: ModelProvider = {
    id: "scripted",
    async chat(): Promise<ChatResult> {
      turn++;
      if (turn === 1) return { content: "", toolCalls, finishReason: "tool_calls" };
      return { content: "done", toolCalls: [], finishReason: "stop" };
    },
  };
  const registry = new ProviderRegistry();
  registry.register(provider);
  const events: AgentEvent[] = [];
  const loop = new AgentLoop({
    registry,
    tools,
    models: [model],
    ctx: ctx(events),
    workspaceInfo: async () => ({ workspaceName: "w", os: "os" }),
  });
  await loop.run("task", "m", new AbortController().signal);
  return { loop, events };
}

describe("isParallelSafe", () => {
  it("treats read-only tools as parallel-safe", () => {
    expect(isParallelSafe("read_file")).toBe(true);
    expect(isParallelSafe("search_workspace")).toBe(true);
    expect(isParallelSafe("get_file_outline")).toBe(true);
    expect(isParallelSafe("git_status")).toBe(true);
  });

  it("treats mutating and side-effecting tools as unsafe", () => {
    // edit_file MUST stay sequential: ChangeSet composes sequential edits.
    expect(isParallelSafe("edit_file")).toBe(false);
    expect(isParallelSafe("write_file")).toBe(false);
    expect(isParallelSafe("run_command")).toBe(false);
    expect(isParallelSafe("git_commit")).toBe(false);
  });

  it("treats unknown/third-party tools as unsafe by default", () => {
    // MCP servers are third-party code — we cannot assume they are read-only.
    expect(isParallelSafe("mcp__filesystem__write")).toBe(false);
    expect(isParallelSafe("some_future_tool")).toBe(false);
  });
});

describe("groupIntoBatches", () => {
  it("groups consecutive read-only calls into one parallel batch", () => {
    const calls = [call("read_file", "a"), call("read_file", "b"), call("search_workspace", "c")];
    expect(groupIntoBatches(calls)).toEqual([[calls[0], calls[1], calls[2]]]);
  });

  it("puts each mutating call in its own batch, preserving order", () => {
    const calls = [call("edit_file", "a"), call("edit_file", "b")];
    expect(groupIntoBatches(calls)).toEqual([[calls[0]], [calls[1]]]);
  });

  it("splits a mixed sequence into ordered batches without reordering", () => {
    const calls = [
      call("read_file", "r1"),
      call("read_file", "r2"),
      call("edit_file", "e1"),
      call("read_file", "r3"),
      call("run_command", "c1"),
    ];
    expect(groupIntoBatches(calls)).toEqual([
      [calls[0], calls[1]], // parallel reads
      [calls[2]], // edit alone
      [calls[3]], // read after the edit — its own batch, order preserved
      [calls[4]], // command alone
    ]);
  });

  it("returns no batches for no calls", () => {
    expect(groupIntoBatches([])).toEqual([]);
  });
});

describe("AgentLoop parallel tool execution", () => {
  it("runs independent read-only calls concurrently", async () => {
    const probe = concurrencyProbe();
    const tools = new ToolRegistry();
    tools.register({
      schema: { name: "read_file", description: "read", parameters: { type: "object", properties: {} } },
      execute: probe.execute,
    });

    await runWithCalls([call("read_file", "a"), call("read_file", "b"), call("read_file", "c")], tools);

    expect(probe.state.maxInFlight).toBe(3); // all three ran at once
  });

  it("runs mutating calls strictly one at a time", async () => {
    const probe = concurrencyProbe();
    const tools = new ToolRegistry();
    tools.register({
      schema: { name: "edit_file", description: "edit", parameters: { type: "object", properties: {} } },
      execute: probe.execute,
    });

    await runWithCalls([call("edit_file", "a"), call("edit_file", "b"), call("edit_file", "c")], tools);

    // Sequential is REQUIRED: ChangeSet composes sequential edits per file.
    expect(probe.state.maxInFlight).toBe(1);
  });

  it("keeps tool results paired to their call ids and in order", async () => {
    const tools = new ToolRegistry();
    for (const name of ["read_file", "edit_file"]) {
      tools.register({
        schema: { name, description: name, parameters: { type: "object", properties: {} } },
        execute: async (_a, _c) => `result-of-${name}`,
      });
    }

    const { loop } = await runWithCalls(
      [call("read_file", "r1"), call("read_file", "r2"), call("edit_file", "e1")],
      tools
    );

    const toolMsgs = loop.history.filter((m) => m.role === "tool");
    expect(toolMsgs.map((m) => m.toolCallId)).toEqual(["r1", "r2", "e1"]);
    expect(toolMsgs[2].content).toBe("result-of-edit_file");
  });
});
