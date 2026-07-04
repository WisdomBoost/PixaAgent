import { McpClient, type McpServerConfig } from "./client";
import { ToolRegistry } from "../tools/registry";
import type { Tool } from "../tools/types";

/**
 * Reads the pixa.mcpServers config, starts each server, and registers its
 * tools into the agent's ToolRegistry as `mcp__<server>__<tool>` — the same
 * plugin point built-in tools use, so the agent loop needs no MCP awareness.
 */
export class McpManager {
  private clients: McpClient[] = [];

  constructor(private log: (message: string) => void) {}

  async connectAll(servers: Record<string, McpServerConfig>, registry: ToolRegistry): Promise<void> {
    const names = Object.keys(servers ?? {});
    if (names.length === 0) return;

    await Promise.all(
      names.map(async (name) => {
        const client = new McpClient(name, servers[name]);
        try {
          const tools = await client.start();
          this.clients.push(client);
          for (const def of tools) {
            registry.register(this.wrapTool(client, name, def));
          }
          this.log(`MCP: connected "${name}" — ${tools.length} tool(s): ${tools.map((t) => t.name).join(", ") || "none"}`);
        } catch (e) {
          client.dispose();
          this.log(`MCP: server "${name}" unavailable — ${(e as Error).message}`);
        }
      })
    );
  }

  private wrapTool(client: McpClient, serverName: string, def: { name: string; description: string; inputSchema: object }): Tool {
    return {
      schema: {
        name: `mcp__${serverName}__${def.name}`,
        description: `[MCP:${serverName}] ${def.description}`.slice(0, 1024),
        parameters: def.inputSchema,
      },
      execute: async (args) => {
        if (!client.alive) return `Error: MCP server "${serverName}" is no longer running. Reload the window to restart it.`;
        return client.callTool(def.name, args ?? {});
      },
    };
  }

  dispose(): void {
    for (const c of this.clients) c.dispose();
    this.clients = [];
  }
}
