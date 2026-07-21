import type { ModelEntry } from "./types";

/**
 * User-declared providers (the `pixa.providers` setting).
 *
 * Deliberately mirrors OpenCode's provider config shape so it's familiar:
 * a map of provider id -> { baseUrl, models }. Any OpenAI-compatible endpoint
 * works — a cloud API, a company gateway, or a self-hosted server such as
 * Ollama, vLLM, LM Studio or llama.cpp.
 *
 * Pure module: no vscode, no IO, fully unit-testable.
 */

export interface UserModelConfig {
  /** Display name. Defaults to the model key itself. */
  name?: string;
  /** Token budget. Defaults to 128000. */
  contextWindow?: number;
  /** Set false for models that can't do tool calling (chat-only). Defaults to true. */
  supportsTools?: boolean;
}

export interface ProviderConfig {
  /** Display name shown next to models in the picker. Defaults to the provider id. */
  name?: string;
  /** OpenAI-compatible base URL, e.g. "http://localhost:11434/v1". */
  baseUrl: string;
  /**
   * Set false for local servers that need no credentials (Ollama, LM Studio).
   * Defaults to true, meaning Pixa asks for and sends an API key.
   */
  requiresApiKey?: boolean;
  /** Map of the provider's model name -> display metadata. */
  models: Record<string, UserModelConfig>;
}

export type ProvidersConfig = Record<string, ProviderConfig>;

const DEFAULT_CONTEXT_WINDOW = 128_000;
const COMPLETIONS_PATH = "/chat/completions";

/**
 * Normalize a user-supplied base URL to a chat-completions endpoint.
 * Accepts either the base ("…/v1") or the full endpoint, so users can paste
 * whichever their provider's docs show.
 */
export function chatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  return trimmed.endsWith(COMPLETIONS_PATH) ? trimmed : trimmed + COMPLETIONS_PATH;
}

/**
 * Flatten user provider config into model entries the registry understands.
 * Model ids are namespaced (`provider:model`) so two providers can expose the
 * same model name without colliding.
 *
 * Invalid providers are collected into `errors` instead of throwing — one bad
 * entry in user settings must not stop the whole extension from loading.
 */
export function providersToModels(cfg: ProvidersConfig): { models: ModelEntry[]; errors: string[] } {
  const models: ModelEntry[] = [];
  const errors: string[] = [];

  for (const [providerId, provider] of Object.entries(cfg ?? {})) {
    if (!provider || typeof provider.baseUrl !== "string" || !provider.baseUrl.trim()) {
      errors.push(`Provider "${providerId}" is missing a "baseUrl" — skipped.`);
      continue;
    }
    const modelKeys = Object.keys(provider.models ?? {});
    if (modelKeys.length === 0) {
      errors.push(`Provider "${providerId}" declares no "models" — skipped.`);
      continue;
    }

    const providerLabel = provider.name?.trim() || providerId;
    for (const modelKey of modelKeys) {
      const model = provider.models[modelKey] ?? {};
      models.push({
        id: `${providerId}:${modelKey}`,
        label: `${model.name?.trim() || modelKey} (${providerLabel})`,
        provider: providerId,
        slug: modelKey,
        contextWindow:
          typeof model.contextWindow === "number" && model.contextWindow > 0
            ? model.contextWindow
            : DEFAULT_CONTEXT_WINDOW,
        supportsTools: model.supportsTools !== false,
      });
    }
  }

  return { models, errors };
}
