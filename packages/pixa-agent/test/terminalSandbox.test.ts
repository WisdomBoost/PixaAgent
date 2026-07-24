import { describe, it, expect } from "vitest";
import { terminalTools } from "../src/tools/terminal";
import type { ToolContext } from "../src/tools/types";

/**
 * Proves the sandbox policy is actually wired into the registered run_command
 * tool — not just that evaluateCommand works in isolation (sandbox.test.ts
 * covers that). This is the integration that was previously missing: the
 * policy module existed but nothing called it on the live command path.
 */

const runCommand = terminalTools[0];

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workspaceRoot: process.cwd(),
    approvals: { requestApproval: async () => true },
    // Unused by run_command, present to satisfy the type.
    changeSet: {} as any,
    index: {} as any,
    readWorkspaceFile: async () => null,
    emit: () => {},
    ...overrides,
  };
}

describe("run_command sandbox wiring", () => {
  it("hard-blocks a denied command and never asks for approval", async () => {
    let approvalAsked = false;
    const result = await runCommand.execute(
      { command: "rm -rf /" },
      ctx({ approvals: { requestApproval: async () => (approvalAsked = true) } })
    );
    expect(result).toMatch(/blocked by Pixa's safety policy/i);
    expect(approvalAsked).toBe(false); // must not even prompt for a denied command
  });

  it("still requires approval for a non-denied command (no auto-run)", async () => {
    let approvalAsked = false;
    const result = await runCommand.execute(
      { command: "git status" }, // an "allow" verdict in the policy
      ctx({
        approvals: {
          requestApproval: async () => {
            approvalAsked = true;
            return false; // user declines
          },
        },
      })
    );
    // The policy never upgrades a command to auto-run: approval was still asked,
    // and because the user declined, nothing executed.
    expect(approvalAsked).toBe(true);
    expect(result).toMatch(/declined/i);
  });
});
