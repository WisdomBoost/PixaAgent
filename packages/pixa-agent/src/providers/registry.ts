import type { ModelEntry, ModelProvider } from "./types";

/** Parse and validate a models.json document. Throws with a precise message on malformed entries. */
export function loadModels(json: string): ModelEntry[] {
  const doc = JSON.parse(json) as { models?: unknown };
  if (!Array.isArray(doc.models)) {
    throw new Error("models.json: expected a top-level \"models\" array");
  }
  return doc.models.map((raw, i) => {
    const m = raw as Record<string, unknown>;
    for (const field of ["id", "label", "provider", "slug"] as const) {
      if (typeof m[field] !== "string" || m[field] === "") {
        throw new Error(`models.json: entry ${i} is missing string field "${field}"`);
      }
    }
    if (typeof m.contextWindow !== "number" || m.contextWindow <= 0) {
      throw new Error(`models.json: entry ${i} needs a positive "contextWindow"`);
    }
    if (typeof m.supportsTools !== "boolean") {
      throw new Error(`models.json: entry ${i} needs boolean "supportsTools"`);
    }
    // Optional — absent means "unknown/unsupported", same convention as
    // supportsTools defaulting via `!== false` elsewhere in this codebase,
    // except here the safe default is false-ish (undefined), not true.
    if (m.supportsReasoningEffort !== undefined && typeof m.supportsReasoningEffort !== "boolean") {
      throw new Error(`models.json: entry ${i} has invalid "supportsReasoningEffort" (must be boolean if present)`);
    }
    return {
      id: m.id as string,
      label: m.label as string,
      provider: m.provider as string,
      slug: m.slug as string,
      contextWindow: m.contextWindow,
      supportsTools: m.supportsTools,
      supportsReasoningEffort: typeof m.supportsReasoningEffort === "boolean" ? m.supportsReasoningEffort : undefined,
    };
  });
}

export class ProviderRegistry {
  private providers = new Map<string, ModelProvider>();

  register(provider: ModelProvider): void {
    this.providers.set(provider.id, provider);
  }

  resolve(modelId: string, models: ModelEntry[]): { provider: ModelProvider; entry: ModelEntry } {
    const entry = models.find((m) => m.id === modelId);
    if (!entry) {
      throw new Error(`Unknown model id "${modelId}" — check models.json`);
    }
    const provider = this.providers.get(entry.provider);
    if (!provider) {
      throw new Error(`No provider registered for "${entry.provider}" (required by model "${modelId}")`);
    }
    return { provider, entry };
  }
}