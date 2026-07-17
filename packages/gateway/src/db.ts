import Database from "better-sqlite3";
import * as path from "node:path";
import * as fs from "node:fs";

/**
 * Usage logging database. Path is configurable via USAGE_DB_PATH so it can
 * be pointed at a persistent volume in production; defaults to a local
 * ./data/usage.db file for development.
 */
const DB_PATH = process.env.USAGE_DB_PATH || path.join(process.cwd(), "data", "usage.db");

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL"); // safe for a single-process server, avoids locking issues under concurrent requests

db.exec(`
  CREATE TABLE IF NOT EXISTS usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    -- Stands in for "org/user" identity. This is a stateless BYOK proxy with
    -- no account system, so the caller's API key is the only natural
    -- identity signal available. The RAW key is never stored — only a
    -- SHA-256 hash (see usageLogger.ts), which still lets you group/count
    -- requests per caller without being able to reconstruct their key.
    key_hash TEXT NOT NULL,
    -- Optional explicit identity (org or user id) if the caller sends one
    -- via the X-Pixa-Identity header. Null when not provided.
    identity_label TEXT,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    estimated_cost_usd REAL
  );

  CREATE INDEX IF NOT EXISTS idx_usage_key_hash ON usage(key_hash);
  CREATE INDEX IF NOT EXISTS idx_usage_timestamp ON usage(timestamp);
`);