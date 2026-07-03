import type { ChatMessage, ModelEntry } from "../providers/types";
import { ProviderRegistry } from "../providers/registry";
import { ToolRegistry } from "../tools/registry";
import type { ToolContext } from "../tools/types";
import { pruneHistory } from "./contextManager";
import { buildSystemPrompt, type WorkspaceInfo } from "./systemPrompt";

const MAX_ITERATIONS = 30;
const RESERVE_TOKENS = 8000;

export interface AgentLoopDeps {
  registry: ProviderRegistry;
  tools: ToolRegistry;
  models: ModelEntry[];
  ctx: ToolContext;
  workspaceInfo: () => Promise<Omit<WorkspaceInfo, "projectMap">>;
  /** Completion-token cap per request; keeps free/low-balance accounts under their limit. */
  maxTokens?: () => number;
}

/**
 * The agentic core: model ⇄ tools until the model answers without tool calls.
 * All progress is reported through ctx.emit; the UI owns rendering and approvals.
 */
export class AgentLoop {
  readonly history: ChatMessage[] = [];

  constructor(private deps: AgentLoopDeps) {}

  reset(): void {
    this.history.length = 0;
  }

  async run(userMessage: string, modelId: string, signal: AbortSignal): Promise<void> {
    const { registry, tools, models, ctx } = this.deps;
    try {
      const { provider, entry } = registry.resolve(modelId, models);
      this.history.push({ role: "user", content: userMessage });

      const base = await this.deps.workspaceInfo();
      const projectMap = await ctx.index.getProjectMap();
      const system: ChatMessage = {
        role: "system",
        content: buildSystemPrompt({ ...base, projectMap }),
      };
      const budget = entry.contextWindow - RESERVE_TOKENS;

      for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
        if (signal.aborted) throw abortError();

        const messages = [system, ...pruneHistory(this.history, budget)];
        const result = await provider.chat(
          {
            model: entry.slug,
            messages,
            tools: entry.supportsTools ? tools.schemas() : [],
            maxTokens: this.deps.maxTokens?.(),
          },
          (d) => {
            if (d.text) ctx.emit({ type: "assistant-delta", text: d.text });
          },
          signal
        );

        if (result.toolCalls.length === 0) {
          this.history.push({ role: "assistant", content: result.content });
          ctx.emit({ type: "assistant-done" });
          return;
        }

        this.history.push({
          role: "assistant",
          content: result.content,
          toolCalls: result.toolCalls,
        });
        if (result.content) ctx.emit({ type: "assistant-done" });

        for (const call of result.toolCalls) {
          if (signal.aborted) throw abortError();
          ctx.emit({
            type: "tool-start",
            callId: call.id,
            name: call.name,
            summary: summarizeArgs(call.arguments),
          });
          const output = await tools.run(call.name, call.arguments, ctx);
          this.history.push({ role: "tool", content: output, toolCallId: call.id });
          ctx.emit({ type: "tool-end", callId: call.id, result: truncateForUi(output) });
          ctx.emit({
            type: "changeset-updated",
            files: ctx.changeSet.list().map((f) => ({ path: f.path, status: f.status })),
          });
        }
      }

      ctx.emit({
        type: "error",
        message: `Stopped after ${MAX_ITERATIONS} steps without finishing. Break the task into smaller pieces or continue with a follow-up message.`,
      });
    } catch (e) {
      if (isAbort(e)) {
        ctx.emit({ type: "status", text: "Stopped." });
      } else {
        ctx.emit({ type: "error", message: (e as Error).message });
      }
    }
  }
}

function summarizeArgs(argsJson: string): string {
  try {
    const args = JSON.parse(argsJson);
    const interesting = args.path ?? args.command ?? args.regex ?? args.message ?? "";
    return typeof interesting === "string" ? interesting.slice(0, 120) : "";
  } catch {
    return "";
  }
}

function truncateForUi(s: string): string {
  return s.length > 1500 ? s.slice(0, 1500) + "\n… (truncated in UI — full result sent to model)" : s;
}

function abortError(): Error {
  const e = new Error("aborted");
  e.name = "AbortError";
  return e;
}

function isAbort(e: unknown): boolean {
  return e instanceof Error && (e.name === "AbortError" || e.message.includes("aborted"));
}
