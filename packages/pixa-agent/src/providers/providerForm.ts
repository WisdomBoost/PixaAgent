import type { ProviderConfig, UserModelConfig } from "./config";

/**
 * Pure logic backing the in-panel "Add provider" form — see
 * docs/superpowers/specs/2026-07-22-provider-management-ui-design.md.
 * No vscode, no network: the host (chatViewProvider.ts) does IO and calls in here.
 */

export interface ProviderFormModel {
  id: string;
  name?: string;
}

export interface ProviderFormInput {
  id: string;
  name: string;
  baseUrl: string;
  requiresApiKey: boolean;
  models: ProviderFormModel[];
}

export interface ProviderFormErrors {
  id?: string;
  baseUrl?: string;
  models?: string;
}

export type ProviderFormResult =
  | { ok: true; config: ProviderConfig }
  | { ok: false; errors: ProviderFormErrors };

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

// "openrouter" and "local-embeddings" are built-in ModelProvider ids
// registered directly in extension.ts, outside pixa.providers. ProviderRegistry
// keys providers by id in a plain Map, so a pixa.providers entry reusing
// either id would silently replace the built-in provider on activation.
const RESERVED_IDS = new Set(["openrouter", "local-embeddings"]);

/** Validate and shape a provider-form submission. Never throws. */
export function validateProviderForm(form: ProviderFormInput, existingIds: string[]): ProviderFormResult {
  const errors: ProviderFormErrors = {};

  const id = form.id.trim();
  if (!id) {
    errors.id = "Provider id is required.";
  } else if (!ID_PATTERN.test(id)) {
    errors.id = "Use lowercase letters, numbers, hyphens, or underscores, starting with a letter or number.";
  } else if (RESERVED_IDS.has(id)) {
    errors.id = `"${id}" is reserved for a built-in provider — pick a different id.`;
  } else if (existingIds.includes(id)) {
    errors.id = `A provider named "${id}" already exists — delete it first or pick a different id.`;
  }

  const baseUrl = form.baseUrl.trim();
  if (!baseUrl) {
    errors.baseUrl = "Base URL is required.";
  } else if (!isParseableUrl(baseUrl)) {
    errors.baseUrl = "Not a valid URL.";
  }

  const models = form.models.filter((m) => m.id.trim());
  if (models.length === 0) {
    errors.models = "Add at least one model.";
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  return { ok: true, config: formToProviderConfig({ ...form, id, baseUrl, models }) };
}

function isParseableUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/** Map validated form state to the ProviderConfig shape `pixa.providers` expects. */
export function formToProviderConfig(form: ProviderFormInput): ProviderConfig {
  const models: Record<string, UserModelConfig> = {};
  for (const m of form.models) {
    const key = m.id.trim();
    if (!key) continue;
    models[key] = m.name?.trim() ? { name: m.name.trim() } : {};
  }
  return {
    name: form.name.trim() || form.id.trim(),
    baseUrl: form.baseUrl.trim(),
    requiresApiKey: form.requiresApiKey,
    models,
  };
}

/**
 * Parse a /models response into a flat list of model ids. Accepts the OpenAI
 * shape ({"data":[{"id":...}]}) and a bare array of ids or objects; tolerates
 * anything else by returning an empty list rather than throwing, since the
 * caller falls back to manual entry either way.
 */
export function parseModelsResponse(json: unknown): string[] {
  const data = Array.isArray(json)
    ? json
    : json && typeof json === "object" && Array.isArray((json as { data?: unknown }).data)
      ? (json as { data: unknown[] }).data
      : null;
  if (!data) return [];

  const ids: string[] = [];
  for (const item of data) {
    const id =
      typeof item === "string"
        ? item
        : item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string"
          ? (item as { id: string }).id
          : null;
    if (id && id.trim()) ids.push(id.trim());
  }
  return ids;
}

const MODELS_PATH = "/models";

/** Append /models to a base URL, tolerating a trailing slash or an already-complete URL. */
export function modelsEndpointUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  return trimmed.endsWith(MODELS_PATH) ? trimmed : trimmed + MODELS_PATH;
}

export interface ProviderPreset {
  id: string;
  label: string;
  baseUrl: string;
  requiresApiKey: boolean;
}

/**
 * Quick-setup presets shown in the providers view. OpenRouter is deliberately
 * NOT here — it is a separate, built-in provider (see extension.ts) with its
 * own curated model list; its card opens the existing
 * "Pixa: Set OpenRouter API Key" flow instead of this form.
 */
export const PRESETS: ProviderPreset[] = [
  { id: "ollama", label: "Ollama", baseUrl: "http://localhost:11434/v1", requiresApiKey: false },
  { id: "lmstudio", label: "LM Studio", baseUrl: "http://localhost:1234/v1", requiresApiKey: false },
  { id: "vllm", label: "vLLM", baseUrl: "http://localhost:8000/v1", requiresApiKey: false },
  { id: "nvidia", label: "NVIDIA NIM", baseUrl: "https://integrate.api.nvidia.com/v1", requiresApiKey: true },
];
