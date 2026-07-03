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
}

export interface StreamDelta {
  text?: string;
}

export interface ChatResult {
  content: string;
  toolCalls: ToolCall[];
  finishReason: string;
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
}
