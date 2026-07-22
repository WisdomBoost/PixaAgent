import { exec } from "node:child_process";
import type { Tool } from "./types";
import { resolveInWorkspace } from "./paths";
import { evaluateCommand } from "../security/sandbox";

const OUTPUT_CAP = 8000;

export function runShell(
  command: string,
  cwd: string
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    exec(
      command,
      { cwd, timeout: 120_000, maxBuffer: 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as any).code === "number" ? (err as any).code : 1) : 0;
        resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
      }
    );
  });
}

export function formatShellResult(r: { code: number; stdout: string; stderr: string }): string {
  const cap = (s: string) => (s.length > OUTPUT_CAP ? s.slice(0, OUTPUT_CAP) + "\n… (output truncated)" : s);
  let out = `exit code: ${r.code}`;
  if (r.stdout.trim()) out += `\nstdout:\n${cap(r.stdout)}`;
  if (r.stderr.trim()) out += `\nstderr:\n${cap(r.stderr)}`;
  return out;
}

const runCommand: Tool = {
  schema: {
    name: "run_command",
    description:
      "Run a shell command in the workspace (e.g. install dependencies, run tests or builds). THE USER MUST APPROVE every command before it runs — explain why you need it in your message first. Returns exit code and output.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to run" },
        cwd: { type: "string", description: "Workspace-relative working directory (default workspace root)" },
      },
      required: ["command"],
    },
  },
  async execute(args: { command: string; cwd?: string }, ctx) {
    const cwd = args.cwd ? resolveInWorkspace(ctx.workspaceRoot, args.cwd) : ctx.workspaceRoot;
    // Sandbox policy first: a known-destructive command is hard-blocked before
    // the user is even asked, so it can't be run by an over-eager Approve click.
    // Every non-denied command still goes through the normal approval flow —
    // the policy only ever *removes* the option to run, never adds an auto-run.
    const verdict = evaluateCommand(args.command);
    if (verdict.verdict === "deny") {
      return `Command blocked by Pixa's safety policy: ${verdict.reason} It was not run. Suggest a safer alternative.`;
    }
    const approved = await ctx.approvals.requestApproval("command", args.command);
    if (!approved) return "User declined to run this command. Ask before trying an alternative.";
    const result = await runShell(args.command, cwd);
    return formatShellResult(result);
  },
};

export const terminalTools: Tool[] = [runCommand];
