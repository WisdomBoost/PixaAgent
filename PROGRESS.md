# Pixa — Progress Tracker (LOCAL ONLY, gitignored)

> Purpose: context recovery. If the assistant loses context or a new session
> starts cold, reading this file top-to-bottom should be enough to resume work
> without re-asking anything.

**Last updated:** 2026-07-20

---

## 1. What this project is

**Pixa** = a Cursor/Copilot-class AI coding agent, shipped as a **VS Code
extension** (`packages/pixa-agent`). A user describes a task in natural
language; the agent reads the repo, plans, and edits code through tools. Every
file edit is staged as a reviewable diff; every terminal command and git commit
requires explicit human approval.

**End goal:** the company's own production-grade AI coding assistant — going
**open source**. Eventually running on a **self-hosted 60–70B model**, with
cost transparency and no code leaving the user's own infrastructure.

- **Local repo:** `D:\IDE_pixa` (monorepo, npm workspaces)
- **GitHub (public-track repo, will go open source):** https://github.com/Tanny28/pixa-agent
  - `main` is now the **merged, working build** — planning + retrieval +
    parallel execution + checkpointing all in. **v0.5.0.**
  - Local `main` (this machine) is separately ahead: has the NVIDIA provider
    experiment + prompt caching, NOT pushed to the team repo. Intentionally
    kept separate (team works from a clean OpenRouter-first baseline).
- **Owner/git author:** Tanmay Shinde (Tanny28)
- **License:** MIT, already in place (root `LICENSE` + `package.json`),
  present on the team repo. Copyright line currently generic
  (`Copyright (c) 2026 Pixa`) — confirm with sir if it should name a specific
  entity before full public release.

---

## 2. The team, honestly (only 2 people actively executing)

| Person | Tracks | Notes |
|---|---|---|
| **Tanmay (me/user)** | Dev A (Agent System) + Dev C (IDE Integration, not started) | Lead / integrator |
| **Anushree** | Dev B (Retrieval) + Dev D (Gateway) | Doing double duty |
| — | Dev E (Hardening) | **Not started yet** — will be done later, briefed on scope already |

The original 5-person plan is theoretical; in practice 2 people are covering
5 tracks. Plan accordingly — don't assume parallel throughput of 5.

---

## 3. Current state (verified 2026-07-18)

| Item | Value |
|---|---|
| Version | **v0.5.0** (pushed to team `main`, installed locally) |
| Typecheck | **Clean** (`npx tsc --noEmit -p packages/pixa-agent`) |
| Tests | **84/93 passing**, 1 intentionally skipped, **8 failing due to a known network issue** (see §6) — NOT a code defect |
| Team `main` | Has planning (PR #2) + retrieval/memory (PR #1) + parallel/checkpoint (PR #3), all merged |
| Local `main` (this machine) | Ahead of team main — has NVIDIA provider, prompt caching. Not pushed. |
| `feat/gateway` branch | Anushree's Dev D work, unfinished, **not merged, not reviewed further this session** |

### Commands (run from repo root `D:\IDE_pixa`)
```bash
npm run test -w pixa-agent        # vitest — expect 84 pass / 8 network-flake / 1 skip
npx tsc --noEmit -p packages/pixa-agent   # typecheck
npm run compile -w pixa-agent     # esbuild bundle
npm run package -w pixa-agent     # build .vsix
code --install-extension packages/pixa-agent/pixa-agent-<ver>.vsix --force
```

---

## 4. Architecture — the spine (memorize this)

Every feature flows through ONE path:

```
webview (main.js)  →  ChatViewProvider (host)  →  AgentLoop
                                                     │
                          ToolRegistry (local tools) │  ContextManager (budget)
                                                     ▼
                                    ModelProvider → OpenRouter / NVIDIA (cloud)
                                                     │
   main.js renders  ←  ctx.emit(AgentEvent)  ←───────┘
```

**To add any capability:** logic in `loop.ts` → `ctx.emit()` a typed
`AgentEvent` (`src/agent/events.ts`) → add a `case` in `src/ui/webview/main.js`.

### Key files (updated with Dev B + Dev A's new additions)
| Path | Role |
|---|---|
| `src/agent/loop.ts` | Agent loop: retries, model fallback, plan parsing, **parallel tool batching** |
| `src/agent/events.ts` | Typed agent→UI event contract |
| `src/agent/planning.ts` | `parsePlan()` — pure, numbered-list → steps |
| `src/agent/taskGraph.ts` | **NEW** — `isParallelSafe()` allowlist + `groupIntoBatches()` |
| `src/agent/contextManager.ts` | Token budgeting + history pruning (pure) |
| `src/agent/systemPrompt.ts` | Persona + rules + project map |
| `src/providers/types.ts` | `ModelProvider` interface (provider-agnostic seam) |
| `src/providers/openrouter.ts` | OpenAI-compatible client (OpenRouter, NVIDIA via `baseUrl`) |
| `src/providers/embeddings.ts` | **NEW (Dev B)** — embedding provider, `setEmbeddingModel()` for tests |
| `src/tools/` | fs, search, terminal, git, diagnostics, paths (jail) |
| `src/tools/search.ts` | Now also exposes `semantic_search` tool (Dev B) |
| `src/edits/changeSet.ts` | Staged edits (pure) — agent NEVER writes disk directly |
| `src/indexer/types.ts` | `RepoIndex` interface |
| `src/indexer/embeddingIndex.ts` | **NEW (Dev B)** — `EmbeddingIndex implements RepoIndex` |
| `src/indexer/vectorStore.ts`, `chunker.ts`, `indexingPipeline.ts`, `recallBenchmark.ts` | **NEW (Dev B)** — semantic search backend |
| `src/memory/projectMemory.ts`, `src/tools/memory.ts` | **NEW (Dev B)** — persistent cross-session project notes |
| `src/security/redact.ts` | **NEW (Dev B, starting point)** — secret redaction; Dev E should take this over/expand it |
| `src/mcp/` | MCP stdio client |
| `src/ui/chatViewProvider.ts` | Webview host, sessions, approvals, **now calls `onCheckpoint`** |
| `src/ui/webview/main.js` | Chat UI |
| `models.json` | Data-driven model list |

### Load-bearing invariants (do not break)
- Agent file edits ALWAYS route through `ChangeSet` — never write disk directly.
- `run_command` and `git_commit` ALWAYS require human approval.
- All agent file paths jailed to workspace via `resolveInWorkspace()`.
- API keys only in VS Code SecretStorage.
- **NEW:** `edit_file`/`write_file`/`run_command`/`git_commit` and any
  unknown/MCP tool are NEVER parallel-safe (see `taskGraph.ts` allowlist —
  fail closed). Only proven read-only tools may run concurrently.

---

## 5. GitHub branches & PRs — full analysis (as of 2026-07-20)

### Branches
| Branch | Status |
|---|---|
| `main` | ✅ v0.5.0 — has PRs #1, #2, #3 merged (planning, retrieval, parallel exec, checkpointing) |
| `feat/agent-planning` | Merged via PR #2, safe to delete |
| `feat/semantic-search-v2` | Merged via PR #1, safe to delete |
| `feat/task-graph` | Merged via PR #3, safe to delete |
| `feat/gateway` | Anushree's gateway work; superseded by `feat/admin-dashboard` which contains it |
| `feat/admin-dashboard` | **PR #4, OPEN — Anushree. Large (68 files, +10,146/−1,167).** Contains BOTH the gateway AND a full React admin dashboard. ⚠️ **BRANCHED FROM STALE MAIN — see §5b.** |

### PRs
| # | Title | Author | Status |
|---|---|---|---|
| 1 | Semantic search + retrieval benchmark + project memory | Anushree | ✅ **MERGED** |
| 2 | Planning pre-pass + plan card UI | Tanmay | ✅ **MERGED** |
| 3 | Parallel tool execution + checkpointing | Tanmay | ✅ **MERGED** |
| 4 | Feat/admin dashboard (gateway + React dashboard) | Anushree | 🔴 **OPEN — DO NOT MERGE AS-IS** (see §5b) |

## 5b. 🔴 PR #4 review — BLOCKER found (2026-07-20)

**PR #4 branched from commit `1dc0bba`, which predates the merges of PRs #1, #2, #3.**
Its merge-base with `main` is `1dc0bba`; `main` HEAD is `69e612e`. Eight commits
on `main` are missing from PR #4's base, including **ALL of Dev A's work**.

Verified: `packages/pixa-agent/src/agent/` on PR #4 contains only
`contextManager, events, loop, mentions, systemPrompt` — **`planning.ts` and
`taskGraph.ts` are ABSENT**, and `package.json` there says **v0.3.8** (main is
v0.5.0). Merging as-is risks reverting planning pre-pass, plan card UI,
TaskGraph safety policy, parallel tool execution, and checkpointing.

**Required before merge:** Anushree must rebase/merge `main` into
`feat/admin-dashboard` and resolve conflicts, then re-verify. This is a
process problem, not a quality problem — her actual gateway/dashboard code
looks substantial and well-structured.

### Other PR #4 findings (fix alongside the rebase)
- ⚠️ **Build artifacts committed** — must be gitignored & removed from the branch:
  `packages/admin-dashboard/tsconfig.tsbuildinfo`,
  `tsconfig.node.tsbuildinfo`, `vite.config.d.ts`, `src/vite-env.d.ts`
  (`vite-env.d.ts` is arguably legitimate; the two `.tsbuildinfo` files and the
  generated `vite.config.d.ts` are definitely not).
- ✅ No `.env` committed; `.env.example` files present for both packages — good.
- ✅ Uses SQLite (`better-sqlite3`), not MongoDB — matches the guidance given.
- ⚠️ **ARCHITECTURAL CHANGE, needs an explicit decision:** the extension now
  points at a **local gateway by default** (`pixa.gatewayUrl` defaults to
  `http://localhost:8080/v1/chat`, `DEFAULT_GATEWAY_URL` in
  `src/config.ts`). `OpenRouterProvider`'s constructor changed from
  `(getApiKey)` to `(gatewayUrl, getApiKey)`. Error text tells users to run
  `npm start -w pixa-gateway`.
  **Implication for open source:** if the gateway must be running for the
  extension to work at all, every solo user now has to start a server first —
  that contradicts the "clone and it just works" goal. Needs either (a) direct
  provider mode as the default with the gateway opt-in, or (b) a deliberate
  decision that the gateway is required. **Ask Anushree which behaviour she
  intended.**
- Note: PR #4 body is empty — ask for a description before merge.

---

## 6. What's DONE

- ✅ **Dev A (Agent System, Phase 4) — 100% complete, all 5 items merged:**
  planning pre-pass, plan card UI, `TaskGraph` safety policy, parallel tool
  execution, checkpointing.
- ✅ **Dev B (Retrieval, Phase 2) — complete, merged:** `EmbeddingIndex`,
  chunking, vector store, incremental indexing, recall benchmark, semantic
  search tool, **persistent project memory** (was flagged missing, now added).
- ✅ Core product: agent loop, tools, safety rails, multi-model support, cost
  tracking, MCP, session history — all pre-existing, still solid.
- ✅ MIT license in place.
- ✅ No leaked secrets in git history (verified).
- ✅ v0.5.0 built, packaged, installed, and **pushed to team `main`**.

## 7. What's REMAINING

- ⬜ **Dev C (IDE Integration / inline completion)** — not started. Tanmay's
  second track.
- 🟡 **Dev D (Gateway)** — in progress on `feat/gateway`, not finished, not
  merged. Design so far matches the SQLite-default guidance given (no Mongo).
  Needs: finish, typecheck/test, open a PR, review.
- ⬜ **Dev E (Hardening, Phase 1)** — briefed, not started. Should take over
  `src/security/redact.ts` (Dev B's starting point), add adversarial security
  tests, audit logging. **Higher priority now that the repo is going public.**
- 🟡 **Known test issue (not a code bug):** `Vector.test.ts` and
  `embeddings.test.ts` download a real small embedding model
  (`Xenova/all-MiniLM-L6-v2`) from Hugging Face on first run. In this session's
  sandboxed environment, that download reliably failed 3/3 times with a
  network-level `SocketError: other side closed` partway through (not a logic
  error — everything else, 84 tests, passes clean). **Action for Dev B/E:**
  either (a) vendor/cache the tiny model file in the repo so tests never hit
  the network, or (b) mock the embedding provider for the default fast test
  run and gate real-model tests behind an opt-in flag, same pattern already
  used for `Vectorstore.manual.smoke.test.ts` (already skipped by default).
  This matters more once this is public — contributors' CI shouldn't be flaky
  because of a live model download.
- ⬜ **Public-facing README** — current README is team-onboarding-oriented;
  needs a rewrite for external open-source users before wide release.
- ⬜ **Sandboxing** (part of Dev E's scope) — no command sandboxing yet; real
  risk once strangers run this on their own repos.
- ⬜ Copyright line in LICENSE — confirm entity name with sir.
- 💡 **Discussed, deferred:** OpenCode-style user-configurable providers
  (user points Pixa at their own gateway/provider via config) — natural fit
  given the existing `ModelProvider`/`baseUrl` pattern, revisit after current
  tracks land.

---

## 8. Working conventions (follow these)

- **TDD**: write the failing test FIRST, watch it fail, then implement.
- **Branch per feature**: `feat/<name>` off `main`, PR + merge when tested.
- **Test gate**: full suite should be green before merge — with the one
  documented exception above (network-dependent embedding tests).
- **Pure modules are the testable core** — keep vscode/network out of logic.
- 🚨 **NO `Co-Authored-By: Claude` trailer in commits.** Enforced all session.
- The webview (`main.js`) has **no unit-test harness** — verified by compile +
  install + manual look.

---

## 9. Hard-won gotchas (don't re-litigate these)

- **OpenRouter free tier**: 20 req/min + 50/day, global per account. Wait, don't
  hop, or pay. Free `:free` slugs get retired often.
- **GLM 5.2 free on NVIDIA NIM = WORKS but takes 198–298s** per request. Not
  blocked — just slow (free queue). Playground is fast because it's a
  different, prioritized backend the public API can't reach.
- **Embedding-model download in tests is network-flaky in sandboxed
  environments** (see §7) — new gotcha from this session, same category of
  issue as the above (external network dependency in a constrained sandbox).
- **`usage: {include:true}`** is OpenRouter-specific — only sent when
  `id === "openrouter"`.
- **Recommendation repeatedly reached**: for real work use paid GLM 5.2 on
  OpenRouter (~$0.02/task, fast, no queue).
- **Gateway storage decision**: SQLite by default (zero setup, open-source
  friendly), Mongo/Postgres as an optional pluggable swap — same interface
  pattern as `ModelProvider`. Anushree's `feat/gateway` branch already follows
  this (uses `better-sqlite3`, not MongoDB).

---

## 10. Next action

1. 🔴 **HIGHEST PRIORITY — reply to Anushree about PR #4** (see §5b):
   - Ask her to **rebase/merge `main` into `feat/admin-dashboard`** — it's
     branched from a pre-merge commit and currently omits all of Dev A's work.
   - Ask her to remove the committed build artifacts (`*.tsbuildinfo`,
     generated `vite.config.d.ts`) and gitignore them.
   - Ask the **design question**: is the gateway meant to be *required*, or
     should direct-provider remain the default with the gateway opt-in?
     This matters a lot for the open-source "just works" experience.
   - Ask for a PR description (body is empty).
2. **Start Dev C** (Tanmay) — inline completion, `InlineCompletionItemProvider`,
   <300ms p50 latency budget target.
3. **Kick off Dev E** — starting point: `src/security/redact.ts`,
   `src/tools/paths.ts`, `src/tools/terminal.ts`. Higher priority now, repo is
   going public.
4. Fix the network-flaky embedding tests (mock or vendor the model) — small,
   should be quick, prevents future contributor confusion.
5. Open-source prep still outstanding: public README, CONTRIBUTING.md,
   SECURITY.md, confirm LICENSE copyright entity.
