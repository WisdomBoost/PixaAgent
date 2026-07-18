import * as crypto from "node:crypto";
import { db } from "./db.js";

export interface UsageLogEntry {
  /** The caller's raw OpenRouter API key — hashed before storage, never persisted directly. */
  apiKey: string;
  /** Optional explicit org/user id from X-Pixa-Identity header. */
  identityLabel?: string | null;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  /** Null (not 0) means the provider didn't report cost. */
  estimatedCostUsd: number | null;
}

/**
 * One-way hash of the API key for grouping/counting usage per caller
 * without ever being able to reconstruct the original key from the log.
 * Truncated to 16 hex chars — plenty of entropy to avoid collisions,
 * while keeping log rows compact.
 */
export function hashApiKey(apiKey: string): string {
  return crypto.createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
}

/**
 * Record a completed chat request to SQLite.
 * Fire-and-forget: never throws, logs errors and moves on.
 * This way a DB hiccup never breaks the chat response the user already got.
 */
export function recordUsage(entry: UsageLogEntry): void {
  try {
    // Prepare statement lazily (after initDatabase() has been called)
    const insertStmt = db.prepare(`
      INSERT INTO usage (key_hash, identity_label, provider, model, prompt_tokens, completion_tokens, estimated_cost_usd)
      VALUES (@keyHash, @identityLabel, @provider, @model, @promptTokens, @completionTokens, @estimatedCostUsd)
    `);
    
    insertStmt.run({
      keyHash: hashApiKey(entry.apiKey),
      identityLabel: entry.identityLabel ?? null,
      provider: entry.provider,
      model: entry.model,
      promptTokens: entry.promptTokens,
      completionTokens: entry.completionTokens,
      estimatedCostUsd: entry.estimatedCostUsd,
    });
  } catch (err) {
    // Usage logging must never break the chat — log and move on.
    console.error("[USAGE_LOG] Insert failed:", err);
  }
}