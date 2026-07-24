/**
 * Command execution policy — Phase 1 sandboxing.
 *
 * Deliberately a pure module (no vscode, no IO) so it's fully unit-testable
 * and reusable outside the extension host if needed. Classifies a raw shell
 * command string into one of three verdicts:
 *
 *   - "deny"    matches a known-destructive pattern — never executed, no
 *               approval prompt shown at all.
 *   - "allow"   matches a known-safe, read-only/informational pattern —
 *               runs without asking.
 *   - "confirm" anything else — falls through to the existing human
 *               approval flow (ctx.approvals.requestApproval).
 *
 * This is regex-based classification, not a real shell parser. It catches
 * known-bad patterns and obvious safe commands; it does not guarantee
 * detection of deliberately obfuscated destructive commands (e.g. base64
 * payloads piped through eval). Treat it as a guardrail against careless or
 * accidental destruction, not a hard security boundary against an
 * adversarial model.
 */

export type CommandVerdict = "allow" | "deny" | "confirm";

export interface PolicyResult {
    verdict: CommandVerdict;
    reason: string;
    matchedRule?: string;
}

/**
 * Read-only / informational commands considered safe enough to run without
 * asking every time. Checked only AFTER the deny list, so a deny pattern
 * always wins if a command somehow matches both lists.
 */
const SAFE_PREFIXES: { name: string; regex: RegExp }[] = [
    { name: "git-readonly", regex: /^git\s+(status|log|diff|show|branch|remote(\s+-v)?|blame)\b/i },
    { name: "fs-readonly", regex: /^(ls|dir|pwd|cat|head|tail|wc|find|grep|rg)\b/i },
    { name: "npm-readonly", regex: /^npm\s+(test|run\s+test\b|list|ls|outdated|view)\b/i },
    { name: "version-probe", regex: /^(node|python3?|npm|git)\s+(--version|-v)$/i },
    { name: "echo", regex: /^echo\b/i },
];

/**
 * High-confidence destructive or workspace-escaping patterns. Auto-denied —
 * no approval prompt, no execution, ever.
 */
const DENY_PATTERNS: { name: string; regex: RegExp }[] = [
    { name: "rm-rf-root-or-wide", regex: /\brm\s+(-\w*r\w*f\w*|-\w*f\w*r\w*)\s+(\/|~|\*|\.\.(\/|$))/i },
    { name: "recursive-delete-wide", regex: /\b(rmdir|rd)\s+\/s\b/i },
    { name: "fork-bomb", regex: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/ },
    { name: "pipe-remote-to-shell", regex: /\b(curl|wget)\b[^\n]*\|\s*(sh|bash|zsh|powershell|pwsh)\b/i },
    { name: "sudo-privilege-escalation", regex: /\bsudo\b/i },
    { name: "disk-overwrite", regex: /\bdd\s+if=/i },
    { name: "filesystem-format", regex: /\bmkfs(\.\w+)?\b/i },
    { name: "system-power", regex: /\b(shutdown|reboot|halt|poweroff)\b/i },
    { name: "chmod-world-writable", regex: /\bchmod\s+(-R\s+)?0?777\b/i },
    { name: "overwrite-shell-profile", regex: />\s*(~\/\.(bash|zsh)?(rc|_profile|profile)|\/etc\/)/i },
    { name: "windows-format", regex: /\bformat\s+[a-z]:/i },
    { name: "windows-del-wide", regex: /\bdel\s+\/[sf]\b.*\*/i },
    { name: "git-force-push-protected", regex: /\bgit\s+push\b(?=.*\b(main|master)\b)(?=.*(?:--force(?:-with-lease)?|-f)\b)/i, },
    { name: "env-exfiltration", regex: /\benv\b\s*\|\s*(curl|wget|nc)\b/i },
];

import { securityLogger } from "./audit";

export function evaluateCommand(command: string): PolicyResult {
    const trimmed = command.trim();

    if (!trimmed) {
        const result: PolicyResult = { verdict: "deny", reason: "Empty command." };
        securityLogger.log("evaluateCommand", result.verdict, { command: trimmed, reason: result.reason });
        return result;
    }

    for (const { name, regex } of DENY_PATTERNS) {
        if (regex.test(trimmed)) {
            const result: PolicyResult = {
                verdict: "deny",
                reason: `Blocked: matches a known-destructive pattern ("${name}").`,
                matchedRule: name,
            };
            securityLogger.log("evaluateCommand", result.verdict, { command: trimmed, reason: result.reason, rule: name });
            return result;
        }
    }

    for (const { name, regex } of SAFE_PREFIXES) {
        if (regex.test(trimmed)) {
            const result: PolicyResult = {
                verdict: "allow",
                reason: "Read-only/informational command — auto-allowed.",
                matchedRule: name,
            };
            securityLogger.log("evaluateCommand", result.verdict, { command: trimmed, reason: result.reason, rule: name });
            return result;
        }
    }

    const result: PolicyResult = { verdict: "confirm", reason: "Not on the safe list — requires user approval." };
    securityLogger.log("evaluateCommand", result.verdict, { command: trimmed, reason: result.reason });
    return result;
}