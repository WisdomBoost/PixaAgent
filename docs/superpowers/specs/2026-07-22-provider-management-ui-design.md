# Provider Management UI — Design

**Date:** 2026-07-22
**Status:** Approved, ready for implementation

## Problem

Pixa ships nine bundled models, all routed through OpenRouter. None work
without an API key, and there is no in-product way to add a provider — a user
who wants a local or self-hosted model must hand-edit `settings.json`.

Self-hosted model support is the project's headline open-source feature, yet it
is the least discoverable path in the product. A new user installs the
extension, sees nine models they cannot use, and has no on-screen indication
that pointing Pixa at their own server is even possible.

Hand-editing also has a silent failure mode observed in practice: a model id
must exactly match what the server reports. Typing `qwen2.5-coder` when the
server has `qwen2.5-coder:1.5b` produces no error at configuration time — the
model simply fails when first used.

## Goals

- A user can add a working provider without editing JSON.
- Local-model setup is discoverable from the panel, not only from the README.
- Model ids come from the server where possible, not from memory.
- Configuration written by the UI is identical to hand-written configuration;
  the two are interchangeable.

## Non-goals

- Replacing `settings.json` as the source of truth. The UI writes the same
  key, in the same shape.
- Editing a provider in place. Delete-and-re-add covers the need (see
  Decisions).
- Hot-reloading providers without a window reload (see Decisions).
- Managing the nine bundled OpenRouter models. They stay in `models.json`.

## Constraint that shapes the design

The webview runs under a strict Content-Security-Policy and cannot make network
requests or touch VS Code APIs. Every operation that reaches the network or
persists configuration must round-trip to the extension host over
`postMessage`. This is why model discovery is a host-side operation with an
explicit request/response message pair rather than a `fetch` in the webview.

## Architecture

### Surface

A gear icon in the existing chat panel header toggles between two views inside
the same webview: `#chat-view` and `#providers-view`. Exactly one is visible.
The chat transcript stays mounted, so switching views does not disturb an
in-progress session.

No second webview and no new VS Code panel. This reuses the existing
`ChatViewProvider` webview and its established `postMessage` channel.

### Providers view

Three sections, top to bottom:

**Configured providers.** One row per provider from `pixa.providers`: display
name, base URL, model count, delete button. When empty:

> No providers configured. Pixa's built-in models require an OpenRouter key —
> add a provider below to use your own endpoint or a local model.

**Quick setup.** Five preset cards. Four prefill the custom-provider form:

| Preset | Base URL | Requires key |
|---|---|---|
| Ollama | `http://localhost:11434/v1` | no |
| LM Studio | `http://localhost:1234/v1` | no |
| vLLM | `http://localhost:8000/v1` | no |
| NVIDIA NIM | `https://integrate.api.nvidia.com/v1` | yes |

Presets are a starting point, not a lock — every field stays editable after
selection. A sixth "Custom" option clears the form.

**OpenRouter is the fifth preset, and it behaves differently on purpose.**
OpenRouter is not a `pixa.providers` entry — it is wired in `extension.ts` as
a separate, built-in `ModelProvider` with id `"openrouter"`, backed by the
bundled `models.json` (nine curated models) and the existing
`pixa.setApiKey` command / `pixa.openrouter.apiKey` secret.

`ProviderRegistry.register()` is `this.providers.set(provider.id, provider)`
— a second registration with id `"openrouter"` would silently replace the
built-in one, and the custom-provider form has no way to offer the curated
model list, only manual entry. So clicking the OpenRouter card does not fill
the form: it runs the existing `pixa.setApiKey` command directly. A user who
only needs OpenRouter never touches the custom-provider path at all — this
preset exists purely so OpenRouter is visible and one click away from the
same screen where every other provider gets configured, not because it goes
through the same mechanism.

**Add provider form.** Fields: id, display name, base URL, requires-API-key
toggle, API key (shown only when the toggle is on), and models.

### Model discovery

Once a base URL is present, a **Fetch models** button asks the host to
`GET {baseUrl}/models`. The host performs the request and replies with the
parsed list; the webview renders one checkbox per model.

Discovery is best-effort and never blocks submission. An unreachable server, a
wrong URL, a non-200 response, or an endpoint that does not implement
`/v1/models` all produce the same fallback: an inline message and a free-text
field for entering model ids manually.

```
"Couldn't reach that server — enter model ids manually."
```

Response shapes differ across servers. The parser accepts the OpenAI shape
(`{"data":[{"id":"..."}]}`) and tolerates a bare array. Entries without a
usable id are skipped rather than rendered blank.

### Persistence

Provider configuration is written with:

```ts
vscode.workspace
  .getConfiguration("pixa")
  .update("providers", next, vscode.ConfigurationTarget.Global);
```

The written value uses the existing `ProvidersConfig` shape, so UI-created and
hand-written entries are indistinguishable and `providersToModels` consumes
both unchanged.

API keys never enter settings. They go to SecretStorage under the existing
`pixa.provider.<id>.apiKey` key — the same key `registerUserProviders` already
reads, so no change to the auth path.

### Applying changes

After a successful save the view shows:

> Provider added. Reload the window to use it.

with a Reload button that runs `workbench.action.reloadWindow`.

Providers and the model list are constructed once during `activate()` and
injected into `ChatViewProvider`. Live re-registration would require
restructuring that wiring; a single reload click is a proportionate cost for
an infrequent action.

## Message protocol

Additions to the existing `WebviewMessage` union and host `post` calls.

Webview to host:

| Message | Payload |
|---|---|
| `list-providers` | — |
| `fetch-models` | `{ baseUrl, apiKey? }` |
| `save-provider` | `{ id, name, baseUrl, requiresApiKey, apiKey?, models: { id, name? }[] }` |
| `delete-provider` | `{ id }` |
| `reload-window` | — |

Host to webview:

| Message | Payload |
|---|---|
| `providers` | `{ list: ProviderSummary[] }` |
| `fetched-models` | `{ models: string[] }` |
| `fetch-models-failed` | `{ reason: string }` |
| `provider-saved` | `{ id }` |
| `provider-deleted` | `{ id }` |
| `provider-error` | `{ message }` |

`provider-error` covers validation and persistence failures — a duplicate id, a
malformed URL, or a rejected settings write — and renders inline in the form.

## Components

### `src/providers/providerForm.ts` (new, pure)

No VS Code or network imports, so it is unit-testable in isolation. Exports:

- `validateProviderForm(form, existingIds)` — returns `{ ok: true, config }`
  or `{ ok: false, errors }`. Checks id format (lowercase, digits, hyphen,
  underscore), id uniqueness, non-empty base URL, parseable URL, and at least
  one model.
- `parseModelsResponse(json)` — accepts the OpenAI `data` shape or a bare
  array, returns `string[]`, skips entries without an id, never throws.
- `formToProviderConfig(form)` — maps validated form state to a
  `ProviderConfig` entry, reusing `chatCompletionsUrl` for URL normalization.
- `PRESETS` — the four form-filling preset definitions above as data. The
  OpenRouter card is not in this list — it is rendered separately in the
  webview and dispatches `pixa.setApiKey` instead of populating the form.

### `src/ui/chatViewProvider.ts` (extended)

Handles the six new inbound messages. The `fetch-models` handler performs the
HTTP request host-side with a short timeout and maps both success and every
failure mode onto the two response messages. Settings writes and SecretStorage
writes happen here.

### `src/ui/webview/main.js` and `style.css` (extended)

View toggle, providers list rendering, preset cards, form state, and the model
checkbox list. Follows the existing vanilla-JS message-switch pattern; no
framework introduced.

## Error handling

| Condition | Behavior |
|---|---|
| Server unreachable / non-200 / timeout | Fallback to manual model entry, inline message, submission still allowed |
| `/v1/models` returns unexpected JSON | Same fallback; parser returns `[]` rather than throwing |
| Duplicate provider id | `provider-error`, inline on the id field, nothing written |
| Malformed base URL | `provider-error`, inline on the URL field, nothing written |
| No models selected or entered | `provider-error`, submission blocked |
| Settings write rejected | `provider-error` with the underlying message; SecretStorage write is not attempted |

Ordering matters on save: validate first, then write settings, then write the
key. A failed settings write must not leave an orphaned secret.

Deleting a provider removes both its `pixa.providers` entry and its
SecretStorage key. Leaving the secret behind would silently reattach a stale
credential if a provider with the same id were added later.

## Testing

`test/providerForm.test.ts` covers the pure module:

- Valid form produces a `ProviderConfig` matching what `providersToModels`
  accepts.
- Rejects: duplicate id, invalid id characters, empty base URL, unparseable
  URL, zero models.
- `parseModelsResponse` handles the OpenAI `data` shape, a bare array,
  malformed JSON, an empty list, and entries missing an id.
- A keyless preset produces `requiresApiKey: false` and no key is persisted.
- Round-trip: `formToProviderConfig` output fed through `providersToModels`
  yields the expected namespaced model ids.

The webview has no test harness in this repository. Verification is compile,
package, install, and a manual pass: add an Ollama provider through the UI,
confirm the model appears in the picker after reload, confirm the same config
appears in `settings.json`, then delete it and confirm removal.

## Decisions and rejected alternatives

**Separate editor-tab webview** — rejected. A second webview to build and
maintain for a settings screen used rarely, when the existing panel has room.

**QuickPick wizard instead of HTML** — rejected. Least code, but it cannot show
a provider list well and makes multi-field editing awkward.

**Hot-reload providers without a window reload** — rejected for this iteration.
Requires restructuring how `ProviderRegistry` and the model list are built and
injected during activation. Disproportionate to the benefit for an action taken
once per provider.

**Full in-place editing** — rejected for this iteration. Delete-and-re-add
covers the need without form-population and update paths, in a codebase with no
webview test harness.

**Manual model entry only** — rejected. Discovery removes the observed silent
failure where a typed model id does not match the server's, which is the most
likely way a correctly-configured-looking provider still fails.

**Registering OpenRouter as a normal `pixa.providers` preset** — rejected.
Would silently overwrite the built-in provider (same id, last `register()`
wins) and lose the curated bundled model list in favor of manual entry. The
OpenRouter card instead opens the existing `pixa.setApiKey` flow.
