import type { ToolSchema } from "../providers/types";
import type { Tool, ToolContext } from "./types";
import { fsTools } from "./fs";
import { searchTools } from "./search";
import { memoryTools } from "./memory";
import { terminalTools } from "./terminal";
import { gitTools } from "./git";
import { diagnosticsTools } from "./diagnostics";

/**
 * Plugin point for agent capabilities: future features (MCP client, test
 * runner, multi-agent dispatch) register here without touching the loop.
 */
export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.schema.name, tool);
  }

  schemas(): ToolSchema[] {
    return [...this.tools.values()].map((t) => t.schema);
  }

  /** Never rejects: every failure becomes an error string the model can react to. */
  async run(name: string, argsJson: string, ctx: ToolContext): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) {
      return `Error: unknown tool "${name}". Available: ${[...this.tools.keys()].join(", ")}`;
    }
    let args: any;
    try {
      args = argsJson.trim() === "" ? {} : JSON.parse(argsJson);
    } catch (e) {
      return `Error: invalid arguments for ${name} — not valid JSON (${(e as Error).message})`;
    }
    try {
      return await tool.execute(args, ctx);
    } catch (e) {
      return `Error: ${(e as Error).message}`;
    }
  }
}

export function registerBuiltinTools(reg: ToolRegistry): void {
  for (const t of [...fsTools, ...searchTools, ...memoryTools, ...terminalTools, ...gitTools, ...diagnosticsTools]) {
    reg.register(t);
  }
}