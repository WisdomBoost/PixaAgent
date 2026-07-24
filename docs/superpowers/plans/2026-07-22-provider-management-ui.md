# Provider Management UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user add, discover, and delete OpenAI-compatible providers (Ollama, LM Studio, vLLM, NVIDIA NIM, or a custom endpoint) from inside the Pixa panel, with no `settings.json` editing.

**Architecture:** A new "Providers" view inside the existing chat webview (toggled by a gear icon, same pattern as the chat-history panel). All persistence and network calls happen host-side (`chatViewProvider.ts`) via `postMessage`, since the webview runs under a CSP that blocks `fetch`. Validation and response-parsing logic lives in a new pure module so it is unit-testable without `vscode`.

**Tech Stack:** TypeScript (extension host), vanilla JS/CSS (webview — no framework, matches the existing `main.js`), vitest.

## Global Constraints

- No `Co-Authored-By: Claude` trailer in any commit — enforced project-wide.
- Pure logic (validation, parsing) must not import `vscode` — same rule already followed by `src/providers/config.ts`.
- Provider config written by this feature must be structurally identical to hand-written `pixa.providers` JSON — `providersToModels()` (existing, in `src/providers/config.ts`) must accept it unchanged.
- API keys are never written to `settings.json` — always VS Code `SecretStorage`, under the existing `pixa.provider.<id>.apiKey` key format.
- The webview has no test harness in this repo — its changes are verified by typecheck + compile + package + manual install, not unit tests. This matches how the existing chat UI is verified.
- Full spec: `docs/superpowers/specs/2026-07-22-provider-management-ui-design.md`.

---

### Task 1: Shared secret-key helper module

**Files:**
- Create: `packages/pixa-agent/src/providers/secretKeys.ts`
- Modify: `packages/pixa-agent/src/extension.ts:1-30`

**Interfaces:**
- Produces: `providerSecretKey(providerId: string): string` — used by Task 3.

`providerSecretKey` currently lives as a private function inside `extension.ts`. Task 3 needs it from `chatViewProvider.ts`, and `chatViewProvider.ts` cannot import from `extension.ts` (that file imports `ChatViewProvider`, so the reverse import would be circular). Moving it to its own module fixes this with no behavior change.

- [ ] **Step 1: Create the new module**

Create `packages/pixa-agent/src/providers/secretKeys.ts`:

```ts
/** Secret-storage key holding the API key for a user-configured provider (`pixa.providers`). */
export function providerSecretKey(providerId: string): string {
  return `pixa.provider.${providerId}.apiKey`;
}
```

- [ ] **Step 2: Update `extension.ts` to import it instead of defining it locally**

In `packages/pixa-agent/src/extension.ts`, find:

```ts
import { providersToModels, chatCompletionsUrl, type ProvidersConfig } from "./providers/config";
import type { ModelEntry } from "./providers/types";

const API_KEY_SECRET = "pixa.openrouter.apiKey";

/** Secret-storage key holding the API key for a user-configured provider. */
function providerSecretKey(providerId: string): string {
  return `pixa.provider.${providerId}.apiKey`;
}
```

Replace with:

```ts
import { providersToModels, chatCompletionsUrl, type ProvidersConfig } from "./providers/config";
import type { ModelEntry } from "./providers/types";
import { providerSecretKey } from "./providers/secretKeys";

const API_KEY_SECRET = "pixa.openrouter.apiKey";
```

The two existing call sites (`context.secrets.get(providerSecretKey(providerId))` and `context.secrets.store(providerSecretKey(picked.id), ...)`) are unchanged — only where the function is defined moves.

- [ ] **Step 3: Typecheck**

Run: `cd packages/pixa-agent && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Run the existing offline test suite to confirm nothing broke**

Run: `cd packages/pixa-agent && npx vitest run --exclude "**/Vector.test.ts" --exclude "**/embeddings.test.ts" --exclude "**/*.manual.*"`
Expected: all tests still pass (same count as before this change).

- [ ] **Step 5: Commit**

```bash
git add packages/pixa-agent/src/providers/secretKeys.ts packages/pixa-agent/src/extension.ts
git commit -m "refactor: extract providerSecretKey into its own module

chatViewProvider.ts needs it for the provider-management UI (Task 3) and
cannot import from extension.ts without a circular import."
```

---

### Task 2: `providerForm.ts` pure module (TDD)

**Files:**
- Create: `packages/pixa-agent/src/providers/providerForm.ts`
- Test: `packages/pixa-agent/test/providerForm.test.ts`

**Interfaces:**
- Consumes: `ProviderConfig`, `UserModelConfig` (types, from `src/providers/config.ts`); `providersToModels` (test-only, from `src/providers/config.ts`).
- Produces (used by Task 3 and Task 4):
  - `validateProviderForm(form: ProviderFormInput, existingIds: string[]): ProviderFormResult`
  - `formToProviderConfig(form: ProviderFormInput): ProviderConfig`
  - `parseModelsResponse(json: unknown): string[]`
  - `modelsEndpointUrl(baseUrl: string): string`
  - `PRESETS: ProviderPreset[]`
  - Types: `ProviderFormModel`, `ProviderFormInput`, `ProviderFormErrors`, `ProviderFormResult`, `ProviderPreset`

- [ ] **Step 1: Write the failing tests**

Create `packages/pixa-agent/test/providerForm.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  validateProviderForm,
  parseModelsResponse,
  modelsEndpointUrl,
  PRESETS,
} from "../src/providers/providerForm";
import { providersToModels } from "../src/providers/config";

describe("validateProviderForm", () => {
  const baseForm = {
    id: "ollama",
    name: "Ollama (local)",
    baseUrl: "http://localhost:11434/v1",
    requiresApiKey: false,
    models: [{ id: "qwen2.5-coder:1.5b", name: "Qwen2.5 Coder 1.5B" }],
  };

  it("accepts a valid form and produces a ProviderConfig", () => {
    const result = validateProviderForm(baseForm, []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config).toEqual({
      name: "Ollama (local)",
      baseUrl: "http://localhost:11434/v1",
      requiresApiKey: false,
      models: { "qwen2.5-coder:1.5b": { name: "Qwen2.5 Coder 1.5B" } },
    });
  });

  it("round-trips through providersToModels into a namespaced model entry", () => {
    const result = validateProviderForm(baseForm, []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { models, errors } = providersToModels({ ollama: result.config });
    expect(errors).toEqual([]);
    expect(models[0].id).toBe("ollama:qwen2.5-coder:1.5b");
    expect(models[0].supportsTools).toBe(true);
  });

  it("rejects a duplicate id", () => {
    const result = validateProviderForm(baseForm, ["ollama"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.id).toMatch(/already exists/);
  });

  it("rejects the reserved id 'openrouter' — colliding would silently overwrite the built-in provider", () => {
    const result = validateProviderForm({ ...baseForm, id: "openrouter" }, []);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.id).toMatch(/reserved/);
  });

  it("rejects the reserved id 'local-embeddings'", () => {
    const result = validateProviderForm({ ...baseForm, id: "local-embeddings" }, []);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.id).toMatch(/reserved/);
  });

  it("rejects invalid id characters", () => {
    const result = validateProviderForm({ ...baseForm, id: "My Provider!" }, []);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.id).toBeDefined();
  });

  it("rejects an empty base URL", () => {
    const result = validateProviderForm({ ...baseForm, baseUrl: "" }, []);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.baseUrl).toMatch(/required/);
  });

  it("rejects an unparseable base URL", () => {
    const result = validateProviderForm({ ...baseForm, baseUrl: "not a url" }, []);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.baseUrl).toMatch(/valid URL/);
  });

  it("rejects a form with zero models", () => {
    const result = validateProviderForm({ ...baseForm, models: [] }, []);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.models).toMatch(/at least one/);
  });

  it("ignores model rows with a blank id", () => {
    const result = validateProviderForm({ ...baseForm, models: [{ id: "  " }, { id: "real-model" }] }, []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.config.models)).toEqual(["real-model"]);
  });
});

describe("parseModelsResponse", () => {
  it("parses the OpenAI-style {data:[{id}]} shape", () => {
    expect(parseModelsResponse({ data: [{ id: "qwen2.5-coder:1.5b" }, { id: "llama3.1" }] })).toEqual([
      "qwen2.5-coder:1.5b",
      "llama3.1",
    ]);
  });

  it("parses a bare array of ids", () => {
    expect(parseModelsResponse(["model-a", "model-b"])).toEqual(["model-a", "model-b"]);
  });

  it("returns an empty list for malformed JSON shapes", () => {
    expect(parseModelsResponse({ nonsense: true })).toEqual([]);
    expect(parseModelsResponse(null)).toEqual([]);
    expect(parseModelsResponse("a string")).toEqual([]);
  });

  it("skips entries with no usable id", () => {
    expect(parseModelsResponse({ data: [{ id: "good" }, { name: "no id field" }, {}] })).toEqual(["good"]);
  });

  it("returns an empty list for an empty data array", () => {
    expect(parseModelsResponse({ data: [] })).toEqual([]);
  });
});

describe("modelsEndpointUrl", () => {
  it("appends /models to a base URL", () => {
    expect(modelsEndpointUrl("http://localhost:11434/v1")).toBe("http://localhost:11434/v1/models");
  });

  it("strips a trailing slash before appending", () => {
    expect(modelsEndpointUrl("http://localhost:11434/v1/")).toBe("http://localhost:11434/v1/models");
  });

  it("does not double up if the URL already ends in /models", () => {
    expect(modelsEndpointUrl("http://localhost:11434/v1/models")).toBe("http://localhost:11434/v1/models");
  });
});

describe("PRESETS", () => {
  it("does not include OpenRouter — it opens the built-in key-setup flow instead", () => {
    expect(PRESETS.some((p) => p.id === "openrouter")).toBe(false);
  });

  it("all presets are keyless local servers except NVIDIA NIM", () => {
    for (const preset of PRESETS) {
      expect(preset.requiresApiKey).toBe(preset.id === "nvidia");
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/pixa-agent && npx vitest run test/providerForm.test.ts`
Expected: FAIL — `Cannot find module '../src/providers/providerForm'`.

- [ ] **Step 3: Implement `providerForm.ts`**

Create `packages/pixa-agent/src/providers/providerForm.ts`:

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/pixa-agent && npx vitest run test/providerForm.test.ts`
Expected: PASS, 20 tests.

- [ ] **Step 5: Typecheck**

Run: `cd packages/pixa-agent && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/pixa-agent/src/providers/providerForm.ts packages/pixa-agent/test/providerForm.test.ts
git commit -m "feat: add providerForm pure module for provider-management UI validation

Validates and shapes provider-form submissions, parses /models responses
from Ollama/vLLM/OpenAI-shaped servers, and defines the quick-setup
presets. Reserves the 'openrouter' and 'local-embeddings' ids since those
are built-in providers a custom entry would silently overwrite."
```

---

### Task 3: Host-side message protocol in `chatViewProvider.ts`

**Files:**
- Modify: `packages/pixa-agent/src/ui/chatViewProvider.ts`

**Interfaces:**
- Consumes: `providerSecretKey` (Task 1); `validateProviderForm`, `parseModelsResponse`, `modelsEndpointUrl` (Task 2); `ProvidersConfig` (existing, `src/providers/config.ts`).
- Produces (used by Task 4's webview JS):
  - Webview → host messages: `list-providers`, `fetch-models {baseUrl, apiKey?}`, `save-provider {id, name, baseUrl, requiresApiKey, apiKey?, models}`, `delete-provider {id}`, `reload-window`.
  - Host → webview messages: `providers {list: {id, name, baseUrl, modelCount}[]}`, `fetched-models {models: string[]}`, `fetch-models-failed {reason}`, `provider-saved {id}`, `provider-deleted {id}`, `provider-error {message}`.

- [ ] **Step 1: Add imports**

In `packages/pixa-agent/src/ui/chatViewProvider.ts`, find:

```ts
import type { ChatMessage } from "../providers/types";
```

Add after it:

```ts
import type { ProvidersConfig } from "../providers/config";
import { validateProviderForm, parseModelsResponse, modelsEndpointUrl } from "../providers/providerForm";
import { providerSecretKey } from "../providers/secretKeys";
```

- [ ] **Step 2: Extend the `WebviewMessage` union**

Find:

```ts
  | { type: "delete-session"; id: string }
  | { type: "set-api-key" };
```

Replace with:

```ts
  | { type: "delete-session"; id: string }
  | { type: "set-api-key" }
  | { type: "list-providers" }
  | { type: "fetch-models"; baseUrl: string; apiKey?: string }
  | {
      type: "save-provider";
      id: string;
      name: string;
      baseUrl: string;
      requiresApiKey: boolean;
      apiKey?: string;
      models: { id: string; name?: string }[];
    }
  | { type: "delete-provider"; id: string }
  | { type: "reload-window" };
```

- [ ] **Step 3: Add the new cases to `onMessage`**

Find the end of the `case "set-api-key":` block (it ends with `break;` followed by `}` then the switch's closing `}`):

```ts
      case "set-api-key": {
        await vscode.commands.executeCommand("pixa.setApiKey");
        const hasApiKey = !!(await this.context.secrets.get("pixa.openrouter.apiKey"));
        this.post({ type: "api-key-status", hasApiKey } as any);
        if (hasApiKey) this.post({ type: "status", text: "API key updated." });
        break;
      }
    }
  }
```

Replace with:

```ts
      case "set-api-key": {
        await vscode.commands.executeCommand("pixa.setApiKey");
        const hasApiKey = !!(await this.context.secrets.get("pixa.openrouter.apiKey"));
        this.post({ type: "api-key-status", hasApiKey } as any);
        if (hasApiKey) this.post({ type: "status", text: "API key updated." });
        break;
      }
      case "list-providers":
        this.postProviders();
        break;
      case "fetch-models": {
        const result = await this.fetchModels(msg.baseUrl, msg.apiKey);
        if (result.ok) {
          this.post({ type: "fetched-models", models: result.models });
        } else {
          this.post({ type: "fetch-models-failed", reason: result.reason });
        }
        break;
      }
      case "save-provider":
        await this.saveProvider(msg);
        break;
      case "delete-provider":
        await this.deleteProvider(msg.id);
        break;
      case "reload-window":
        await vscode.commands.executeCommand("workbench.action.reloadWindow");
        break;
    }
  }
```

- [ ] **Step 4: Add the four private methods**

Find the end of the `onMessage` method — the closing `}` you just edited in Step 3 — and insert immediately after it (still inside the class, before `private async onChangeSetAction(`):

```ts

  /* ---------- provider management ---------- */

  private postProviders(): void {
    const cfg = vscode.workspace.getConfiguration("pixa").get<ProvidersConfig>("providers") ?? {};
    this.post({
      type: "providers",
      list: Object.entries(cfg).map(([id, p]) => ({
        id,
        name: p.name?.trim() || id,
        baseUrl: p.baseUrl,
        modelCount: Object.keys(p.models ?? {}).length,
      })),
    });
  }

  private async fetchModels(
    baseUrl: string,
    apiKey?: string
  ): Promise<{ ok: true; models: string[] } | { ok: false; reason: string }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(modelsEndpointUrl(baseUrl), {
        signal: controller.signal,
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      });
      if (!res.ok) return { ok: false, reason: `Server responded with ${res.status}.` };
      const models = parseModelsResponse(await res.json());
      if (models.length === 0) return { ok: false, reason: "No models found in the server's response." };
      return { ok: true, models };
    } catch (e: any) {
      return { ok: false, reason: e?.message ?? "Request failed." };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async saveProvider(msg: {
    id: string;
    name: string;
    baseUrl: string;
    requiresApiKey: boolean;
    apiKey?: string;
    models: { id: string; name?: string }[];
  }): Promise<void> {
    const config = vscode.workspace.getConfiguration("pixa");
    const cfg = config.get<ProvidersConfig>("providers") ?? {};

    const result = validateProviderForm(
      { id: msg.id, name: msg.name, baseUrl: msg.baseUrl, requiresApiKey: msg.requiresApiKey, models: msg.models },
      Object.keys(cfg)
    );
    if (!result.ok) {
      const message = Object.values(result.errors).filter(Boolean).join(" ");
      this.post({ type: "provider-error", message });
      return;
    }

    const id = msg.id.trim();
    try {
      await config.update("providers", { ...cfg, [id]: result.config }, vscode.ConfigurationTarget.Global);
    } catch (e: any) {
      this.post({ type: "provider-error", message: `Failed to save: ${e?.message ?? e}` });
      return;
    }

    if (msg.requiresApiKey && msg.apiKey?.trim()) {
      await this.context.secrets.store(providerSecretKey(id), msg.apiKey.trim());
    }

    this.post({ type: "provider-saved", id });
    this.postProviders();
  }

  private async deleteProvider(id: string): Promise<void> {
    const config = vscode.workspace.getConfiguration("pixa");
    const cfg = config.get<ProvidersConfig>("providers") ?? {};
    if (!(id in cfg)) return;
    const next = { ...cfg };
    delete next[id];
    await config.update("providers", next, vscode.ConfigurationTarget.Global);
    await this.context.secrets.delete(providerSecretKey(id));
    this.post({ type: "provider-deleted", id });
    this.postProviders();
  }
```

- [ ] **Step 5: Typecheck**

Run: `cd packages/pixa-agent && npx tsc --noEmit`
Expected: no errors. (Deletion ordering matters: settings write happens before the SecretStorage write in `saveProvider`, and both the config entry and the secret are removed in `deleteProvider` — re-check both methods against this file if the diff didn't land exactly as shown.)

- [ ] **Step 6: Commit**

```bash
git add packages/pixa-agent/src/ui/chatViewProvider.ts
git commit -m "feat: add provider-management message protocol to ChatViewProvider

Host-side handlers for listing, adding, deleting providers and discovering
a server's models via /models. No UI yet — that's Task 4. Verified by
typecheck only; this file has no test harness (matches existing convention)."
```

---

### Task 4: Providers view — HTML, JS, CSS

**Files:**
- Modify: `packages/pixa-agent/src/ui/chatViewProvider.ts` (the `html()` method only)
- Modify: `packages/pixa-agent/src/ui/webview/main.js`
- Modify: `packages/pixa-agent/src/ui/webview/style.css`

**Interfaces:**
- Consumes: the message names and payloads produced by Task 3.
- Produces: nothing consumed by later tasks — this is the UI surface itself.

These three files change together because none of them is independently meaningful: HTML with no JS behind it does nothing, and JS referencing DOM ids that don't exist in the HTML throws. They are verified together, in Task 5.

- [ ] **Step 1: Add the gear icon button**

In `packages/pixa-agent/src/ui/chatViewProvider.ts`, inside the `html()` method, find:

```html
      <button id="new-session" class="icon-btn" title="New chat">＋</button>
```

Replace with:

```html
      <button id="new-session" class="icon-btn" title="New chat">＋</button>
      <button id="show-providers" class="icon-btn" title="Providers">⚙</button>
```

- [ ] **Step 2: Add the providers panel markup**

In the same `html()` method, find:

```html
    <div id="history-panel" class="hidden">
      <div id="history-header">
        <span>Chats</span>
        <button id="close-history" class="icon-btn" title="Back to chat">✕</button>
      </div>
      <div id="history-list"></div>
    </div>
```

Add immediately after the closing `</div>` of `#history-panel` (still before `<div id="messages">`):

```html
    <div id="providers-panel" class="hidden">
      <div id="providers-header">
        <span>Providers</span>
        <button id="close-providers" class="icon-btn" title="Back to chat">✕</button>
      </div>
      <div id="providers-body">
        <div id="pf-reload-banner" class="hidden">
          Provider added. <button id="pf-reload-btn">Reload window</button>
        </div>

        <div class="section-title">Configured</div>
        <div id="providers-list"></div>

        <div class="section-title">Quick setup</div>
        <div id="preset-cards"></div>

        <form id="provider-form">
          <div class="section-title">Add provider</div>
          <div id="provider-error" class="hidden"></div>
          <label>Provider ID<input id="pf-id" placeholder="ollama" autocomplete="off"></label>
          <label>Display name<input id="pf-name" placeholder="Ollama (local)" autocomplete="off"></label>
          <label>Base URL<input id="pf-baseurl" placeholder="http://localhost:11434/v1" autocomplete="off"></label>
          <label class="pf-checkbox"><input type="checkbox" id="pf-requires-key"> Requires API key</label>
          <label id="pf-apikey-row" class="hidden">API key<input id="pf-apikey" type="password" autocomplete="off"></label>

          <div class="section-title">Models</div>
          <div class="pf-fetch-row">
            <button type="button" id="pf-fetch-models">Fetch models</button>
            <span id="pf-fetch-status"></span>
          </div>
          <div id="pf-fetched-list"></div>
          <div id="pf-manual-list"></div>
          <button type="button" id="pf-add-model-row">+ Add model manually</button>

          <button type="submit" id="pf-submit">Add provider</button>
        </form>
      </div>
    </div>
```

- [ ] **Step 3: Add the message-handling cases in `main.js`**

In `packages/pixa-agent/src/ui/webview/main.js`, inside the `window.addEventListener("message", ...)` switch, find:

```js
      case "run-finished":
        setRunning(false);
        currentAssistantEl = null;
        break;
    }
  });
```

Replace with:

```js
      case "run-finished":
        setRunning(false);
        currentAssistantEl = null;
        break;
      case "providers":
        renderProviders(msg.list);
        break;
      case "fetched-models":
        renderFetchedModels(msg.models);
        break;
      case "fetch-models-failed":
        setFetchStatus(msg.reason + " — enter model ids manually below.");
        break;
      case "provider-saved":
        $("provider-error").classList.add("hidden");
        $("pf-reload-banner").classList.remove("hidden");
        resetProviderForm();
        break;
      case "provider-error":
        $("provider-error").textContent = msg.message;
        $("provider-error").classList.remove("hidden");
        break;
      case "provider-deleted":
        break;
    }
  });
```

- [ ] **Step 4: Add the providers-view rendering functions**

In the same file, find:

```js
  function renderSessions(sessions, activeId) {
```

and its closing `}` — the function ends right before this comment:

```js
  /* ---------- user actions ---------- */
```

Insert the following new block between the end of `renderSessions` and the `/* ---------- user actions ---------- */` comment:

```js
  /* ---------- providers view ---------- */

  // Mirrors src/providers/providerForm.ts's PRESETS. Duplicated deliberately:
  // the webview is plain JS, not bundled with the TS extension host, so
  // there's no shared-import path without adding a build step for four
  // short entries. Keep the two lists in sync if presets change.
  const PRESET_CARDS = [
    { id: "ollama", label: "Ollama", baseUrl: "http://localhost:11434/v1", requiresApiKey: false },
    { id: "lmstudio", label: "LM Studio", baseUrl: "http://localhost:1234/v1", requiresApiKey: false },
    { id: "vllm", label: "vLLM", baseUrl: "http://localhost:8000/v1", requiresApiKey: false },
    { id: "nvidia", label: "NVIDIA NIM", baseUrl: "https://integrate.api.nvidia.com/v1", requiresApiKey: true },
  ];

  function renderProviders(list) {
    const el = $("providers-list");
    el.innerHTML = "";
    if (list.length === 0) {
      el.innerHTML =
        '<div class="providers-empty">No providers configured. Pixa\'s built-in models require an ' +
        "OpenRouter key — add a provider below to use your own endpoint or a local model.</div>";
      return;
    }
    for (const p of list) {
      const row = document.createElement("div");
      row.className = "provider-row";
      row.innerHTML =
        '<div class="provider-main"><div class="provider-name">' + escapeHtml(p.name) +
        '</div><div class="provider-meta">' + escapeHtml(p.baseUrl) + " · " + p.modelCount +
        " model" + (p.modelCount === 1 ? "" : "s") +
        '</div></div><button class="provider-delete" title="Delete provider">✕</button>';
      row.querySelector(".provider-delete").addEventListener("click", () => {
        vscode.postMessage({ type: "delete-provider", id: p.id });
      });
      el.appendChild(row);
    }
  }

  function renderPresetCards() {
    const el = $("preset-cards");
    el.innerHTML = "";
    for (const preset of PRESET_CARDS) {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "preset-card";
      card.textContent = preset.label;
      card.addEventListener("click", () => fillPresetForm(preset));
      el.appendChild(card);
    }
    const orCard = document.createElement("button");
    orCard.type = "button";
    orCard.className = "preset-card";
    orCard.textContent = "OpenRouter";
    orCard.title = "OpenRouter is built in — this opens the API key setup instead of the form below.";
    orCard.addEventListener("click", () => vscode.postMessage({ type: "set-api-key" }));
    el.appendChild(orCard);
  }

  function fillPresetForm(preset) {
    $("pf-id").value = preset.id;
    $("pf-name").value = preset.label;
    $("pf-baseurl").value = preset.baseUrl;
    $("pf-requires-key").checked = preset.requiresApiKey;
    $("pf-apikey-row").classList.toggle("hidden", !preset.requiresApiKey);
    $("pf-fetched-list").innerHTML = "";
    $("pf-manual-list").innerHTML = "";
    setFetchStatus("");
    addManualModelRow("", "");
  }

  function resetProviderForm() {
    $("provider-form").reset();
    $("pf-apikey-row").classList.add("hidden");
    $("pf-fetched-list").innerHTML = "";
    $("pf-manual-list").innerHTML = "";
    setFetchStatus("");
    addManualModelRow("", "");
  }

  function addManualModelRow(id, name) {
    const row = document.createElement("div");
    row.className = "pf-manual-row";
    row.innerHTML =
      '<input class="pf-manual-id" placeholder="model-id" value="' + escapeHtml(id || "") + '">' +
      '<input class="pf-manual-name" placeholder="Display name (optional)" value="' + escapeHtml(name || "") + '">' +
      '<button type="button" class="pf-remove-row">✕</button>';
    row.querySelector(".pf-remove-row").addEventListener("click", () => row.remove());
    $("pf-manual-list").appendChild(row);
  }

  function renderFetchedModels(models) {
    const el = $("pf-fetched-list");
    el.innerHTML = "";
    for (const id of models) {
      const row = document.createElement("label");
      row.className = "pf-fetched-row";
      row.innerHTML =
        '<input type="checkbox" class="pf-fetched-checkbox" value="' + escapeHtml(id) + '" checked> ' + escapeHtml(id);
      el.appendChild(row);
    }
    setFetchStatus(models.length + " model(s) found — uncheck any you don't want.");
  }

  function setFetchStatus(text) {
    $("pf-fetch-status").textContent = text;
  }

```

- [ ] **Step 5: Wire up the providers-view event listeners**

In the same file, find:

```js
  $("set-key-link").addEventListener("click", (e) => {
    e.preventDefault();
    vscode.postMessage({ type: "set-api-key" });
  });

  vscode.postMessage({ type: "ready" });
})();
```

Replace with:

```js
  $("set-key-link").addEventListener("click", (e) => {
    e.preventDefault();
    vscode.postMessage({ type: "set-api-key" });
  });
  $("show-providers").addEventListener("click", () => {
    $("providers-panel").classList.toggle("hidden");
    vscode.postMessage({ type: "list-providers" });
  });
  $("close-providers").addEventListener("click", () => $("providers-panel").classList.add("hidden"));
  $("pf-requires-key").addEventListener("change", () => {
    $("pf-apikey-row").classList.toggle("hidden", !$("pf-requires-key").checked);
  });
  $("pf-fetch-models").addEventListener("click", () => {
    const baseUrl = $("pf-baseurl").value.trim();
    if (!baseUrl) {
      setFetchStatus("Enter a base URL first.");
      return;
    }
    setFetchStatus("Fetching…");
    const apiKey = $("pf-apikey").value.trim();
    vscode.postMessage({ type: "fetch-models", baseUrl, apiKey: apiKey || undefined });
  });
  $("pf-add-model-row").addEventListener("click", () => addManualModelRow("", ""));
  $("pf-reload-btn").addEventListener("click", () => vscode.postMessage({ type: "reload-window" }));
  $("provider-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const models = [];
    document.querySelectorAll(".pf-fetched-checkbox:checked").forEach((cb) => models.push({ id: cb.value }));
    document.querySelectorAll(".pf-manual-row").forEach((row) => {
      const id = row.querySelector(".pf-manual-id").value.trim();
      if (!id) return;
      const name = row.querySelector(".pf-manual-name").value.trim();
      models.push(name ? { id, name } : { id });
    });
    vscode.postMessage({
      type: "save-provider",
      id: $("pf-id").value.trim(),
      name: $("pf-name").value.trim(),
      baseUrl: $("pf-baseurl").value.trim(),
      requiresApiKey: $("pf-requires-key").checked,
      apiKey: $("pf-apikey").value.trim() || undefined,
      models,
    });
  });

  renderPresetCards();
  addManualModelRow("", "");

  vscode.postMessage({ type: "ready" });
})();
```

- [ ] **Step 6: Add the CSS**

Append to the end of `packages/pixa-agent/src/ui/webview/style.css`:

```css

/* ---------- providers panel ---------- */
#providers-panel {
  position: absolute;
  inset: 39px 0 0 0;
  background: var(--vscode-sideBar-background);
  z-index: 10;
  display: flex;
  flex-direction: column;
}
#providers-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 10px;
  font-weight: 600;
  border-bottom: 1px solid var(--vscode-panel-border);
}
#providers-body { overflow-y: auto; flex: 1; padding: 10px; }
.section-title {
  font-size: 0.75em;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  color: var(--vscode-descriptionForeground);
  margin: 14px 0 6px;
}
.providers-empty { color: var(--vscode-descriptionForeground); font-style: italic; font-size: 0.9em; }
.provider-row {
  display: flex;
  align-items: center;
  padding: 6px 0;
  border-bottom: 1px solid var(--vscode-panel-border);
  gap: 6px;
}
.provider-main { flex: 1; min-width: 0; }
.provider-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.provider-meta { font-size: 0.8em; color: var(--vscode-descriptionForeground); }
.provider-delete {
  background: transparent;
  color: var(--vscode-descriptionForeground);
  padding: 2px 6px;
}
.provider-delete:hover { color: var(--vscode-errorForeground); background: transparent; }

#preset-cards { display: flex; flex-wrap: wrap; gap: 6px; }
.preset-card {
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  font-size: 0.85em;
  padding: 6px 10px;
}
.preset-card:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-secondaryBackground)); }

#provider-form { display: flex; flex-direction: column; gap: 8px; }
#provider-form label { display: flex; flex-direction: column; gap: 3px; font-size: 0.85em; color: var(--vscode-descriptionForeground); }
#provider-form label.pf-checkbox { flex-direction: row; align-items: center; gap: 6px; }
#provider-form input:not([type="checkbox"]) {
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
  border-radius: 4px;
  padding: 5px 6px;
  font-family: inherit;
}
#provider-error {
  color: var(--vscode-errorForeground);
  background: var(--vscode-inputValidation-errorBackground, rgba(200,0,0,0.15));
  border: 1px solid var(--vscode-inputValidation-errorBorder, #c00);
  border-radius: 4px;
  padding: 6px 8px;
  font-size: 0.85em;
}
.pf-fetch-row { display: flex; align-items: center; gap: 8px; }
#pf-fetch-status { font-size: 0.8em; color: var(--vscode-descriptionForeground); }
.pf-fetched-row, .pf-manual-row { display: flex; align-items: center; gap: 6px; padding: 3px 0; font-size: 0.9em; }
.pf-manual-row input { flex: 1; }
#pf-reload-banner {
  background: var(--vscode-editorWidget-background);
  border: 1px solid var(--vscode-focusBorder);
  border-radius: 4px;
  padding: 8px;
  margin-bottom: 10px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
```

- [ ] **Step 7: Typecheck**

Run: `cd packages/pixa-agent && npx tsc --noEmit`
Expected: no errors. (`main.js`/`style.css` are plain JS/CSS, not type-checked — this step confirms `chatViewProvider.ts`'s HTML edit didn't break the surrounding TypeScript.)

- [ ] **Step 8: Commit**

```bash
git add packages/pixa-agent/src/ui/chatViewProvider.ts packages/pixa-agent/src/ui/webview/main.js packages/pixa-agent/src/ui/webview/style.css
git commit -m "feat: add providers view UI — presets, model discovery, add/delete

Gear icon in the chat panel header opens a Providers view: configured
providers with delete, five quick-setup presets (Ollama/LM Studio/vLLM/
NVIDIA NIM fill the form; OpenRouter opens the existing key-setup command
instead), and a form with server-side model discovery via /models."
```

---

### Task 5: Build, install, manual verification, offline test suite

**Files:** none (build/package/install only)

**Interfaces:** none — this task consumes the finished feature and checks it works.

- [ ] **Step 1: Run the full offline test suite**

Run: `cd packages/pixa-agent && npx vitest run --exclude "**/Vector.test.ts" --exclude "**/embeddings.test.ts" --exclude "**/*.manual.*"`
Expected: all tests pass, including the 20 new `providerForm.test.ts` tests from Task 2.

- [ ] **Step 2: Typecheck one more time from the repo root**

Run: `cd /d/IDE_pixa && npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Rebuild the bundle**

Run: `cd packages/pixa-agent && node esbuild.mjs`
Expected: `[esbuild] build complete`.

- [ ] **Step 4: Repackage the extension**

Run: `cd packages/pixa-agent && rm -f pixa-agent-0.6.0.vsix && npx vsce package --no-dependencies`
Expected: `DONE  Packaged: ...pixa-agent-0.6.0.vsix`.

- [ ] **Step 5: Reinstall**

Run: `code --install-extension packages/pixa-agent/pixa-agent-0.6.0.vsix --force`
Expected: `Extension 'pixa-agent-0.6.0.vsix' was successfully installed.`

- [ ] **Step 6: Manual verification pass**

Reload VS Code (`Ctrl+Shift+P` → "Reload Window"), open the Pixa panel, and walk through:

1. Click the gear icon (⚙) in the header — the Providers view opens, showing "No providers configured..." (or your existing `ollama` entry if you followed the earlier setup in this session).
2. Click the **Ollama** preset card — the form fills with `id=ollama`, `baseUrl=http://localhost:11434/v1`, the API-key row stays hidden.
3. If Ollama is running with a model pulled, click **Fetch models** — checkboxes appear listing what's actually installed (e.g. `qwen2.5-coder:1.5b`), all checked by default.
4. Try submitting with `id` set to `openrouter` — confirm the reserved-id error shows inline and nothing is written.
5. Change the id back to something free (e.g. `ollama-test`), submit — confirm the "Provider added. Reload window" banner appears, and clicking **Reload window** actually reloads.
6. After reload, reopen the Providers view — the new provider appears in the Configured list with the right model count. Confirm the model appears in the main chat model dropdown as `<model> (Ollama)` or similar.
7. Delete the test provider via its ✕ button — confirm it disappears from the list and (checking `settings.json` directly) is removed from `pixa.providers`, and its secret (if any) is gone from SecretStorage (no direct UI for this — trust the code path from Task 3, or check via `context.secrets` in the Debug Console if you want to be thorough).
8. Click the **OpenRouter** preset card — confirm it opens the existing "Enter your OpenRouter API key" input box, NOT the custom-provider form.

- [ ] **Step 7: Commit if Step 6 required any fixes**

If manual verification surfaced any bugs, fix them, re-run Steps 1–6, then commit the fix separately:

```bash
git add -A packages/pixa-agent
git commit -m "fix: <describe what manual verification caught>"
```

If Step 6 passed clean with no fixes needed, there is nothing to commit here — Task 4's commit already covers the working feature.

---

## Self-Review Notes

- **Spec coverage:** surface/navigation (Task 4 Steps 1-2), presets incl. OpenRouter's special behavior (Task 2 `PRESETS` + Task 4 `renderPresetCards`), model discovery with fallback (Task 3 `fetchModels` + Task 4 `fetch-models-failed` case), persistence to `pixa.providers` + SecretStorage (Task 3 `saveProvider`/`deleteProvider`), reload-to-apply (Task 3 `reload-window` case + Task 4 banner), delete support (Task 3 `deleteProvider` + Task 4 delete button), pure-module testing (Task 2), manual webview verification (Task 5) — all covered.
- **Placeholder scan:** none found — every step has complete code.
- **Type consistency:** `ProviderFormInput`/`ProviderFormModel` (Task 2) match the `save-provider` message shape (Task 3) and the payload built in `main.js`'s submit handler (Task 4) field-for-field. `providerSecretKey` signature (Task 1) matches both call sites in Task 3.
