import { Router, type Request, type Response } from "express";
import { db } from "../db.js";
import {
  checkModelPolicy,
  getAllowedModelsForIdentity,
  getBlockedModelsForIdentity,
} from "../policyEngine.js";
import { getOrGenerateAdminKey } from "../adminKey.js";

const router = Router();

/**
 * All admin endpoints require a simple API key check.
 * Checks for a dynamically generated key in ~/.pixa/admin.key.
 *
 * Clients must send: Authorization: Bearer <ADMIN_API_KEY>
 */
function requireAdminAuth(req: Request, res: Response, next: () => void): void {
  const auth = req.header("authorization") ?? "";
  const adminKey = getOrGenerateAdminKey();
  const expected = `Bearer ${adminKey}`;

  if (auth !== expected) {
    res.status(401).json({ error: "Invalid or missing admin API key." });
    return;
  }

  next();
}

router.use(requireAdminAuth);

/* ============ Identities (Orgs/Teams) ============ */

/**
 * GET /admin/identities
 * List all identities (organizations/teams).
 */
router.get("/identities", (_req: Request, res: Response) => {
  const rows = db
    .prepare(
      `
    SELECT id, name, created_at, metadata
    FROM identities
    ORDER BY created_at DESC
  `
    )
    .all() as any[];
  res.json(rows);
});

/**
 * POST /admin/identities
 * Create a new identity (organization/team).
 *
 * Body: { id: string, name: string, metadata?: object }
 */
router.post("/identities", (req: Request, res: Response) => {
  const { id, name, metadata } = req.body;

  if (!id || !name) {
    res.status(400).json({ error: "Missing required fields: id, name" });
    return;
  }

  try {
    db.prepare(
      "INSERT INTO identities (id, name, metadata) VALUES (?, ?, ?)"
    ).run(id, name, metadata ? JSON.stringify(metadata) : null);

    res.status(201).json({ id, name, created_at: new Date().toISOString() });
  } catch (err: any) {
    if (err.message.includes("UNIQUE constraint failed")) {
      res.status(409).json({ error: `Identity "${id}" already exists.` });
    } else {
      res.status(500).json({ error: (err as Error).message });
    }
  }
});

/**
 * DELETE /admin/identities/:id
 * Delete an identity and all its policies.
 */
router.delete("/identities/:id", (req: Request, res: Response) => {
  const { id } = req.params;

  try {
    db.prepare("DELETE FROM identities WHERE id = ?").run(id);
    res.json({ deleted: id });
  } catch (err: any) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/* ============ Model Policies ============ */

/**
 * GET /admin/identities/:id/policy
 * Get the model allow/blocklist for an identity.
 *
 * Returns: { allowed: string[], blocked: string[] }
 */
router.get("/identities/:id/policy", (req: Request, res: Response) => {
  const { id } = req.params;

  const identity = db
    .prepare("SELECT id FROM identities WHERE id = ?")
    .get(id) as { id: string } | undefined;

  if (!identity) {
    res.status(404).json({ error: `Identity "${id}" not found.` });
    return;
  }

  const allowed = getAllowedModelsForIdentity(id as string);
  const blocked = getBlockedModelsForIdentity(id as string);

  res.json({
    identity_id: id,
    allowed,
    blocked,
    default_behavior: allowed.length === 0 && blocked.length === 0 ? "allow-all" : "deny-unlisted",
  });
});

/**
 * PUT /admin/identities/:id/policy
 * Set the entire model allow/blocklist for an identity (replace operation).
 *
 * Body: {
 *   allowed?: string[],
 *   blocked?: string[]
 * }
 *
 * If both are empty, no policies are set (default-allow all models).
 */
router.put("/identities/:id/policy", (req: Request, res: Response) => {
  const { id } = req.params;
  const { allowed = [], blocked = [] } = req.body;

  const identity = db
    .prepare("SELECT id FROM identities WHERE id = ?")
    .get(id) as { id: string } | undefined;

  if (!identity) {
    res.status(404).json({ error: `Identity "${id}" not found.` });
    return;
  }

  try {
    // Clear existing policies
    db.prepare("DELETE FROM identity_model_policy WHERE identity_id = ?").run(id);

    // Insert new policies
    const insertStmt = db.prepare(
      "INSERT INTO identity_model_policy (identity_id, model, allowed) VALUES (?, ?, ?)"
    );

    for (const model of allowed) {
      insertStmt.run(id, model, 1);
    }
    for (const model of blocked) {
      insertStmt.run(id, model, 0);
    }

    res.json({
      identity_id: id,
      allowed,
      blocked,
      message: "Policy updated.",
    });
  } catch (err: any) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * POST /admin/identities/:id/policy/allow
 * Add a model to the allowlist (or do nothing if already there).
 *
 * Body: { model: string }
 */
router.post("/identities/:id/policy/allow", (req: Request, res: Response) => {
  const { id } = req.params;
  const { model } = req.body;

  if (!model) {
    res.status(400).json({ error: "Missing required field: model" });
    return;
  }

  const identity = db
    .prepare("SELECT id FROM identities WHERE id = ?")
    .get(id) as { id: string } | undefined;

  if (!identity) {
    res.status(404).json({ error: `Identity "${id}" not found.` });
    return;
  }

  try {
    // Remove from blocklist if present
    db.prepare("DELETE FROM identity_model_policy WHERE identity_id = ? AND model = ? AND allowed = 0").run(
      id,
      model
    );

    // Add to allowlist (ignore if already there)
    db.prepare("INSERT OR IGNORE INTO identity_model_policy (identity_id, model, allowed) VALUES (?, ?, ?)").run(
      id,
      model,
      1
    );

    res.json({ identity_id: id, model, action: "allowed" });
  } catch (err: any) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * POST /admin/identities/:id/policy/block
 * Add a model to the blocklist.
 *
 * Body: { model: string }
 */
router.post("/identities/:id/policy/block", (req: Request, res: Response) => {
  const { id } = req.params;
  const { model } = req.body;

  if (!model) {
    res.status(400).json({ error: "Missing required field: model" });
    return;
  }

  const identity = db
    .prepare("SELECT id FROM identities WHERE id = ?")
    .get(id) as { id: string } | undefined;

  if (!identity) {
    res.status(404).json({ error: `Identity "${id}" not found.` });
    return;
  }

  try {
    // Remove from allowlist if present
    db.prepare("DELETE FROM identity_model_policy WHERE identity_id = ? AND model = ? AND allowed = 1").run(
      id,
      model
    );

    // Add to blocklist (ignore if already there)
    db.prepare("INSERT OR IGNORE INTO identity_model_policy (identity_id, model, allowed) VALUES (?, ?, ?)").run(
      id,
      model,
      0
    );

    res.json({ identity_id: id, model, action: "blocked" });
  } catch (err: any) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * POST /admin/check-policy
 * Test a policy check without making a real chat request.
 *
 * Body: { identity_id: string | null, model: string }
 * Returns: { allowed: boolean, reason?: string }
 */
router.post("/check-policy", (req: Request, res: Response) => {
  const { identity_id, model } = req.body;

  if (!model) {
    res.status(400).json({ error: "Missing required field: model" });
    return;
  }

  const result = checkModelPolicy(identity_id || null, model);
  res.json(result);
});

/* ============ Usage Analytics ============ */

/**
 * GET /admin/usage
 * Query usage logs with optional filters.
 *
 * Query params:
 *   - identity_label: filter by identity
 *   - from: ISO timestamp (default: 24h ago)
 *   - to: ISO timestamp (default: now)
 *   - limit: max rows (default: 1000)
 */
router.get("/usage", (req: Request, res: Response) => {
  const { identity_label, from, to, limit = "1000" } = req.query;

  const now = new Date();
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const fromTime = from ? new Date(from as string).toISOString() : oneDayAgo.toISOString();
  const toTime = to ? new Date(to as string).toISOString() : now.toISOString();
  const maxRows = Math.min(Number(limit) || 1000, 10000);

  let query = "SELECT * FROM usage WHERE timestamp BETWEEN ? AND ?";
  const params: any[] = [fromTime, toTime];

  if (identity_label) {
    query += " AND identity_label = ?";
    params.push(identity_label as string);
  }

  query += " ORDER BY timestamp DESC LIMIT ?";
  params.push(maxRows);

  const rows = db.prepare(query).all(...params);
  res.json(rows);
});

/**
 * GET /admin/usage/summary
 * Aggregate usage statistics.
 *
 * Query params: same as /usage
 * Returns: { total_requests, total_prompt_tokens, total_completion_tokens, total_cost_usd, by_identity: {...}, by_model: {...} }
 */
router.get("/usage/summary", (req: Request, res: Response) => {
  const { identity_label, from, to } = req.query;

  const now = new Date();
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const fromTime = from ? new Date(from as string).toISOString() : oneDayAgo.toISOString();
  const toTime = to ? new Date(to as string).toISOString() : now.toISOString();

  let whereClause = "WHERE timestamp BETWEEN ? AND ?";
  const params: any[] = [fromTime, toTime];

  if (identity_label) {
    whereClause += " AND identity_label = ?";
    params.push(identity_label as string);
  }

  // Total summary
  const totals = db
    .prepare(
      `
    SELECT
      COUNT(*) as total_requests,
      SUM(prompt_tokens) as total_prompt_tokens,
      SUM(completion_tokens) as total_completion_tokens,
      SUM(estimated_cost_usd) as total_cost_usd
    FROM usage
    ${whereClause}
  `
    )
    .get(...params) as any;

  // By identity
  const byIdentity = db
    .prepare(
      `
    SELECT
      identity_label,
      COUNT(*) as requests,
      SUM(prompt_tokens) as prompt_tokens,
      SUM(completion_tokens) as completion_tokens,
      SUM(estimated_cost_usd) as cost_usd
    FROM usage
    ${whereClause}
    GROUP BY identity_label
    ORDER BY cost_usd DESC
  `
    )
    .all(...params) as any[];

  // By model
  const byModel = db
    .prepare(
      `
    SELECT
      model,
      COUNT(*) as requests,
      SUM(prompt_tokens) as prompt_tokens,
      SUM(completion_tokens) as completion_tokens,
      SUM(estimated_cost_usd) as cost_usd
    FROM usage
    ${whereClause}
    GROUP BY model
    ORDER BY cost_usd DESC
  `
    )
    .all(...params) as any[];

  res.json({
    time_range: { from: fromTime, to: toTime },
    totals,
    by_identity: byIdentity,
    by_model: byModel,
  });
});

export default router;