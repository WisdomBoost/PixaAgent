# Contributing to Pixa Agent

Thanks for considering a contribution — genuinely. Pixa is young and there's a
lot of room to make a real difference, whether that's a one-line fix or a new
feature.

## Before you start

- **Bug fix or small change?** Just open a PR — no need to ask first.
- **New feature or anything that changes behavior?** Open an issue first to
  discuss the approach. Saves you from building something that doesn't fit the
  project's direction.
- **Found a security issue?** Don't open a public issue — see
  [SECURITY.md](SECURITY.md) instead.

## Project structure

This is an npm-workspaces monorepo:

```
packages/
  pixa-agent/        # the VS Code extension — this is the whole product today
    src/
      agent/         # the agent loop: planning, retries, model fallback
      providers/     # ModelProvider interface + OpenAI-compatible client
      tools/         # what the agent can do: read, edit, search, terminal, git
      edits/         # ChangeSet — staged diffs, the agent never writes disk directly
      indexer/       # semantic search: chunking, vector store, embeddings
      security/      # command policy, secret redaction, audit log
      ui/            # the webview chat panel (vanilla JS, no framework)
    test/            # vitest — mirrors src/ structure
```

## Setup

```bash
git clone https://github.com/WisdomBoost-LLC/PixaAgent.git
cd PixaAgent
npm install
npm run compile -w pixa-agent
```

Press **F5** in VS Code (with the repo root open) to launch an Extension
Development Host with Pixa loaded from source. Run `npm run watch -w pixa-agent`
in a terminal alongside it for live rebuilds — save a file, then `Ctrl+R`
inside the Dev Host window to reload.

## Before you open a PR

```bash
npm run typecheck -w pixa-agent
npm run test:offline -w pixa-agent
```

Both must pass — this is exactly what CI checks on every PR. `test:offline`
runs in about 2 seconds and is what you should use day-to-day. `npm test`
(the full suite) additionally downloads a small embedding model for two test
files; it's slower and can be flaky without solid internet, so it isn't the
day-to-day command.

## How the codebase is organized to work with

- **Pure logic stays free of `vscode` imports.** Anything in `src/providers/`,
  `src/agent/taskGraph.ts`, `src/agent/planning.ts`, etc. takes plain inputs
  and returns plain outputs — no VS Code API, no network, no filesystem. This
  is what makes most of the codebase unit-testable without spinning up an
  editor. If you're adding logic, ask whether it can live in a pure module
  before reaching for `vscode.*`.
- **The webview (`src/ui/webview/`) has no test harness.** It's plain
  JavaScript, not bundled with the extension host, and verified by compile +
  manual testing in the Dev Host — not unit tests. That's a deliberate,
  existing convention, not an oversight.
- **TDD where it applies.** For anything in a pure module: write the failing
  test first, watch it fail, then implement. Existing test files are good
  examples of the style (`test/taskGraph.test.ts`, `test/providerForm.test.ts`).

## Load-bearing rules — don't break these

These aren't style preferences, they're the safety model the whole project
rests on:

- Agent file edits **always** route through `ChangeSet` — the agent must never
  write to disk directly.
- `run_command` and `git_commit` **always** require human approval before
  running.
- All agent file paths are jailed to the open workspace via
  `resolveInWorkspace()` — no reading or writing outside the project folder.
- API keys live only in VS Code's encrypted `SecretStorage`, never in
  `settings.json` or anywhere else on disk.

A PR that weakens any of these needs a very good reason and a very careful
review — flag it explicitly in the PR description if your change touches this
area at all.

## Commit and PR conventions

- Branch per feature/fix: `feat/<name>` or `fix/<name>` off `main`.
- Conventional-ish commit prefixes are used throughout the history:
  `feat:`, `fix:`, `docs:`, `refactor:`, `chore:`, `ci:`. Not strictly
  enforced, but appreciated.
- Keep PRs focused — one concern per PR is easier to review and easier to
  revert if something's wrong.
- Explain the *why* in the PR description, not just the *what* — the diff
  already shows what changed.

## Good first issues

Look for issues labeled `good first issue`. If nothing's labeled yet and
you want to start somewhere, the test suite, docs, and the webview UI are
generally more approachable entry points than the agent loop or provider
internals.

## Code of conduct

Participation in this project is governed by our
[Code of Conduct](CODE_OF_CONDUCT.md). Please read it.
