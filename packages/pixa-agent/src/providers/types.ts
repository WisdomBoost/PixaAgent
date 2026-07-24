/**
 * Provider-agnostic model layer. Nothing outside src/providers may reference a
 * concrete provider — the agent and UI work only with these types.
 */

export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON string as produced by the model. */
  arguments: string;
}

export interface ChatMessage {
  role: Role;
  content: string;
  /** Present on assistant messages that request tool execution. */
  toolCalls?: ToolCall[];
  /** Present on tool-result messages; matches the originating ToolCall.id. */
  toolCallId?: string;
}

/** JSON-Schema-described tool exposed to the model. */
export interface ToolSchema {
  name: string;
  description: string;
  parameters: object;
}

/** Thinking-effort setting some providers accept. See models.json's supportsReasoningEffort. */
export type ReasoningEffort = "low" | "medium" | "high";

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools: ToolSchema[];
  temperature?: number;
  /**
   * Cap on completion tokens. Important on OpenRouter: without it the provider
   * reserves the model's full max completion length, which a low/zero balance
   * cannot afford (HTTP 402).
   */
  maxTokens?: number;
  /**
   * Only meaningful when the target model declares supportsReasoningEffort.
   * Callers (AgentLoop) are responsible for omitting this when the resolved
   * ModelEntry doesn't support it — providers forward whatever they're given.
   */
  reasoningEffort?: ReasoningEffort;
}

export interface StreamDelta {
  text?: string;
}

/** Token/cost accounting for one request. costUsd is the provider's actual billed amount when available. */
export interface UsageInfo {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number | null;
}

export interface ChatResult {
  content: string;
  toolCalls: ToolCall[];
  finishReason: string;
  usage?: UsageInfo | null;
}

export interface ModelProvider {
  /** Stable id referenced by models.json entries (e.g. "openrouter"). */
  id: string;
  chat(
    req: ChatRequest,
    onDelta: (d: StreamDelta) => void,
    signal: AbortSignal
  ): Promise<ChatResult>;
}

/** One entry of the data-driven model registry (models.json). */
export interface ModelEntry {
  id: string;
  label: string;
  provider: string;
  slug: string;
  contextWindow: number;
  supportsTools: boolean;
  /**
   * Whether this model/provider combination forwards a reasoning-effort
   * setting on OpenRouter. Capability flag only — never send reasoning_effort
   * to a model that doesn't declare this, since some OpenAI-compatible
   * servers reject unknown fields outright.
   */
  supportsReasoningEffort?: boolean;
}