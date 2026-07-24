# Text Tool-Call Parsing — Design

**Date:** 2026-07-23
**Status:** Approved, ready for planning

## Problem

Some models advertise tool support but, through certain runtimes, return a tool
call as JSON text in the `content` field instead of the OpenAI-native
`tool_calls` field. Verified live against Ollama 0.32.1 with
`qwen2.5-coder:7b`:

```
tool_calls field: ABSENT
content field: "{\"name\": \"list_directory\", \"arguments\": {\"path\": \"./\"}}"
```

The model produced a correct call — the runtime just didn't surface it
natively. Pixa currently detects this shape (`looksLikeUnparsedToolCall`) and
emits an error telling the user the model is "too small", then stops. The
result: capable local coding models (qwen2.5-coder, deepseek-coder, and others
served through Ollama) can't run agent tasks at all, even though they emit
perfectly valid calls.

## Goal

When a model emits a valid, actionable tool call as text, execute it — so local
models work for agent tasks without a model swap or a runtime upgrade.

## Non-goals

- Changing how native `tool_calls` are handled. The native path stays the
  preferred path and is untouched.
- Supporting arbitrary or fuzzy formats. Only strict, well-formed JSON matching
  the shapes real runtimes emit.
- A configuration surface. This is always-on (see Decisions).

## Key safety framing

This executes something the model wrote as free text, so it deserves scrutiny —
but it opens **no new bypass**. A parsed call flows through the exact same
downstream path as a native call:

- File edits still stage a diff via `ChangeSet` — the user still approves each.
- `run_command` / `git_commit` still hit `requestApproval` — the user still
  clicks.
- Only read-only tools (`read_file`, `list_directory`, `search_workspace`, …)
  run without a prompt — identical to native calls.

So the risk is not privilege escalation; it is a **false positive** — executing
JSON the model didn't intend as a call. Three gates make that vanishingly
unlikely (see below).

## Design

### New pure function (`src/agent/taskGraph.ts`)

Lives beside `looksLikeUnparsedToolCall`, no `vscode`/`crypto`/IO, fully
unit-testable.

```ts
export interface ParsedToolCall {
  name: string;
  arguments: string; // raw JSON string, matching ToolCall.arguments
}

export function parseTextToolCalls(
  content: string,
  knownToolNames: ReadonlySet<string>
): ParsedToolCall[];
```

Behavior:

1. Return `[]` immediately unless `looksLikeUnparsedToolCall(content)` is true —
   reuse the existing entry gate (gate #1: strict shape).
2. `JSON.parse` the trimmed content; on failure return `[]`.
3. Accept a single object or an array of objects. For each item, normalize the
   two shapes seen in the wild:
   - bare: `{ "name": "...", "arguments": {...} }`
   - wrapped: `{ "function": { "name": "...", "arguments": {...} } }`
   - `arguments` may also appear as `parameters`; an object is
     `JSON.stringify`-ed, a string is kept as-is, absent becomes `"{}"`.
4. Keep only calls whose `name` is in `knownToolNames` (gate #3: real tool).
   Drop the rest.
5. Return the surviving `ParsedToolCall[]` (possibly empty).

The function does not assign ids — that keeps it pure and crypto-free. The
caller assigns ids.

### Rewire the empty-toolCalls block (`src/agent/loop.ts`, ~lines 216–232)

Current: when `toolCalls` is empty and content looks like a call, emit the
"too small" error and `return`.

New:

```
if (result.toolCalls.length === 0) {
  if (entry.supportsTools && looksLikeUnparsedToolCall(result.content)) {
    const known = new Set(tools.schemas().map(s => s.name));   // gate #3 input
    const parsed = parseTextToolCalls(result.content, known);
    if (parsed.length > 0) {
      result.toolCalls = parsed.map((p, i) => ({
        id: `text-call-${iteration}-${i}`,
        name: p.name,
        arguments: p.arguments,
      }));
      result.content = "";        // extracted as a call; don't also show as text
      // fall through to the existing execution block below — DO NOT return
    } else {
      // unknown tool or unparseable → treat as a normal text answer
      this.history.push({ role: "assistant", content: result.content });
      ctx.emit({ type: "assistant-done" });
      return;
    }
  } else {
    this.history.push({ role: "assistant", content: result.content });
    ctx.emit({ type: "assistant-done" });
    return;
  }
}
// existing block: push assistant turn with toolCalls, execute in batches, loop
```

Gate #2 (native calls absent) is the `toolCalls.length === 0` condition itself —
if the runtime surfaced a native call, we never reach here.

The synthesized-id scheme (`text-call-<iteration>-<index>`) is unique within the
run and pairs each tool result to its call via `toolCallId`, exactly as native
ids do. No `crypto` needed.

Blanking `result.content` matches native behavior (where the call isn't
duplicated in content) and prevents an empty/duplicate assistant bubble via the
existing `if (result.content) ctx.emit(assistant-done)` line.

### What gets deleted

The entire "model too small / imitates tool calls" error branch is removed. Its
job is now covered: a text call to a real tool executes; anything else displays
as plain text. `looksLikeUnparsedToolCall` stays — it's the entry gate.

## Error handling

| Situation | Result |
|---|---|
| Text call, real tool | Parsed, executed, loop continues |
| Text call, unknown/hallucinated tool | Dropped; content shown as a normal answer |
| Malformed JSON that merely resembles a call | `JSON.parse` fails → `[]` → shown as text |
| Legit JSON answer with `name`/`arguments` keys, unknown tool | Dropped by name gate → shown as text (no false execution) |
| Array of calls, some valid some not | Valid ones execute; invalid dropped |
| Native `tool_calls` present | Unchanged — this path never runs |

## Testing

`test/taskGraph.test.ts` (extends the existing file):

- Single bare object naming a real tool → one `ParsedToolCall`, arguments as a
  JSON string.
- Wrapped `{function:{...}}` shape → parsed identically.
- `arguments` given as an object → stringified; as a string → passed through;
  absent → `"{}"`.
- Array of two valid calls → two results, order preserved.
- Unknown tool name → `[]`.
- Array with one known + one unknown → only the known one.
- Non-call JSON (`{"port":8080}`) → `[]` (fails the shape gate).
- Malformed JSON → `[]` (no throw).
- Empty / plain prose → `[]`.

The `loop.ts` rewiring is verified by the existing integration test staying
green plus the live manual check below — consistent with the repo convention
that agent-loop glue is covered by integration + manual, not fine-grained unit
tests.

Full offline suite (`npm run test:offline`) must stay green.

### Live manual verification (the real proof)

1. Ensure Ollama has `qwen2.5-coder:7b` and is running.
2. In Pixa, select `qwen2.5-coder:7b (Ollama)`.
3. Ask: "List the files in this project."
4. Expected before: the "written as plain text… too small" error, no action.
   Expected after: `list_directory` executes, results return, the model
   answers using them.
5. Confirm a native-tool-call model (e.g. `llama3.1:8b`, or an OpenRouter
   model) still behaves exactly as before — no regression on the native path.

## Decisions

**Unknown tool name → treat as plain text** (not an error). Avoids acting on a
hallucinated tool, and a stray JSON answer the user legitimately asked for still
displays instead of being scolded.

**Always on, no setting.** The three gates make it inert for models that already
work (native calls present) and for non-call output (shape/name gates), so there
is nothing to toggle. A setting would be config for an edge that the gates
already neutralize.

**Pure parser, caller assigns ids.** Keeps the tested logic free of `crypto` and
deterministic; ids are a caller concern.
