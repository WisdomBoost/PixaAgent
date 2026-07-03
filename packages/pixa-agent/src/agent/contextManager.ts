import type { ChatMessage } from "../providers/types";

/** Cheap token estimate: ~4 chars per token. */
export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

function historyTokens(messages: ChatMessage[]): number {
  return messages.reduce((n, m) => n + estimateTokens(m.content) + 8, 0);
}

const TRUNCATED = "[result truncated]";

/**
 * Fit history into a token budget. Strategy, in order:
 * 1. Replace oldest large tool results with a truncation marker.
 * 2. Drop oldest messages entirely (keeping tool-call pairing intact by
 *    dropping from the front), never dropping the final user message.
 */
export function pruneHistory(messages: ChatMessage[], budgetTokens: number): ChatMessage[] {
  if (historyTokens(messages) <= budgetTokens) return messages;

  const result = messages.map((m) => ({ ...m }));
  const lastUserIdx = findLastUserIndex(result);

  // Pass 1: truncate oldest tool results.
  for (let i = 0; i < result.length && historyTokens(result) > budgetTokens; i++) {
    const m = result[i];
    if (m.role === "tool" && m.content.length > TRUNCATED.length) {
      m.content = TRUNCATED;
    }
  }
  if (historyTokens(result) <= budgetTokens) return result;

  // Pass 2: drop oldest messages, preserving everything from the last user message on.
  let start = 0;
  while (start < lastUserIdx && historyTokens(result.slice(start)) > budgetTokens) {
    start++;
  }
  return result.slice(start);
}

function findLastUserIndex(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return i;
  }
  return messages.length - 1;
}
