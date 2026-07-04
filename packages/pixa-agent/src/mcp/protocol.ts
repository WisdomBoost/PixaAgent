/**
 * Pure helpers for the MCP stdio transport: newline-delimited JSON-RPC 2.0.
 * Kept vscode-free and process-free so they are unit-testable.
 */

/** Split a stdout buffer into parsed JSON messages and the unconsumed tail. */
export function splitJsonLines(buffer: string): { messages: any[]; rest: string } {
  const lines = buffer.split("\n");
  const rest = lines.pop() ?? "";
  const messages: any[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      messages.push(JSON.parse(trimmed));
    } catch {
      // Non-JSON noise on stdout (some servers log there) — ignore the line.
    }
  }
  return { messages, rest };
}

/** Correlates JSON-RPC requests with their responses by id. */
export class RpcCorrelator {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

  /** Build a request envelope and return its id + a promise for the response result. */
  createRequest(method: string, params?: object): { id: number; envelope: object; response: Promise<any> } {
    const id = this.nextId++;
    const envelope = { jsonrpc: "2.0", id, method, params: params ?? {} };
    const response = new Promise<any>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    return { id, envelope, response };
  }

  /** Feed an incoming message; returns true if it settled a pending request. */
  handleMessage(msg: any): boolean {
    if (typeof msg?.id !== "number") return false; // notification or request from server
    const entry = this.pending.get(msg.id);
    if (!entry) return false;
    this.pending.delete(msg.id);
    if (msg.error) {
      entry.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
    } else {
      entry.resolve(msg.result);
    }
    return true;
  }

  /** Reject everything outstanding (process died). */
  rejectAll(reason: string): void {
    for (const [, entry] of this.pending) {
      entry.reject(new Error(reason));
    }
    this.pending.clear();
  }
}

/** Flatten an MCP tools/call result into the string handed to the model. */
export function flattenToolResult(result: any): string {
  const parts: string[] = [];
  for (const item of result?.content ?? []) {
    if (item?.type === "text" && typeof item.text === "string") {
      parts.push(item.text);
    } else if (item?.type) {
      parts.push(`[${item.type} content omitted]`);
    }
  }
  const text = parts.join("\n") || "(empty result)";
  return result?.isError ? `Error from MCP tool: ${text}` : text;
}
