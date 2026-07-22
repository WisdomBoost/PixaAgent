<div align="center">

<img src="https://raw.githubusercontent.com/WisdomBoost-LLC/PixaAgent/main/docs/banner.png" alt="Pixa Agent" width="100%">

# Pixa Agent

**Your AI coding agent. Your models. Your machine.**

An open-source AI coding agent for VS Code that plans, reads your codebase, and
edits multiple files — with every change staged as a diff you approve.
Point it at OpenRouter, your company gateway, or a model running on your own
laptop. No vendor lock-in. No telemetry. No required server.

[![CI](https://github.com/WisdomBoost-LLC/PixaAgent/actions/workflows/ci.yml/badge.svg)](https://github.com/WisdomBoost-LLC/PixaAgent/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![VS Code](https://img.shields.io/badge/VS%20Code-1.90+-blue.svg)](https://code.visualstudio.com/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

</div>

---

## Why Pixa?

Most AI coding assistants decide which model you use and where your code goes.
Pixa doesn't.

| | Pixa | Typical closed assistant |
|---|---|---|
| **Choose your model** | Any OpenAI-compatible endpoint | Vendor's model only |
| **Run fully offline** | Yes — point it at Ollama/vLLM/LM Studio | No |
| **See what it costs** | Real billed cost, per request | Opaque or subscription |
| **Code leaves your machine** | Only if you choose a cloud model | Always |
| **Read the source** | MIT, all of it | No |

If you can host a model, Pixa can use it — and your code never leaves your
network.

---

## What it does

- **Agent tasks** — describe a goal in plain English; Pixa plans it, reads the
  relevant code, and makes the changes.
- **Nothing lands without approval** — edits are staged as a change set. View
  the diff, then Apply, Reject, or Revert per file.
- **Commands are gated** — terminal commands and git commits never run without
  an explicit click.
- **Add any provider from the UI** — presets for Ollama, LM Studio, vLLM, and
  NVIDIA NIM, or add a custom endpoint. Pixa asks your server which models it
  has, so you don't guess at model names.
- **Semantic code search** — find code by meaning ("where do we handle
  retries"), not just exact text. Optional; see [Current status](#current-status).
- **Real cost tracking** — actual billed cost per request and a running session
  total, when your provider reports it.
- **Project memory** — notes and decisions persist across chat sessions.
- **MCP support** — connect third-party tool servers.

---

## Install

**From a release build:**

```bash
code --install-extension pixa-agent-<version>.vsix
```

**From source:**

```bash
git clone https://github.com/WisdomBoost-LLC/PixaAgent.git
cd PixaAgent
npm install
npm run compile -w pixa-agent
npm run package -w pixa-agent
code --install-extension packages/pixa-agent/pixa-agent-*.vsix --force
```

Requires **Node.js 20+** and **VS Code 1.90+**.

---

## Quick start

1. Open a project folder in VS Code.
2. Click the **Pixa** icon in the activity bar.
3. Set up a model — pick one:

   **Fastest — a hosted model**
   `Ctrl+Shift+P` → **Pixa: Set OpenRouter API Key**
   (free key at [openrouter.ai/keys](https://openrouter.ai/keys))

   **Fully local — nothing leaves your machine**
   Install [Ollama](https://ollama.com), then:
   ```bash
   ollama pull qwen2.5-coder:7b
   ```
   In Pixa, click the **⚙** icon → **Ollama** preset → **Fetch models** →
   select your model → **Add provider** → **Reload window**.

4. Pick your model from the dropdown and describe what you want.

> **Model size matters for agent work.** Models under ~7B often *imitate* tool
> calls as plain text instead of making real ones, so the agent appears to do
> nothing. Pixa detects this and tells you. For editing and running commands,
> use a 7B+ model; smaller ones are fine for chat.

---

## Using your own provider

Everything is configurable from the **⚙ Providers** panel — no JSON editing
required. Prefer config files? The same settings live in `pixa.providers`:

```jsonc
// settings.json
"pixa.providers": {
  "ollama": {
    "name": "Ollama (local)",
    "baseUrl": "http://localhost:11434/v1",
    "requiresApiKey": false,
    "models": {
      "qwen2.5-coder:7b": { "name": "Qwen2.5 Coder 7B", "contextWindow": 32768 }
    }
  }
}
```

Anything speaking the OpenAI chat-completions API works: **Ollama, vLLM,
LM Studio, llama.cpp, NVIDIA NIM, Groq, Together, or your own gateway.**

### Config reference

| Field | Required | Meaning |
|---|---|---|
| `baseUrl` | yes | OpenAI-compatible base URL. `/chat/completions` is appended automatically. |
| `models` | yes | Map of the provider's model name → display metadata. |
| `name` | no | Display name for the provider. |
| `requiresApiKey` | no | `false` for local servers needing no credentials. Default `true`. |
| `models.<id>.name` | no | Display name. Defaults to the model key. |
| `models.<id>.contextWindow` | no | Token budget. Default `128000`. |
| `models.<id>.supportsTools` | no | `false` for chat-only models. Default `true`. |

Custom models appear as `provider:model` (e.g. `ollama:qwen2.5-coder:7b`) —
use that id for `pixa.defaultModel`.

API keys are stored in VS Code's encrypted secret storage, never in your
settings file.

### Settings

| Setting | Purpose |
|---|---|
| `pixa.providers` | Your own providers and models |
| `pixa.defaultModel` | Model selected on startup |
| `pixa.maxTokens` | Max completion tokens per request |
| `pixa.mcpServers` | MCP tool servers to connect |

---

## How it works

```
Chat panel  →  Agent loop  →  your chosen model (the only outbound call)
                   │
                   ├─ Tools: read, search, edit, terminal, git, diagnostics
                   ├─ Index: file map, symbols, semantic search
                   └─ Every edit → staged change set → you approve → disk
```

Everything except the model request runs locally. Independent read-only tools
run in parallel; anything that changes state runs one at a time, in order.

Pixa is provider-agnostic by construction: the agent and UI only ever talk to a
`ModelProvider` interface, so adding a backend never touches agent logic.

---

## Current status

Pixa is **usable today** and we run it on its own codebase — but it's young,
and we'd rather you know exactly where the edges are.

**Solid**
- Agent loop, planning, multi-file editing with diff approval
- Provider system — hosted and self-hosted, configurable from the UI
- Cost tracking, chat history, MCP, project memory
- 131 tests passing offline

**Early / rough**
- **Semantic search is optional and off by default.** It needs
  `@huggingface/transformers` (~150MB plus a native binary), which is too large
  to bundle. Without it, everything else works normally — you just lose
  meaning-based search.
- **The UI is functional, not beautiful.** A visual overhaul is underway.
- **Small local models are unreliable for agent tasks** (see the note in Quick
  start). Pixa detects and explains this, but can't fix it.

**Not built yet**
- Inline completion (ghost text) — designed, not implemented
- Command sandboxing — **see Security below**

We'd rather ship an honest README than a flattering one. If something here is
wrong or out of date, that's a bug — please [open an issue](https://github.com/WisdomBoost-LLC/PixaAgent/issues).

---

## Security

**What protects you today:**
- The agent **cannot write to disk** without you clicking Apply.
- Terminal commands and git commits **always** require explicit approval.
- **Known-destructive commands are hard-blocked** — patterns like `rm -rf /`,
  `curl … | sh`, disk-overwrite, and force-push to `main` are refused before
  you're even asked, so they can't slip through an over-eager Approve.
- File access is restricted to the open workspace folder.
- API keys live in VS Code secret storage, never in config files.

> ⚠️ **Approved commands still run with your normal user permissions.** The
> command policy is a guardrail against careless destruction, not a hard
> boundary against a deliberately adversarial model — it's pattern-based and
> won't catch obfuscated commands. Read commands before approving them, and
> prefer trusted workspaces.

Found a security issue? Please report it privately — see [SECURITY.md](SECURITY.md).

---

## Contributing

Contributions are genuinely welcome, and good first issues are labelled as such.

```bash
npm install
npm run compile -w pixa-agent       # build
npm run test:offline -w pixa-agent  # fast test suite (~2s)
npm run typecheck -w pixa-agent     # types
```

Press **F5** in VS Code to launch an Extension Development Host with Pixa
loaded from source.

**Two things to know:**
- `npm test` runs the full suite, which downloads a small embedding model and
  can be slow or flaky offline. Use `npm run test:offline` for day-to-day work —
  it's what CI gates on.
- Keep pure logic free of `vscode` imports. That separation is why most of the
  codebase is unit-testable.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full guide.

---

## License

[MIT](LICENSE) — use it, fork it, ship it.

<div align="center">
<sub>Built by <a href="https://github.com/WisdomBoost-LLC">Pixaflip Technologies</a></sub>
</div>
