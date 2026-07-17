/**
 * Shared gateway configuration constants.
 *
 * Deliberately has no `vscode` import so it stays importable from
 * `providers/openrouter.ts`, which is otherwise vscode-agnostic and unit-testable
 * in isolation. Anything that needs live VS Code settings (`pixa.gatewayUrl`)
 * reads that directly via `vscode.workspace.getConfiguration("pixa")` at the
 * call site and falls back to DEFAULT_GATEWAY_URL below.
 */

/** VS Code Secret Storage key for the gateway auth token. Replaces the old `pixa.openrouter.apiKey`. */
export const GATEWAY_TOKEN_SECRET = "pixa.gateway.token";

/**
 * Fallback used until the user sets `pixa.gatewayUrl`. Matches the route exposed by
 * the Phase 1 gateway (packages/gateway/src/server.ts: `POST /v1/chat`).
 */
export const DEFAULT_GATEWAY_URL = "http://localhost:8080/v1/chat";
