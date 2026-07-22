import type { ChatMessage, ChatResult, ChatRequest, ModelProvider, StreamDelta, ModelEntry } from "../providers/types";
import { ProviderRegistry } from "../providers/registry";
import { RateLimitError } from "../providers/errors";
import { ToolRegistry } from "../tools/registry";
import type { ToolContext } from "../tools/types";
import { pruneHistory } from "./contextManager";
import { buildSystemPrompt, type WorkspaceInfo } from "./systemPrompt";
import { parsePlan } from "./planning";
import { groupIntoBatches, looksLikeUnparsedToolCall } from "./taskGraph";

const MAX_ITERATIONS = 30;
const RESERVE_TOKENS = 8000;
// OpenRouter's free-tier caps (20 req/min, 50/day) are GLOBAL PER ACCOUNT,
// not per model — so hopping to another free model cannot escape a per-minute
// cap. The right response (what Claude Code does) is to WAIT out the window on
// the same model. Hence: patient retries first, hop only as a last resort.
const MAX_RATE_LIMIT_RETRIES = 4;
const MAX_RETRY_WAIT_SECONDS = 60;
// Hopping only helps for genuine per-MODEL upstream congestion; keep it rare
// since it burns extra requests against the shared daily cap.
const MAX_FALLBACK_HOPS = 2;

export interface AgentLoopDeps {
  registry: ProviderRegistry;
  tools: ToolRegistry;
  models: ModelEntry[];
  ctx: ToolContext;
  workspaceInfo: () => Promise<Omit<WorkspaceInfo, "projectMap">>;
  /** Completion-token cap per request; keeps free/low-balance accounts under their limit. */
  maxTokens?: () => number;
  /**
   * Called after each tool-calling iteration so the host can persist progress
   * mid-task. Without it, a reload/crash during a long task loses every tool
   * result gathered so far.
   */
  onCheckpoint?: () => void;
}

/**
 * The agentic core: model ⇄ tools until the model answers without tool calls.
 * All progress is reported through ctx.emit; the UI owns rendering and approvals.
 */
export class AgentLoop {
  readonly history: ChatMessage[] = [];
  private sessionCostUsd = 0;
  /** Last free model that actually served a response — preferred fallback target. */
  private lastHealthyModelId: string | null = null;

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
        if (e instanceof RateLimitError && e.scope === "upstream" && attempt < MAX_RATE_LIMIT_RETRIES && !signal.aborted) {
          // Floor of 0 (not 1): real OpenRouter 429s always carry a positive
          // retry-after (defaulting to 30s), so 0 only occurs in tests, where
          // it means "retry immediately".
          const wait = Math.min(Math.max(Math.ceil(e.retryAfterSeconds), 0), MAX_RETRY_WAIT_SECONDS);
          this.deps.ctx.emit({
            type: "status",
            text: `Free-tier limit reached (20 req/min, shared across all free models) — waiting ${wait}s for the window to reset, then continuing (attempt ${attempt + 1}/${MAX_RATE_LIMIT_RETRIES}).`,
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
      let fallbackHops = 0;
      let notifiedModelChange = false;
      let planEmitted = false;
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
          // Account-wide free-tier quota: shared by ALL free models — hopping
          // would only burn more of it. Tell the user what actually helps.
          if (e instanceof RateLimitError && e.scope === "account") {
            ctx.emit({
              type: "error",
              message:
                "Your OpenRouter account's daily free-model quota is used up (shared across all free models — ~50/day under $10 lifetime top-up, 1000/day above). Options: switch to a paid model like GLM 5.2, top up to $10 total for the higher free cap, or wait for the daily reset.",
            });
            return;
          }
          // Per-model upstream pool exhausted: hop to the next free model and
          // continue the same task — but only a few times. Several
          // back-to-back hops all failing is a strong signal this is really
          // the account-wide cap and our classifier just didn't match its
          // wording; cycling the whole roster in that case only wastes time.
          if (e instanceof RateLimitError && isFreeModel(entry) && !signal.aborted && fallbackHops < MAX_FALLBACK_HOPS) {
            const failedLabel = entry.label;
            const candidates = models.filter((m) => isFreeModel(m) && m.supportsTools && !triedModels.has(m.id));
            // Prefer the model that last served a response this session — it
            // has proven free capacity, so we skip re-trying other congested
            // pools. Fall back to a random pick when there's no known-good one.
            const knownGood = candidates.find((m) => m.id === this.lastHealthyModelId);
            const fallback = knownGood ?? candidates[Math.floor(Math.random() * candidates.length)];
            if (fallback) {
              triedModels.add(fallback.id);
              fallbackHops++;
              ({ provider, entry } = registry.resolve(fallback.id, models));
              budget = entry.contextWindow - RESERVE_TOKENS;
              ctx.emit({
                type: "status",
                text: `"${failedLabel}" pool is exhausted — switching to ${fallback.label} and continuing.`,
              });
              iteration--; // this hop doesn't consume a step
              continue;
            }
          }
          if (e instanceof RateLimitError) {
            ctx.emit({
              type: "error",
              message: `${e.message}${
                fallbackHops >= MAX_FALLBACK_HOPS
                  ? ` (gave up after ${fallbackHops} free-model hops — this looks account-wide, not per-model; try a paid model like GLM 5.2)`
                  : ""
              }${e.raw ? `\nRaw provider response: ${e.raw.slice(0, 500)}` : ""}`,
            });
            return;
          }
          throw e;
        }

        // A response came back: this model has free capacity right now.
        if (isFreeModel(entry) && this.lastHealthyModelId !== entry.id) {
          this.lastHealthyModelId = entry.id;
        }
        // If we ended up on a different model than the user picked, move their
        // selection to the working one so the next message starts there and
        // doesn't repeat the whole hop dance.
        if (entry.id !== modelId && !notifiedModelChange) {
          notifiedModelChange = true;
          ctx.emit({ type: "active-model-changed", modelId: entry.id });
        }

        // Planning pre-pass: the system prompt asks the model to state a plan
        // before its first tool call, so the plan is already in this first
        // response — parse and surface it without a separate model call.
        if (!planEmitted) {
          planEmitted = true;
          const plan = parsePlan(result.content);
          if (plan.steps.length > 0) ctx.emit({ type: "plan", steps: plan.steps });
        }

        if (result.usage) {
          const requestCostUsd = result.usage.costUsd;
          if (requestCostUsd !== null) this.sessionCostUsd += requestCostUsd;
          ctx.emit({
            type: "usage",
            providerId: entry.provider,
            modelId: entry.id,
            modelLabel: entry.label,
            requestCostUsd,
            sessionCostUsd: this.sessionCostUsd,
            promptTokens: result.usage.promptTokens,
            completionTokens: result.usage.completionTokens,
          });
        }

        if (result.toolCalls.length === 0) {
          // The model tried to call a tool but wrote it as text — it can't do
          // real tool calling, so the agent would silently do nothing. Say why.
          if (entry.supportsTools && looksLikeUnparsedToolCall(result.content)) {
            ctx.emit({
              type: "error",
              message:
                `"${entry.label}" replied with a tool call written as plain text instead of a real one, ` +
                `so no action could be taken. This usually means the model is too small for agent work ` +
                `(models under ~7B often imitate the format without supporting it). ` +
                `Try a larger model for tasks, or set "supportsTools": false for this model to use it for chat only.`,
            });
            return;
          }
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

        // Independent read-only calls run concurrently; anything that mutates
        // state or has side effects runs alone, in order (see taskGraph.ts).
        for (const batch of groupIntoBatches(result.toolCalls)) {
          if (signal.aborted) throw abortError();

          for (const call of batch) {
            ctx.emit({
              type: "tool-start",
              callId: call.id,
              name: call.name,
              summary: summarizeArgs(call.arguments),
            });
          }

          // tools.run never rejects — it converts failures into result strings.
          const outputs = await Promise.all(batch.map((c) => tools.run(c.name, c.arguments, ctx)));

          // Results are recorded in call order so each pairs with its tool_call_id.
          batch.forEach((call, i) => {
            this.history.push({ role: "tool", content: outputs[i], toolCallId: call.id });
            ctx.emit({ type: "tool-end", callId: call.id, result: truncateForUi(outputs[i]) });
          });
          ctx.emit({
            type: "changeset-updated",
            files: ctx.changeSet.list().map((f) => ({ path: f.path, status: f.status })),
          });
        }

        // History is consistent here (assistant turn + all its tool results),
        // so it's the safe point to persist progress for a long-running task.
        this.deps.onCheckpoint?.();
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
    const interesting = args.path ?? args.command ?? args.regex ?? args.query ?? args.message ?? "";
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
