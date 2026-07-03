# Pixa IDE — Design Spec (v1)

**Date:** 2026-07-03
**Status:** Approved by stakeholder
**Goal:** An AI-first IDE (Cursor-class) built on VS Code OSS, with an agentic coding assistant powered by OpenRouter (GLM default), architected to be provider-agnostic, plugin-extensible, and production-ready.

## 1. Product definition

Pixa IDE is a branded VS Code OSS distribution whose flagship capability is **Pixa Agent**: a sidebar agent that takes natural-language tasks, plans, reads and searches the repository, proposes multi-file edits as reviewable change sets, and executes terminal/git operations under explicit user approval.

**V1 in scope:** agent chat panel, tool-calling agent loop, repository indexer (file map + symbol outline + ripgrep search), token-budgeted context manager, multi-file change-set diff review, approval-gated terminal + git tools, model switcher UI, modular provider layer.

**Deferred (explicitly):** inline tab autocomplete, cloud workspaces, collaboration/enterprise features, embedding/vector semantic index (interface stubbed), multi-agent workflows, MCP servers. The architecture must accommodate all of these without structural change.

## 2. Architecture

Two-layer product, monorepo:

```
pixa/
├─ packages/pixa-agent/        # THE PRODUCT LOGIC (VS Code extension)
│  ├─ src/
│  │  ├─ extension.ts          # activation, wiring
│  │  ├─ providers/            # model provider layer
│  │  │  ├─ types.ts           # ModelProvider interface, ChatMessage, ToolCall types
│  │  │  ├─ openrouter.ts      # OpenRouterProvider (OpenAI-compatible, SSE streaming)
│  │  │  └─ registry.ts        # loads models.json, resolves provider+model
│  │  ├─ agent/
│  │  │  ├─ loop.ts            # agentic loop: model ⇄ tools until final answer
│  │  │  ├─ systemPrompt.ts    # persona + rules + workspace context
│  │  │  └─ contextManager.ts  # token budgeting, history pruning/summarizing
│  │  ├─ tools/
│  │  │  ├─ types.ts           # Tool interface (schema + execute)
│  │  │  ├─ registry.ts        # tool registration (plugin point)
│  │  │  ├─ fs.ts              # read_file, write_file, edit_file, create_file, list_directory
│  │  │  ├─ search.ts          # search_workspace (ripgrep), get_project_map, get_file_outline
│  │  │  ├─ terminal.ts        # run_command (approval-gated)
│  │  │  └─ git.ts             # git_status, git_diff, git_commit (commit approval-gated)
│  │  ├─ indexer/
│  │  │  ├─ types.ts           # RepoIndex interface (swappable backend)
│  │  │  └─ workspaceIndexer.ts# file map + symbol outlines via VS Code symbol provider
│  │  ├─ edits/
│  │  │  └─ changeSet.ts       # staged multi-file edits, diff preview, apply/reject
│  │  └─ ui/
│  │     ├─ chatViewProvider.ts# webview host, message protocol
│  │     └─ webview/           # chat UI (HTML/CSS/JS): stream, tool log, approvals,
│  │                           #   model dropdown, change-set review
│  ├─ models.json              # model registry (data-driven, no code changes to add models)
│  └─ package.json
├─ ide/                        # fork/distribution layer
│  ├─ product.json             # Pixa branding overrides
│  ├─ build.ps1 / build.sh     # fetch VS Code OSS, apply branding, bundle pixa-agent
│  └─ README.md                # build instructions
├─ docs/
└─ package.json                # workspace root
```

### 2.1 Provider layer (provider-agnostic requirement)

```ts
interface ModelProvider {
  id: string;                                    // "openrouter", "anthropic", "self-hosted"...
  chat(req: ChatRequest, onDelta: (d: StreamDelta) => void, signal: AbortSignal): Promise<ChatResult>;
}
interface ChatRequest { model: string; messages: ChatMessage[]; tools: ToolSchema[]; temperature?: number }
// ChatResult carries assistant text and/or toolCalls; StreamDelta streams text tokens.
```

- `OpenRouterProvider` is the only v1 implementation (OpenAI-compatible `/chat/completions`, SSE streaming, native function calling).
- `models.json` registry entries: `{ id, label, provider, slug, contextWindow, supportsTools }`. Default: GLM current slug (`z-ai/glm-5.2` if live, else newest GLM). Includes free-tier entry, Qwen, DeepSeek, Claude, GPT, Gemini entries out of the box.
- Adding a provider = new class implementing `ModelProvider` + registry entry. IDE/agent code never references a concrete provider.
- API keys per-provider in VS Code `SecretStorage` (never settings/git).

### 2.2 Agent loop

1. Build context: system prompt + project map summary + pruned history + user task.
2. Call provider with tool schemas; stream text into chat.
3. If response contains tool calls → execute via tool registry → append results → goto 2.
4. Terminate on final text, max 30 iterations, or user Stop.
5. All mutations route through ChangeSet (files) or approval gates (commands/commits).

### 2.3 Tools (v1)

| Tool | Behavior |
|---|---|
| `read_file(path, offset?, limit?)` | Returns numbered file content (workspace-relative only) |
| `edit_file(path, old, new)` | Exact-string replacement staged into ChangeSet |
| `write_file(path, content)` / `create_file` | Full write staged into ChangeSet |
| `list_directory(path)` | Entries + type |
| `search_workspace(regex, glob?)` | ripgrep (VS Code bundled) matches with context |
| `get_project_map()` | Indexer: compact file tree + languages |
| `get_file_outline(path)` | Indexer: symbols (classes/functions) via VS Code providers |
| `run_command(cmd, cwd?)` | **Approval-gated**; captured stdout/stderr returned to model |
| `git_status()` / `git_diff(path?)` | Read-only, auto-run |
| `git_commit(message)` | **Approval-gated** |

Path safety: all paths resolved against workspace root; escapes rejected.

### 2.4 Change-set review (multi-file editing)

Agent edits accumulate in an in-memory ChangeSet keyed by file. Chat panel shows the set: per-file diff (VS Code native diff via virtual content provider), **Apply / Reject per file, Apply All**. Nothing touches disk until applied. Applied files are written via `workspace.fs`.

### 2.5 Context manager

Token estimate (chars/4 heuristic). Budget = model contextWindow − reserve. When over budget: drop oldest tool results first, then summarize oldest turns into a synthetic system note. Project map capped (~2k tokens).

### 2.6 Repository indexer

`RepoIndex` interface: `getProjectMap()`, `getFileOutline(path)`, `refresh()`. V1 backend: workspace file scan (respects .gitignore via `workspace.findFiles`) + `vscode.executeDocumentSymbolProvider` for outlines, cached with file-watcher invalidation. Future embedding/vector backend implements the same interface.

### 2.7 IDE distribution layer

- `ide/product.json`: nameShort/nameLong "Pixa IDE", branding fields, `extensionsGallery` (OpenVSX), pixa-agent listed as built-in.
- `ide/build.*`: clones `microsoft/vscode` (OSS) at a pinned tag, applies product.json, copies packaged `pixa-agent` VSIX into built-in extensions, runs the standard OSS build. Long-running; run separately from v1 dev loop.
- Until the branded build is produced, `pixa-agent` runs identically in stock VS Code (F5 dev host / VSIX install) — same code, no divergence.

### 2.8 Extensibility (plugin-based requirement)

- **Tools** register through `ToolRegistry` — future features (MCP client, test-runner, multi-agent dispatch) add tools without touching the loop.
- **Providers** register through the provider registry.
- **Indexer** and **ChangeSet** behind interfaces.
- Webview ⇄ host protocol is a typed message union — new UI capabilities are additive.

## 3. Security

- Keys in SecretStorage; requests over HTTPS to OpenRouter only.
- File ops confined to workspace root.
- Every `run_command` and `git_commit` requires an explicit user click (Run/Skip, Commit/Skip).
- No telemetry in v1.

## 4. Error handling

- Provider/HTTP errors surfaced in chat with retry affordance; tool errors returned to the model as tool results (agent self-corrects); malformed tool args → error result, not crash; loop iteration cap + user Stop button (AbortSignal cancels in-flight request).

## 5. Testing

- `npm run compile` type-clean; unit tests for path safety, edit_file matching, context pruning, models.json parsing (vitest, host-independent modules).
- Manual E2E: F5 dev host against a sample project — task: "add an endpoint + test", verifying index → search → multi-file change set → approval-gated command run → commit flow.

## 6. Success criteria (v1, today)

1. Extension compiles, launches, chat streams from OpenRouter with selected model.
2. Agent completes a real multi-file edit task end-to-end with diff review + approvals.
3. Model switching via dropdown works without reload; adding a model = models.json edit.
4. `ide/` pipeline documented and runnable to produce the branded build.
