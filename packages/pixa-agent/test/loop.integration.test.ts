import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AgentLoop } from "../src/agent/loop";
import type { AgentEvent } from "../src/agent/events";
import { ProviderRegistry } from "../src/providers/registry";
import type { ChatRequest, ChatResult, ModelEntry, ModelProvider } from "../src/providers/types";
import { ToolRegistry } from "../src/tools/registry";
import { fsTools } from "../src/tools/fs";
import { terminalTools } from "../src/tools/terminal";
import { ChangeSet } from "../src/edits/changeSet";
import type { RepoIndex } from "../src/indexer/types";
import type { ToolContext } from "../src/tools/types";

/** Scripted provider: returns queued results, recording each request. */
class FakeProvider implements ModelProvider {
  id = "fake";
  requests: ChatRequest[] = [];
  private script: ChatResult[];
  constructor(script: ChatResult[]) {
    this.script = [...script];
  }
  async chat(req: ChatRequest): Promise<ChatResult> {
    this.requests.push(req);
    const next = this.script.shift();
    if (!next) throw new Error("FakeProvider script exhausted");
    return next;
  }
}

const fakeIndex: RepoIndex = {
  getProjectMap: async () => "app.js",
  getFileOutline: async () => "no symbols",
  refresh: () => {},
};

const model: ModelEntry = {
  id: "fake-model",
  label: "Fake",
  provider: "fake",
  slug: "fake/model",
  contextWindow: 100000,
  supportsTools: true,
};

describe("agent loop end-to-end (scripted provider, real tools)", () => {
  let dir: string;
  let events: AgentEvent[];
  let approvalsRequested: string[];

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "pixa-e2e-"));
    await fs.writeFile(path.join(dir, "app.js"), "const port = 3000;\nmodule.exports = { port };\n");
    events = [];
    approvalsRequested = [];
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  function makeCtx(changeSet: ChangeSet): ToolContext {
    return {
      workspaceRoot: dir,
      changeSet,
      index: fakeIndex,
      approvals: {
        requestApproval: async (_kind, detail) => {
          approvalsRequested.push(detail);
          return true;
        },
      },
      readWorkspaceFile: async (absPath) => {
        try {
          return await fs.readFile(absPath, "utf8");
        } catch {
          return null;
        }
      },
      emit: (e) => events.push(e),
    };
  }

  it("reads, stages an edit, runs an approved command, and finishes", async () => {
    const provider = new FakeProvider([
      {
        content: "",
        toolCalls: [
          { id: "c1", name: "read_file", arguments: JSON.stringify({ path: "app.js" }) },
          {
            id: "c2",
            name: "edit_file",
            arguments: JSON.stringify({
              path: "app.js",
              old_string: "const port = 3000;",
              new_string: "const port = process.env.PORT || 3000;",
            }),
          },
        ],
        finishReason: "tool_calls",
      },
      {
        content: "",
        toolCalls: [{ id: "c3", name: "run_command", arguments: JSON.stringify({ command: "echo hello" }) }],
        finishReason: "tool_calls",
      },
      { content: "Done — staged the port change and verified the shell.", toolCalls: [], finishReason: "stop" },
    ]);

    const registry = new ProviderRegistry();
    registry.register(provider);
    const tools = new ToolRegistry();
    for (const t of [...fsTools, ...terminalTools]) tools.register(t);
    const changeSet = new ChangeSet();
    const ctx = makeCtx(changeSet);

    const loop = new AgentLoop({
      registry,
      tools,
      models: [model],
      ctx,
      workspaceInfo: async () => ({ workspaceName: "sandbox", os: "test-os" }),
    });

    await loop.run("Make the port configurable", "fake-model", new AbortController().signal);

    // Tool results flowed back to the model with correct pairing.
    const toolMsgs = loop.history.filter((m) => m.role === "tool");
    expect(toolMsgs.map((m) => m.toolCallId)).toEqual(["c1", "c2", "c3"]);
    expect(toolMsgs[0].content).toContain("const port = 3000;"); // read_file saw the real file
    expect(toolMsgs[2].content).toContain("hello"); // command output captured

    // Edit staged, not written to disk.
    const staged = changeSet.get("app.js")!;
    expect(staged.status).toBe("pending");
    expect(staged.newContent).toContain("process.env.PORT");
    const onDisk = await fs.readFile(path.join(dir, "app.js"), "utf8");
    expect(onDisk).toContain("const port = 3000;");

    // Approval was requested exactly once, for the command.
    expect(approvalsRequested).toEqual(["echo hello"]);

    // Events tell the UI story: tool activity then final answer.
    expect(events.filter((e) => e.type === "tool-start")).toHaveLength(3);
    expect(events.filter((e) => e.type === "tool-end")).toHaveLength(3);
    expect(events.some((e) => e.type === "assistant-done")).toBe(true);

    // System prompt carried workspace context.
    expect(provider.requests[0].messages[0].role).toBe("system");
    expect(provider.requests[0].messages[0].content).toContain("sandbox");
  });

  it("declined approval reaches the model as a refusal, not an execution", async () => {
    const provider = new FakeProvider([
      {
        content: "",
        toolCalls: [{ id: "c1", name: "run_command", arguments: JSON.stringify({ command: "npm run deploy" }) }],
        finishReason: "tool_calls",
      },
      { content: "Understood, I won't run it.", toolCalls: [], finishReason: "stop" },
    ]);
    const registry = new ProviderRegistry();
    registry.register(provider);
    const tools = new ToolRegistry();
    for (const t of terminalTools) tools.register(t);
    const changeSet = new ChangeSet();
    const ctx = makeCtx(changeSet);
    ctx.approvals = { requestApproval: async () => false };

    const loop = new AgentLoop({
      registry,
      tools,
      models: [model],
      ctx,
      workspaceInfo: async () => ({ workspaceName: "sandbox", os: "test-os" }),
    });
    await loop.run("clean up", "fake-model", new AbortController().signal);

    const toolMsg = loop.history.find((m) => m.role === "tool")!;
    expect(toolMsg.content).toMatch(/declined/i);
  });
});
