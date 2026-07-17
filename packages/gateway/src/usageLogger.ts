import * as crypto from "node:crypto";
import { db } from "./db.js";

export interface UsageLogEntry {
  /** The caller's raw OpenRouter API key — hashed before it ever touches storage, never persisted directly. */
  apiKey: string;
  /** Optional explicit org/user id, if the caller sent one via X-Pixa-Identity. */
  identityLabel?: string | null;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  /** Null (not 0) means the upstream provider didn't report a cost for this request. */
  estimatedCostUsd: number | null;
}

/**
 * One-way hash of the API key for grouping/counting usage per caller
 * without ever being able to reconstruct the original key from the log.
 * Truncated to 16 hex chars — plenty of entropy to avoid collisions across
 * realistic caller counts, while keeping log rows compact.
 */
export function hashApiKey(apiKey: string): string {
  return crypto.createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
}

const insertStmt = db.prepare(`
  INSERT INTO usage (key_hash, identity_label, provider, model, prompt_tokens, completion_tokens, estimated_cost_usd)
  VALUES (@keyHash, @identityLabel, @provider, @model, @promptTokens, @completionTokens, @estimatedCostUsd)
`);

export function recordUsage(entry: UsageLogEntry): void {
  try {
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
    // Usage logging must never break the actual chat request — log and move on.
    console.error("Failed to record usage:", err);
  }
}