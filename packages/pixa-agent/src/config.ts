/**
 * Shared gateway configuration constants.
 *
 * Deliberately has no `vscode` import so it stays importable from
 * `providers/openrouter.ts`, which is otherwise vscode-agnostic and unit-testable
 * in isolation. Anything that needs live VS Code settings (`pixa.gatewayUrl`)
 * reads that directly via `vscode.workspace.getConfiguration("pixa")` at the
 * call site and falls back to DEFAULT_GATEWAY_URL below.
 */

/** VS Code Secret Storage key for the user's OpenRouter API key (Bring Your Own Key). */
export const OPENROUTER_API_KEY_SECRET = "pixa.openrouter.apiKey";

/**
 * Fallback used until the user sets `pixa.gatewayUrl`. Matches the route exposed by
 * the gateway (packages/gateway/src/server.ts: `POST /v1/chat`).
 */
export const DEFAULT_GATEWAY_URL = "http://localhost:8080/v1/chat";
