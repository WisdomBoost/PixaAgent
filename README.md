# Pixa Agent

An open-source AI coding agent for VS Code. It reads your codebase, plans a
change, edits multiple files, and runs commands — with **every edit shown as a
diff you approve** and **every command gated behind an explicit click**.

Works with **any OpenAI-compatible model**: OpenRouter, NVIDIA NIM, or a model
you host yourself with Ollama, vLLM, LM Studio, or llama.cpp. No vendor
lock-in, no required server, no telemetry.

---

## What it does

| | |
|---|---|
| **Agent tasks** | Describe a task in plain English; Pixa plans it, reads the relevant code, and makes the changes |
| **Review before it lands** | Edits are staged as a change set — view the diff, then Apply, Reject, or Revert per file |
| **You approve commands** | Terminal commands and git commits never run without an explicit click |
| **Semantic code search** | Finds code by meaning ("where do we handle retries"), not just exact text |
| **Project memory** | Notes and decisions persist across chat sessions |
| **Any provider** | Bring your own endpoint and models — including fully local ones |
| **Real cost tracking** | Actual billed cost per request and a running session total |
| **MCP support** | Add third-party tool servers via settings |
| **Chat history** | Past sessions saved, auto-titled, and resumable |

---

## Install

**From a release build:**

```bash
code --install-extension pixa-agent-<version>.vsix
```

**From source:**

```bash
git clone https://github.com/Tanny28/pixa-agent.git
cd pixa-agent
npm install
npm run compile -w pixa-agent
npm run package -w pixa-agent
code --install-extension packages/pixa-agent/pixa-agent-*.vsix
```

Requires Node.js 20+ and VS Code 1.90+.

---

## Quick start

1. Open a project folder in VS Code.
2. Click the **Pixa** icon in the activity bar.
3. Set up a model — either:
   - **Fastest:** `Ctrl+Shift+P` → **Pixa: Set OpenRouter API Key** (free key at
     [openrouter.ai/keys](https://openrouter.ai/keys)), or
   - **Fully local:** configure your own provider — see below.
4. Pick a model from the dropdown and describe what you want.

---

## Using your own provider

Pixa ships with some defaults, but you can add **any OpenAI-compatible
endpoint** through the `pixa.providers` setting. No code changes, no rebuild.

### Self-hosted (Ollama, vLLM, LM Studio, llama.cpp)

Nothing leaves your machine — no API key needed.

```jsonc
// settings.json
"pixa.providers": {
  "ollama": {
    "name": "Ollama (local)",
    "baseUrl": "http://localhost:11434/v1",
    "requiresApiKey": false,
    "models": {
      "qwen2.5-coder": { "name": "Qwen2.5 Coder", "contextWindow": 32768 }
    }
  }
}
```

Start your server (`ollama serve`), reload VS Code, and
**Qwen2.5 Coder (Ollama (local))** appears in the model picker.

> **Tip:** for agent tasks, choose a model that supports tool calling. Chat-only
> models still work for questions — mark them `"supportsTools": false`.

### A hosted provider (NVIDIA NIM, Groq, Together, a company gateway…)

```jsonc
"pixa.providers": {
  "nvidia": {
    "name": "NVIDIA NIM",
    "baseUrl": "https://integrate.api.nvidia.com/v1",
    "models": {
      "z-ai/glm-5.2": { "name": "GLM 5.2", "contextWindow": 128000 }
    }
  }
}
```

Then run **Pixa: Set Provider API Key** and pick `nvidia`. Keys are stored in
VS Code's encrypted secret storage — never in your settings file.

### Config reference

| Field | Required | Meaning |
|---|---|---|
| `baseUrl` | yes | OpenAI-compatible base URL. `/chat/completions` is appended automatically, so either form works. |
| `models` | yes | Map of the provider's model name → display metadata. |
| `name` | no | Display name for the provider. |
| `requiresApiKey` | no | `false` for local servers needing no credentials. Default `true`. |
| `models.<id>.name` | no | Display name. Defaults to the model key. |
| `models.<id>.contextWindow` | no | Token budget. Default `128000`. |
| `models.<id>.supportsTools` | no | `false` for chat-only models. Default `true`. |

Custom models appear as `provider:model` (e.g. `ollama:qwen2.5-coder`) — use
that id for `pixa.defaultModel`.

---

## Settings

| Setting | Purpose |
|---|---|
| `pixa.providers` | Your own providers and models (above) |
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

---

## Safety

- The agent **cannot write to disk** without you clicking Apply.
- Terminal commands and git commits **always** require approval.
- File access is restricted to the open workspace folder.
- API keys live in VS Code secret storage, never in config files.

> **Note:** approved commands run with your normal user permissions — Pixa does
> not sandbox them yet. Review commands before approving, and prefer trusted
> workspaces.

---

## Development

```bash
npm install
npm run compile -w pixa-agent    # build
npm run test -w pixa-agent       # tests
npm run typecheck -w pixa-agent  # types
```

Press **F5** in VS Code to launch an Extension Development Host with Pixa
loaded from source.

Some tests download a small embedding model on first run and need network
access; the rest are offline.

---

## Contributing

Issues and pull requests are welcome. Please keep the test suite green and add
tests for new logic.

## License

[MIT](LICENSE)
