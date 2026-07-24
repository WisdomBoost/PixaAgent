import type { ToolCall } from "../providers/types";

/**
 * Execution planning for a batch of tool calls.
 *
 * The model often asks for several tools in one turn (e.g. three file reads).
 * Running independent read-only calls concurrently is a real speedup, but
 * anything that mutates state or has side effects MUST stay sequential:
 *
 *  - edit/write/create: ChangeSet composes *sequential* edits on a file, so
 *    running them concurrently would race and corrupt the staged content.
 *  - run_command / git_commit: side effects + a human approval gate; order
 *    and one-at-a-time execution are part of the safety model.
 *  - MCP tools: third-party code, we cannot assume they are read-only.
 *
 * Policy is an ALLOWLIST — anything not proven read-only is treated as unsafe
 * (fail closed). Pure module: no vscode, no IO, fully unit-testable.
 */

/** Built-in tools that only read state and are therefore safe to run concurrently. */
const PARALLEL_SAFE_TOOLS: ReadonlySet<string> = new Set([
  "read_file",
  "list_directory",
  "search_workspace",
  "get_project_map",
  "get_file_outline",
  "get_diagnostics",
  "git_status",
  "git_diff",
]);

/** True only for tools known to be read-only. Unknown tools are unsafe by default. */
/**
 * True when a model emitted something shaped like a tool call as plain text
 * instead of using the native tool_calls field.
 *
 * Small local models (~1-3B) advertise tool support and then imitate the
 * *shape* of a call in prose. The agent sees zero tool calls, prints the blob
 * as its answer, and stops — which reads as "Pixa is broken" rather than
 * "this model is too small". Detecting it lets us say so plainly.
 */
export function looksLikeUnparsedToolCall(content: string): boolean {
  const t = content.trim();
  // A single object ({...}) or an array of them ([...]); reject prose and huge blobs.
  if (!(t.startsWith("{") || t.startsWith("[")) || t.length > 2000) return false;
  // Match the two shapes these models produce: OpenAI-style {"name":...,
  // "arguments":...} and the bare {"function":...} variant.
  return /"(name|function)"\s*:/.test(t) && /"(arguments|parameters)"\s*:/.test(t);
}

/** A tool call recovered from text; `arguments` is a raw JSON string like ToolCall.arguments. */
export interface ParsedToolCall {
  name: string;
  arguments: string;
}

/**
 * Turn a text-form tool call into executable calls. Some runtimes (e.g. Ollama
 * with qwen2.5-coder) return a valid call as JSON text in `content` instead of
 * the native tool_calls field; this recovers it.
 *
 * Safety: only calls naming a tool in `knownToolNames` are returned — a
 * hallucinated or non-existent tool is dropped, so we never act on garbage.
 * Everything downstream (diff approval, command prompts) is unchanged. Never
 * throws; returns [] for anything that isn't a well-formed call to a real tool.
 */
export function parseTextToolCalls(content: string, knownToolNames: ReadonlySet<string>): ParsedToolCall[] {
  if (!looksLikeUnparsedToolCall(content)) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(content.trim());
  } catch {
    return [];
  }

  const items = Array.isArray(parsed) ? parsed : [parsed];
  const calls: ParsedToolCall[] = [];
  for (const item of items) {
    const call = normalizeTextCall(item);
    if (call && knownToolNames.has(call.name)) calls.push(call);
  }
  return calls;
}

/** Normalize the bare ({name,arguments}) and wrapped ({function:{...}}) shapes to a ParsedToolCall. */
function normalizeTextCall(item: unknown): ParsedToolCall | null {
  if (!item || typeof item !== "object") return null;
  const obj = item as Record<string, unknown>;
  const fn = obj.function && typeof obj.function === "object" ? (obj.function as Record<string, unknown>) : obj;

  const name = typeof fn.name === "string" ? fn.name.trim() : "";
  if (!name) return null;

  const rawArgs = fn.arguments ?? fn.parameters ?? {};
  const args = typeof rawArgs === "string" ? rawArgs : JSON.stringify(rawArgs);
  return { name, arguments: args };
}

export function isParallelSafe(toolName: string): boolean {
  return PARALLEL_SAFE_TOOLS.has(toolName);
}

/**
 * Split an ordered list of tool calls into ordered batches.
 * Each batch runs to completion before the next starts; calls *within* a batch
 * may run concurrently. Relative order of calls is never changed.
 */
export function groupIntoBatches(calls: ToolCall[]): ToolCall[][] {
  const batches: ToolCall[][] = [];
  let parallelRun: ToolCall[] = [];

  for (const call of calls) {
    if (isParallelSafe(call.name)) {
      parallelRun.push(call);
      continue;
    }
    // An unsafe call ends any pending parallel run and executes alone.
    if (parallelRun.length > 0) {
      batches.push(parallelRun);
      parallelRun = [];
    }
    batches.push([call]);
  }

  if (parallelRun.length > 0) batches.push(parallelRun);
  return batches;
}
