import { spawn, type ChildProcess } from "node:child_process";
import { splitJsonLines, RpcCorrelator, flattenToolResult } from "./protocol";

const REQUEST_TIMEOUT_MS = 20_000;
const PROTOCOL_VERSION = "2024-11-05";

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: object;
}

/**
 * Minimal MCP client over the stdio transport (newline-delimited JSON-RPC).
 * Covers exactly what the agent needs: initialize, tools/list, tools/call.
 */
export class McpClient {
  private proc: ChildProcess | undefined;
  private correlator = new RpcCorrelator();
  private stdoutBuffer = "";

  constructor(
    readonly serverName: string,
    private config: McpServerConfig
  ) {}

  async start(): Promise<McpToolDef[]> {
    const useShell = process.platform === "win32"; // resolves npx/npm .cmd shims
    const command =
      useShell && this.config.command.includes(" ") && !this.config.command.startsWith('"')
        ? `"${this.config.command}"` // quote paths with spaces for cmd.exe
        : this.config.command;
    this.proc = spawn(command, this.config.args ?? [], {
      env: { ...process.env, ...this.config.env },
      stdio: ["pipe", "pipe", "pipe"],
      shell: useShell,
      windowsHide: true,
    });

    this.proc.stdout!.on("data", (chunk: Buffer) => {
      this.stdoutBuffer += chunk.toString("utf8");
      const { messages, rest } = splitJsonLines(this.stdoutBuffer);
      this.stdoutBuffer = rest;
      for (const msg of messages) this.correlator.handleMessage(msg);
    });
    this.proc.on("exit", (code) => {
      this.correlator.rejectAll(`MCP server "${this.serverName}" exited (code ${code})`);
      this.proc = undefined;
    });
    this.proc.on("error", (err) => {
      this.correlator.rejectAll(`MCP server "${this.serverName}" failed to start: ${err.message}`);
      this.proc = undefined;
    });

    await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "pixa-agent", version: "0.2.0" },
    });
    this.notify("notifications/initialized");

    const result = await this.request("tools/list");
    return (result?.tools ?? []).map((t: any) => ({
      name: String(t.name),
      description: String(t.description ?? ""),
      inputSchema: t.inputSchema ?? { type: "object", properties: {} },
    }));
  }

  async callTool(name: string, args: object): Promise<string> {
    const result = await this.request("tools/call", { name, arguments: args });
    return flattenToolResult(result);
  }

  get alive(): boolean {
    return !!this.proc;
  }

  dispose(): void {
    this.proc?.kill();
    this.proc = undefined;
  }

  private request(method: string, params?: object): Promise<any> {
    if (!this.proc?.stdin?.writable) {
      return Promise.reject(new Error(`MCP server "${this.serverName}" is not running`));
    }
    const { envelope, response } = this.correlator.createRequest(method, params);
    this.proc.stdin.write(JSON.stringify(envelope) + "\n");
    return withTimeout(response, REQUEST_TIMEOUT_MS, `MCP ${method} timed out for "${this.serverName}"`);
  }

  private notify(method: string, params?: object): void {
    if (!this.proc?.stdin?.writable) return;
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params: params ?? {} }) + "\n");
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}
