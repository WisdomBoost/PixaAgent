import Database from "better-sqlite3";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

/**
 * Central SQLite database for usage logging and policy configuration.
 * Path is configurable via USAGE_DB_PATH for production/tests; defaults to
 * ~/.pixa/gateway.db for zero-config.
 */
const DB_PATH = process.env.USAGE_DB_PATH || path.join(os.homedir(), ".pixa", "gateway.db");

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

/**
 * Initialize all tables. Safe to run on every startup — CREATE TABLE IF NOT EXISTS
 * means idempotent operations.
 */
export function initDatabase(): void {
  db.exec(`
    -- Phase 4: Usage logging
    CREATE TABLE IF NOT EXISTS usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      -- SHA-256 hash of the caller's OpenRouter API key (first 16 hex chars).
      -- Never store the raw key. Groups requests by caller without revealing their key.
      key_hash TEXT NOT NULL,
      -- Optional explicit identity (org/team name) if caller sent X-Pixa-Identity header.
      identity_label TEXT,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      estimated_cost_usd REAL
    );
    CREATE INDEX IF NOT EXISTS idx_usage_key_hash ON usage(key_hash);
    CREATE INDEX IF NOT EXISTS idx_usage_identity ON usage(identity_label);
    CREATE INDEX IF NOT EXISTS idx_usage_timestamp ON usage(timestamp);

    -- Phase 5: Organization/identity management
    CREATE TABLE IF NOT EXISTS identities (
      id TEXT PRIMARY KEY,
      -- Display name (e.g., "Acme Corp", "my-team")
      name TEXT NOT NULL,
      -- When the identity was created
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      -- Metadata (JSON blob for future expansion)
      metadata TEXT
    );

    -- Phase 5: Per-identity model allowlist/blocklist
    -- Default behavior: if no rows exist for an identity, all models are allowed (default-allow).
    -- If rows exist, only allowed=1 rows are permitted; allowed=0 rows are blocked.
    CREATE TABLE IF NOT EXISTS identity_model_policy (
      identity_id TEXT NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
      model TEXT NOT NULL,
      -- 1 = allowed, 0 = blocked
      allowed INTEGER NOT NULL,
      PRIMARY KEY (identity_id, model)
    );
    CREATE INDEX IF NOT EXISTS idx_policy_identity ON identity_model_policy(identity_id);

    -- Phase 5: Organization usage totals (computed/cached periodically, optional optimization)
    CREATE TABLE IF NOT EXISTS identity_usage_summary (
      identity_id TEXT PRIMARY KEY REFERENCES identities(id) ON DELETE CASCADE,
      -- Last time we computed this summary
      last_computed TEXT NOT NULL DEFAULT (datetime('now')),
      total_requests INTEGER NOT NULL DEFAULT 0,
      total_prompt_tokens INTEGER NOT NULL DEFAULT 0,
      total_completion_tokens INTEGER NOT NULL DEFAULT 0,
      total_cost_usd REAL NOT NULL DEFAULT 0
    );
  `);
}