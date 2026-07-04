import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { splitJsonLines, RpcCorrelator, flattenToolResult } from "../src/mcp/protocol";
import { McpClient } from "../src/mcp/client";

describe("splitJsonLines", () => {
  it("parses complete lines, keeps the tail, skips junk", () => {
    const { messages, rest } = splitJsonLines('{"a":1}\nnot json\n{"b":2}\n{"partial');
    expect(messages).toEqual([{ a: 1 }, { b: 2 }]);
    expect(rest).toBe('{"partial');
  });
});

describe("RpcCorrelator", () => {
  it("matches responses to requests by id and rejects on error", async () => {
    const c = new RpcCorrelator();
    const r1 = c.createRequest("tools/list");
    const r2 = c.createRequest("tools/call");
    expect(c.handleMessage({ jsonrpc: "2.0", id: r2.id, error: { message: "boom" } })).toBe(true);
    expect(c.handleMessage({ jsonrpc: "2.0", id: r1.id, result: { ok: true } })).toBe(true);
    expect(c.handleMessage({ jsonrpc: "2.0", method: "notifications/whatever" })).toBe(false);
    await expect(r1.response).resolves.toEqual({ ok: true });
    await expect(r2.response).rejects.toThrow("boom");
  });
});

describe("flattenToolResult", () => {
  it("joins text parts and flags errors", () => {
    expect(flattenToolResult({ content: [{ type: "text", text: "a" }, { type: "image" }] })).toBe(
      "a\n[image content omitted]"
    );
    expect(flattenToolResult({ isError: true, content: [{ type: "text", text: "bad" }] })).toMatch(/^Error from MCP tool: bad/);
  });
});

// A tiny real MCP server implementing initialize / tools/list / tools/call over stdio.
const FAKE_SERVER = `
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n");
  if (msg.method === "initialize") reply({ protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "fake", version: "1.0" } });
  else if (msg.method === "tools/list") reply({ tools: [{ name: "echo", description: "echoes input", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] });
  else if (msg.method === "tools/call") reply({ content: [{ type: "text", text: "echo: " + (msg.params.arguments.text || "") }] });
});
`;

describe("McpClient end-to-end against a fake stdio server", () => {
  let client: McpClient | undefined;
  let scriptPath: string | undefined;

  afterEach(async () => {
    client?.dispose();
    if (scriptPath) await fs.rm(scriptPath, { force: true });
  });

  it("initializes, lists tools, and calls one", async () => {
    scriptPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "pixa-mcp-")), "server.js");
    await fs.writeFile(scriptPath, FAKE_SERVER);
    client = new McpClient("fake", { command: process.execPath, args: [scriptPath] });

    const tools = await client.start();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("echo");

    const result = await client.callTool("echo", { text: "hello mcp" });
    expect(result).toBe("echo: hello mcp");
  }, 15_000);
});
