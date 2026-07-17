import "dotenv/config";
import express, { type NextFunction, type Request, type Response } from "express";
import * as fs from "node:fs";
import * as path from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const PORT: number = Number(process.env.PORT) || 8080;
const OPENROUTER_API_KEY: string | undefined = process.env.OPENROUTER_API_KEY;

if (!OPENROUTER_API_KEY) {
  console.error(
    "Missing OPENROUTER_API_KEY. Copy .env.example to .env and fill in your key."
  );
  process.exit(1);
}

/**
 * Phase 3 auth: static allow-list of bearer tokens.
 * Prefer GATEWAY_TOKENS (comma-separated) in .env; optionally GATEWAY_TOKENS_FILE
 * pointing at a JSON array of strings. Empty list = auth disabled (local Phase 1/2).
 */
function loadGatewayTokens(): Set<string> {
  const tokens = new Set<string>();

  const fromEnv = process.env.GATEWAY_TOKENS ?? "";
  for (const part of fromEnv.split(",")) {
    const t = part.trim();
    if (t) tokens.add(t);
  }

  const filePath = process.env.GATEWAY_TOKENS_FILE?.trim();
  if (filePath) {
    const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
    try {
      const raw = JSON.parse(fs.readFileSync(absolute, "utf8")) as unknown;
      if (!Array.isArray(raw) || !raw.every((x) => typeof x === "string")) {
        throw new Error("expected a JSON array of strings");
      }
      for (const t of raw) {
        const trimmed = t.trim();
        if (trimmed) tokens.add(trimmed);
      }
    } catch (err: unknown) {
      console.error(`Failed to load GATEWAY_TOKENS_FILE (${absolute}):`, err);
      process.exit(1);
    }
  }

  return tokens;
}

const GATEWAY_TOKENS = loadGatewayTokens();

function requireGatewayAuth(req: Request, res: Response, next: NextFunction): void {
  if (GATEWAY_TOKENS.size === 0) {
    next();
    return;
  }

  const header = req.header("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  const token = match?.[1]?.trim();
  if (!token || !GATEWAY_TOKENS.has(token)) {
    res.status(401).json({
      error: { message: "Unauthorized. Provide a valid gateway bearer token." },
    });
    return;
  }
  next();
}

const app = express();
app.use(express.json({ limit: "10mb" }));

app.get("/healthz", (_req: Request, res: Response) => {
  res.json({
    ok: true,
    service: "pixa-gateway",
    phase: 3,
    authRequired: GATEWAY_TOKENS.size > 0,
  });
});

/**
 * Proxies chat to OpenRouter. Phase 3 adds optional static-token auth on this route;
 * the OpenRouter key stays server-side only.
 */
app.post("/v1/chat", requireGatewayAuth, async (req: Request, res: Response): Promise<void> => {
  const upstreamController = new AbortController();

  // If the client (extension) disconnects or hits Stop, cancel the
  // upstream request immediately rather than leaving it running.
  req.on("close", () => upstreamController.abort());

  let upstream: globalThis.Response;
  try {
    upstream = await fetch(OPENROUTER_URL, {
      method: "POST",
      signal: upstreamController.signal,
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://pixa.dev",
        "X-Title": "Pixa Gateway",
      },
      body: JSON.stringify(req.body),
    });
  } catch (err: unknown) {
    if (upstreamController.signal.aborted) return; // client already gone
    console.error("Failed to reach OpenRouter:", err);
    res.status(502).json({ error: { message: "Gateway could not reach OpenRouter." } });
    return;
  }

  if (!upstream.ok || !upstream.body) {
    // Forward OpenRouter's status and body as-is for now (Phase 1 has no
    // error-shaping yet — that's worth adding once the dashboard exists).
    const text = await upstream.text().catch(() => "");
    res.status(upstream.status);
    res.setHeader("Content-Type", "application/json");
    res.send(text || JSON.stringify({ error: { message: `Upstream error ${upstream.status}` } }));
    return;
  }

  res.writeHead(upstream.status, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  // upstream.body is a web ReadableStream (native fetch) — convert to a
  // Node Readable so it can be piped with proper backpressure handling,
  // and so it cleans itself up if the client disconnects mid-stream.
  const nodeStream = Readable.fromWeb(upstream.body as NodeWebReadableStream<Uint8Array>);
  nodeStream.pipe(res);

  req.on("close", () => {
    if (!nodeStream.destroyed) nodeStream.destroy();
  });
});

app.listen(PORT, () => {
  console.log(`Pixa gateway (Phase 3) listening on http://localhost:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/healthz`);
  console.log(
    GATEWAY_TOKENS.size > 0
      ? `Auth: ${GATEWAY_TOKENS.size} gateway token(s) configured`
      : "Auth: disabled (set GATEWAY_TOKENS or GATEWAY_TOKENS_FILE to enable)"
  );
});
