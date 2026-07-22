import { redactSecrets } from "./redact";
import * as vscode from "vscode";
export interface AuditLogEntry {
    timestamp: string;
    action: string;
    details?: Record<string, unknown>;
    outcome: "allow" | "deny" | "confirm" | "success" | "error";
}

export class SecurityLogger {
    private channel: vscode.OutputChannel | null = null;

    constructor(channelName = "Pixa Security Audit") {
        try {
            const vs = require("vscode");
            if (vs && vs.window) {
                this.channel = vs.window.createOutputChannel(channelName);
            }
        } catch {
            // Context outside VS Code extension host (e.g., unit tests)
            this.channel = null;
        }
    }

    log(action: string, outcome: AuditLogEntry["outcome"], details?: Record<string, unknown>): void {
        const timestamp = new Date().toISOString();

        // Sanitize string values in details to prevent secret leakage in audit logs
        const sanitizedDetails: Record<string, unknown> = {};
        if (details) {
            for (const [key, val] of Object.entries(details)) {
                if (typeof val === "string") {
                    sanitizedDetails[key] = redactSecrets(val);
                } else {
                    sanitizedDetails[key] = val;
                }
            }
        }

        const entry: AuditLogEntry = {
            timestamp,
            action: redactSecrets(action),
            outcome,
            ...(Object.keys(sanitizedDetails).length > 0 ? { details: sanitizedDetails } : {}),
        };

        const formatted = `[${entry.timestamp}] [${entry.outcome.toUpperCase()}] ${entry.action}${entry.details ? ` - ${JSON.stringify(entry.details)}` : ""
            }`;

        if (this.channel) {
            this.channel.appendLine(formatted);
        }
    }
}

export const securityLogger = new SecurityLogger();
