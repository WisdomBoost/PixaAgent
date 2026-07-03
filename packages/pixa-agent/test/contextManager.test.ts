import { describe, it, expect } from "vitest";
import { estimateTokens, pruneHistory } from "../src/agent/contextManager";
import type { ChatMessage } from "../src/providers/types";

describe("estimateTokens", () => {
  it("estimates ceil(chars/4)", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });
});

function msg(role: ChatMessage["role"], content: string, extra?: Partial<ChatMessage>): ChatMessage {
  return { role, content, ...extra };
}

describe("pruneHistory", () => {
  it("returns messages unchanged when under budget", () => {
    const history = [msg("user", "hi"), msg("assistant", "hello")];
    expect(pruneHistory(history, 1000)).toEqual(history);
  });

  it("truncates oldest oversized tool results first", () => {
    const history = [
      msg("user", "task"),
      msg("assistant", "", { toolCalls: [{ id: "1", name: "read_file", arguments: "{}" }] }),
      msg("tool", "x".repeat(4000), { toolCallId: "1" }),
      msg("assistant", "done reading"),
      msg("user", "continue"),
    ];
    const pruned = pruneHistory(history, 500);
    const tool = pruned.find((m) => m.role === "tool")!;
    expect(tool.content).toBe("[result truncated]");
    // last user message always survives intact
    expect(pruned[pruned.length - 1].content).toBe("continue");
  });

  it("drops oldest turns when truncation is not enough", () => {
    const history = [
      msg("user", "a".repeat(2000)),
      msg("assistant", "b".repeat(2000)),
      msg("user", "c".repeat(2000)),
      msg("assistant", "d".repeat(2000)),
      msg("user", "final question"),
    ];
    const pruned = pruneHistory(history, 600);
    expect(pruned[pruned.length - 1].content).toBe("final question");
    expect(pruned.length).toBeLessThan(history.length);
    const total = pruned.reduce((n, m) => n + estimateTokens(m.content), 0);
    expect(total).toBeLessThanOrEqual(600);
  });

  it("always keeps the last user message even if alone", () => {
    const history = [msg("user", "old"), msg("assistant", "old reply"), msg("user", "x".repeat(10000))];
    const pruned = pruneHistory(history, 100);
    expect(pruned[pruned.length - 1].role).toBe("user");
    expect(pruned[pruned.length - 1].content).toContain("x");
  });
});
