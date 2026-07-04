# Pixa v2 — Design Spec

**Date:** 2026-07-04
**Status:** Approved by stakeholder (all four features selected)
**Driver:** Feature-parity gaps identified in a backend-level comparison with GitHub Copilot agent mode.

## Features

### 1. Editor context + @-file mentions
- Every agent run includes the **active editor file** (workspace-relative path) and the **current selection** (capped ~2000 chars) in the system prompt, refreshed per run.
- `@path` tokens in a chat message attach those files: the host resolves each token against workspace files, reads content (capped ~20000 chars/file, max 5 files), and appends an `<attached-files>` block to the user message. Unresolvable mentions are reported in-line, not fatal.

### 2. Diagnostics self-correction
- New read-only tool `get_diagnostics { path? }` returning VS Code's current compiler/linter diagnostics (severity, file, line, message; warnings and errors only; capped 100 entries).
- System prompt instructs the agent to check diagnostics after its edits are applied and fix its own errors.

### 3. Revert applied changes (checkpoints)
- `FileChange.status` gains `"reverted"`. `ChangeSet` already retains `originalContent`; a new **Revert** action on applied rows writes the original back to disk (or deletes the file if it was newly created), marking the row `reverted`.

### 4. Session persistence
- After each run, the loop history, session cost, and a render-transcript (the UI-visible messages) are saved to `workspaceState`. On panel load the transcript re-renders and the loop continues from saved history. **New Session** clears persisted state. Applies per-workspace.

### 5. MCP server support
- Setting `pixa.mcpServers`: `{ "<name>": { "command": string, "args"?: string[], "env"?: object } }`.
- A minimal **stdio MCP client** (newline-delimited JSON-RPC 2.0, protocol `2024-11-05`): `initialize` → `notifications/initialized` → `tools/list`; each discovered tool registers into the existing `ToolRegistry` as `mcp__<server>__<tool>` and executes via `tools/call` (text content parts concatenated as the result).
- Servers spawn lazily on first agent run, restart is manual (reload window). Failures degrade gracefully: a warning status in chat, agent continues without that server's tools.
- No external SDK dependency; the client is ~180 lines and unit-tested at the framing/correlation level.

## Non-goals for v2
Inline completions, embeddings index, cloud sync, HTTP/SSE MCP transports.
