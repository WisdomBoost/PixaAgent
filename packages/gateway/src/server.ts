import "dotenv/config";
import express, { type Request, type Response } from "express";
import { recordUsage } from "./usageLogger.js";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const PORT: number = Number(process.env.PORT) || 8080;

const app = express();
app.use(express.json({ limit: "10mb" }));

app.get("/healthz", (_req: Request, res: Response) => {
  res.json({ ok: true, service: "pixa-gateway", mode: "byok" });
});

/**
 * Splits an SSE buffer into complete event payloads and the unconsumed tail.
 * Mirrors the parsing logic in the extension's providers/openrouter.ts —
 * duplicated here (rather than shared) since the gateway and the extension
 * are separate packages with no shared module today.
 */
function parseSseChunk(buffer: string): { events: string[]; rest: string } {
  const events: string[] = [];
  const parts = buffer.split(/\r?\n\r?\n/);
  const rest = parts.pop() ?? "";
  for (const part of parts) {
    for (const line of part.split(/\r?\n/)) {
      if (line.startsWith("data: ")) {
        events.push(line.slice(6));
      } else if (line.startsWith("data:")) {
        events.push(line.slice(5).trimStart());
      }
    }
  }
  return { events, rest };
}

app.post("/v1/chat", async (req: Request, res: Response): Promise<void> => {
  const auth = req.header("authorization") ?? "";
  if (!/^Bearer\s+\S+/i.test(auth)) {
    res.status(401).json({
      error: { message: "Missing OpenRouter API key. Send Authorization: Bearer <key>." },
    });
    return;
  }
  const apiKey = auth.replace(/^Bearer\s+/i, "").trim();
  const identityLabel = req.header("x-pixa-identity") || null;
  const model = typeof req.body?.model === "string" ? req.body.model : "unknown";

  const upstreamController = new AbortController();
  req.on("close", () => upstreamController.abort());

  let upstream: globalThis.Response;
  try {
    upstream = await fetch(OPENROUTER_URL, {
      method: "POST",
      signal: upstreamController.signal,
      headers: {
        Authorization: auth,
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

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = "";
  let promptTokens = 0;
  let completionTokens = 0;
  let estimatedCostUsd: number | null = null;
  let sawUsage = false;
  let aborted = false;

  req.on("close", () => {
    aborted = true;
    void reader.cancel().catch(() => {});
  });

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      // Pass the raw bytes through to the client untouched — the gateway
      // must not alter the stream the extension sees.
      res.write(value);

      // Also decode this chunk to look for OpenRouter's usage block.
      sseBuffer += decoder.decode(value, { stream: true });
      const { events, rest } = parseSseChunk(sseBuffer);
      sseBuffer = rest;

      for (const ev of events) {
        if (ev === "[DONE]") continue;
        let parsed: any;
        try {
          parsed = JSON.parse(ev);
        } catch {
          continue; // partial/garbled event — wait for more bytes
        }
        const u = parsed?.usage;
        if (u && typeof u === "object") {
          sawUsage = true;
          if (typeof u.prompt_tokens === "number") promptTokens = u.prompt_tokens;
          if (typeof u.completion_tokens === "number") completionTokens = u.completion_tokens;
          if (typeof u.cost === "number") estimatedCostUsd = u.cost;
        }
      }
    }
  } catch (err) {
    if (!aborted) console.error("Error while streaming upstream response:", err);
  } finally {
    if (!res.writableEnded) res.end();
  }

  // Only log if the client didn't disconnect mid-stream — a request the
  // client abandoned isn't a meaningful usage record. If OpenRouter never
  // sent a usage block (some free models omit it), we still log the
  // request with 0 tokens / null cost rather than silently dropping it,
  // since the request still happened and counts against the model's quota.
  if (!aborted) {
    recordUsage({
      apiKey,
      identityLabel,
      provider: "openrouter",
      model,
      promptTokens,
      completionTokens,
      estimatedCostUsd: sawUsage ? estimatedCostUsd : null,
    });
  }
});

app.listen(PORT, () => {
  console.log(`Pixa gateway (BYOK) listening on http://localhost:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/healthz`);
});