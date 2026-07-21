import * as vscode from "vscode";
import { execFile } from "node:child_process";
import type { Tool } from "./types";
import { resolveInWorkspace } from "./paths";
import { evaluateCommand } from "../security/sandbox";
import { redactSecrets } from "../security/redact";

const MAX_OUTPUT_CHARS = 8000;
const TIMEOUT_MS = 30_000;

function runShell(command: string, cwd: string): Promise<{ code: number; out: string }> {
    return new Promise((resolve) => {
        const isWin = process.platform === "win32";
        const shell = isWin ? "cmd.exe" : "/bin/sh";
        const args = isWin ? ["/d", "/s", "/c", command] : ["-c", command];

        execFile(
            shell,
            args,
            {
                cwd,
                timeout: TIMEOUT_MS,
                maxBuffer: 2 * 1024 * 1024,
                windowsHide: true,
            },
            (err, stdout, stderr) => {
                const execErr = err as (NodeJS.ErrnoException & {
                    signal?: NodeJS.Signals;
                }) | null;

                const rawCode: unknown = execErr?.code ?? 0;

                const timedOut = execErr?.signal === "SIGTERM";

                resolve({
                    code: typeof rawCode === "number" ? rawCode : 1,
                    out: timedOut
                        ? `(command timed out after ${TIMEOUT_MS / 1000}s and was killed)\n${stdout ?? ""}${stderr ?? ""}`
                        : `${stdout ?? ""}${stderr ?? ""}`,
                });
            }
        );
    });
}

const runCommand: Tool = {
    schema: {
        name: "run_command",
        description:
            "Run a shell command in the workspace. Read-only commands (git status, ls, npm test, etc.) run immediately; anything else requires user approval. A small set of known-destructive patterns (rm -rf, sudo, curl|sh, force-push to main, etc.) are always blocked, with no approval prompt at all.",
        parameters: {
            type: "object",
            properties: {
                command: {
                    type: "string",
                    description: "The shell command to run.",
                },
                cwd: {
                    type: "string",
                    description:
                        "Workspace-relative working directory. Defaults to the workspace root.",
                },
            },
            required: ["command"],
        },
    },

    async execute(args: { command: string; cwd?: string }, ctx) {
        if (!args?.command || typeof args.command !== "string" || !args.command.trim()) {
            return "Error: 'command' is required.";
        }

        // Workspace Trust
        if (!vscode.workspace.isTrusted) {
            return 'Error: this workspace is not trusted. Command execution is disabled until you trust the workspace (Command Palette → "Workspaces: Manage Workspace Trust").';
        }

        const policy = evaluateCommand(args.command);

        if (policy.verdict === "deny") {
            return `Error: command blocked by policy — ${policy.reason}`;
        }

        if (policy.verdict === "confirm") {
            const approved = await ctx.approvals.requestApproval(
                "command",
                args.command
            );

            if (!approved) {
                return "Command not approved by user.";
            }
        }

        let cwdAbs: string;

        try {
            cwdAbs = args.cwd
                ? resolveInWorkspace(ctx.workspaceRoot, args.cwd)
                : ctx.workspaceRoot;
        } catch (e) {
            return `Error: ${(e as Error).message}`;
        }

        const { code, out } = await runShell(args.command, cwdAbs);

        // Redact secrets from command output
        const redacted = redactSecrets(out);

        const capped =
            redacted.length > MAX_OUTPUT_CHARS
                ? redacted.slice(0, MAX_OUTPUT_CHARS) +
                "\n… (output truncated)"
                : redacted;

        return `exit code: ${code}\n${capped || "(no output)"}`;
    },
};

export const shellTools: Tool[] = [runCommand];