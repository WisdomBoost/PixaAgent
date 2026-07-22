import type { PlanStep } from "./planning";

/** Events emitted by the agent runtime; the chat webview renders these directly. */
export type AgentEvent =
  | { type: "plan"; steps: PlanStep[] }
  | { type: "assistant-delta"; text: string }
  | { type: "assistant-done" }
  | { type: "tool-start"; callId: string; name: string; summary: string }
  | { type: "tool-end"; callId: string; result: string }
  | { type: "changeset-updated"; files: { path: string; status: string }[] }
  | { type: "approval-request"; requestId: string; kind: "command" | "commit"; detail: string }
  | { type: "status"; text: string }
  | { type: "error"; message: string }
  | { type: "active-model-changed"; modelId: string }
  | {
      type: "usage";
      providerId: string;
      modelId: string;
      modelLabel: string;
      /** null when the provider didn't report a dollar cost for this request (e.g. some free models). */
      requestCostUsd: number | null;
      /** Running total for the current session, reset on New Session. */
      sessionCostUsd: number;
      promptTokens: number;
      completionTokens: number;
    };
