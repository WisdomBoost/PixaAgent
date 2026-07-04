import type { ChatMessage, ChatResult, ChatRequest, ModelProvider, StreamDelta, ModelEntry } from "../providers/types";
import { ProviderRegistry } from "../providers/registry";
import { RateLimitError } from "../providers/errors";
import { ToolRegistry } from "../tools/registry";
import type { ToolContext } from "../tools/types";
import { pruneHistory } from "./contextManager";
import { buildSystemPrompt, type WorkspaceInfo } from "./systemPrompt";

const MAX_ITERATIONS = 30;
const RESERVE_TOKENS = 8000;
// One quick retry per model — persistent 429s trigger a free-model fallback hop instead.
const MAX_RATE_LIMIT_RETRIES = 1;
const MAX_RETRY_WAIT_SECONDS = 30;

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
  private sessionCostUsd = 0;

  constructor(private deps: AgentLoopDeps) {}

  reset(): void {
    this.history.length = 0;
    this.sessionCostUsd = 0;
  }

  get sessionCost(): number {
    return this.sessionCostUsd;
  }

  /** Rehydrate a persisted session (window reload). */
  restore(history: ChatMessage[], sessionCostUsd: number): void {
    this.history.length = 0;
    this.history.push(...history);
    this.sessionCostUsd = sessionCostUsd;
  }

  /** Call the provider, absorbing transient 429s with the server's suggested wait. */
  private async chatWithRetry(
    provider: ModelProvider,
    request: ChatRequest,
    onDelta: (d: StreamDelta) => void,
    signal: AbortSignal
  ): Promise<ChatResult> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await provider.chat(request, onDelta, signal);
      } catch (e) {
        if (e instanceof RateLimitError && attempt < MAX_RATE_LIMIT_RETRIES && !signal.aborted) {
          const wait = Math.min(Math.max(Math.ceil(e.retryAfterSeconds), 1), MAX_RETRY_WAIT_SECONDS);
          this.deps.ctx.emit({
            type: "status",
            text: `Free-tier rate limit hit — retrying in ${wait}s (attempt ${attempt + 1}/${MAX_RATE_LIMIT_RETRIES}). Switch model or add an OpenRouter key to avoid this.`,
          });
          await delay(wait * 1000, signal);
          continue;
        }
        throw e;
      }
    }
  }

  async run(userMessage: string, modelId: string, signal: AbortSignal): Promise<void> {
    const { registry, tools, models, ctx } = this.deps;
    try {
      let { provider, entry } = registry.resolve(modelId, models);
      const triedModels = new Set<string>([entry.id]);
      this.history.push({ role: "user", content: userMessage });

      const base = await this.deps.workspaceInfo();
      const projectMap = await ctx.index.getProjectMap();
      const system: ChatMessage = {
        role: "system",
        content: buildSystemPrompt({ ...base, projectMap }),
      };
      let budget = entry.contextWindow - RESERVE_TOKENS;

      for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
        if (signal.aborted) throw abortError();

        const messages = [system, ...pruneHistory(this.history, budget)];
        let result: ChatResult;
        try {
          result = await this.chatWithRetry(
            provider,
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
        } catch (e) {
          // Free pools are per-model: when one is exhausted after retries,
          // hop to the next free model and continue the same task.
          if (e instanceof RateLimitError && isFreeModel(entry) && !signal.aborted) {
            const fallback = models.find(
              (m) => isFreeModel(m) && m.supportsTools && !triedModels.has(m.id)
            );
            if (fallback) {
              triedModels.add(fallback.id);
              ({ provider, entry } = registry.resolve(fallback.id, models));
              budget = entry.contextWindow - RESERVE_TOKENS;
              ctx.emit({
                type: "status",
                text: `"${modelId}" pool is exhausted — switching to ${fallback.label} and continuing.`,
              });
              iteration--; // this hop doesn't consume a step
              continue;
            }
          }
          throw e;
        }

        if (result.usage) {
          const requestCostUsd = result.usage.costUsd;
          if (requestCostUsd !== null) this.sessionCostUsd += requestCostUsd;
          ctx.emit({
            type: "usage",
            requestCostUsd,
            sessionCostUsd: this.sessionCostUsd,
            promptTokens: result.usage.promptTokens,
            completionTokens: result.usage.completionTokens,
          });
        }

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

function isFreeModel(entry: ModelEntry): boolean {
  return entry.slug.endsWith(":free");
}

/** Cancellable sleep — resolves after ms, or rejects immediately if the signal aborts. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(abortError());
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(): Error {
  const e = new Error("aborted");
  e.name = "AbortError";
  return e;
}

function isAbort(e: unknown): boolean {
  return e instanceof Error && (e.name === "AbortError" || e.message.includes("aborted"));
}
