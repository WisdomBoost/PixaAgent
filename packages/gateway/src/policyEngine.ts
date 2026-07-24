import { db } from "./db.js";

/**
 * Check if a model is allowed for an identity.
 *
 * Default behavior (default-allow): if no policy rows exist for the identity,
 * all models are permitted.
 *
 * Once policy rows exist for an identity:
 * - allowed=1 rows are permitted
 * - allowed=0 rows are blocked
 * - any model NOT explicitly listed is blocked (default-deny)
 *
 * @param identityId The identity to check (org/team name from X-Pixa-Identity header)
 * @param model The model slug being requested (e.g., "openai/gpt-4-turbo")
 * @returns { allowed: boolean; reason?: string }
 */
export function checkModelPolicy(
  identityId: string | null,
  model: string
): { allowed: boolean; reason?: string } {
  // No identity provided — no policy to check.
  if (!identityId) {
    return { allowed: true };
  }

  // Check if this identity exists
  const identity = db
    .prepare("SELECT id FROM identities WHERE id = ?")
    .get(identityId) as { id: string } | undefined;

  if (!identity) {
    // Unknown identity — reject to prevent unauthorized use
    return {
      allowed: false,
      reason: `Unknown identity "${identityId}". Contact your admin to set up policies.`,
    };
  }

  // Query the policy table for this identity and model
  const policy = db
    .prepare(
      "SELECT allowed FROM identity_model_policy WHERE identity_id = ? AND model = ?"
    )
    .get(identityId, model) as { allowed: number } | undefined;

  if (policy) {
    // Explicit policy exists
    if (policy.allowed === 1) {
      return { allowed: true };
    } else {
      return {
        allowed: false,
        reason: `Model "${model}" is blocked for identity "${identityId}". Contact your admin if you think this is a mistake.`,
      };
    }
  }

  // No explicit policy for this model.
  // Check if ANY policies exist for this identity.
  const hasPolicies = db
    .prepare("SELECT 1 FROM identity_model_policy WHERE identity_id = ? LIMIT 1")
    .get(identityId) as { 1: number } | undefined;

  if (hasPolicies) {
    // Policies exist but this model isn't listed — default-deny.
    return {
      allowed: false,
      reason: `Model "${model}" is not in the allowlist for identity "${identityId}". Contact your admin to request access.`,
    };
  }

  // No policies at all for this identity — default-allow.
  return { allowed: true };
}

/**
 * Get the list of allowed models for an identity (empty list = default-allow).
 */
export function getAllowedModelsForIdentity(identityId: string): string[] {
  const rows = db
    .prepare(
      "SELECT model FROM identity_model_policy WHERE identity_id = ? AND allowed = 1 ORDER BY model"
    )
    .all(identityId) as { model: string }[];
  return rows.map((r) => r.model);
}

/**
 * Get the list of blocked models for an identity (empty list = no explicit blocks).
 */
export function getBlockedModelsForIdentity(identityId: string): string[] {
  const rows = db
    .prepare(
      "SELECT model FROM identity_model_policy WHERE identity_id = ? AND allowed = 0 ORDER BY model"
    )
    .all(identityId) as { model: string }[];
  return rows.map((r) => r.model);
}