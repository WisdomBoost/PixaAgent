import "dotenv/config";
import express, { type Request, type Response } from "express";
import { initDatabase } from "./db.js";
import { checkModelPolicy } from "./policyEngine.js";
import { recordUsage } from "./usageLogger.js";
import adminRoutes from "./admin/routes.js";
import { getOrGenerateAdminKey, getAdminKeyPath } from "./adminKey.js";

const OPENROUTER_URL = process.env.OPENROUTER_URL || "https://openrouter.ai/api/v1/chat/completions";
const PORT: number = Number(process.env.PORT) || 8080;

const app = express();
app.use(express.json({ limit: "10mb" }));

// Initialize SQLite on startup (Phase 4 & 5 tables)
initDatabase();

// Basic request logging
app.use((req: Request, _res: Response, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

app.get("/healthz", (_req: Request, res: Response) => {
  res.json({ ok: true, service: "pixa-gateway", mode: "byok", phase: "4+5" });
});

/**
 * Split an SSE buffer into complete event payloads (the part after "data: ")
 * and the unconsumed tail. Reused from the extension's openrouter.ts.
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

/**
 * Stateless BYOK proxy with Phase 5 policy enforcement:
 * 1. Extract Authorization bearer and optional X-Pixa-Identity
 * 2. Check model policy (reject 403 if disallowed)
 * 3. Forward to OpenRouter
 * 4. Tee-stream response back while parsing for usage
 * 5. Record usage (Phase 4) after stream completes
 */
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

  console.log(
    `[CHAT] identity="${identityLabel}" model="${model}" auth_key_length=${apiKey.length}`
  );

  // --- Phase 5: Policy check before forwarding to OpenRouter ---
  const policyCheck = checkModelPolicy(identityLabel, model);
  if (!policyCheck.allowed) {
    console.log(`[POLICY] Rejected: ${policyCheck.reason}`);
    res.status(403).json({
      error: {
        message: policyCheck.reason || `Model "${model}" is not allowed.`,
        code: "MODEL_BLOCKED",
      },
    });
    return;
  }

  // Abort upstream only when the *client* drops the connection mid-flight.
  // Do NOT use req.on("close") after express.json() — that fires even for
  // successful completions and would abort OpenRouter immediately.
  const upstreamController = new AbortController();
  const abortUpstreamIfClientGone = () => {
    if (!res.writableFinished) upstreamController.abort();
  };
  res.on("close", abortUpstreamIfClientGone);

  let upstream: globalThis.Response;
  try {
    console.log(`[DEBUG] Forwarding to OpenRouter...`);
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
    console.log(`[DEBUG] OpenRouter responded with ${upstream.status}`);
  } catch (err: unknown) {
    if (upstreamController.signal.aborted) {
      console.log(`[DEBUG] Request aborted (client disconnected).`);
      return;
    }
    console.error("[ERROR] Failed to reach OpenRouter:", err);
    res.status(502).json({ error: { message: "Gateway could not reach OpenRouter." } });
    return;
  }

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    console.log(`[DEBUG] Non-OK response from OpenRouter: ${upstream.status}`);
    res.status(upstream.status);
    res.setHeader("Content-Type", "application/json");
    res.send(text || JSON.stringify({ error: { message: `Upstream error ${upstream.status}` } }));
    return;
  }

  console.log(`[DEBUG] Starting SSE stream...`);

  res.writeHead(upstream.status, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  // --- Phase 4: Tee-stream while parsing for usage ---
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = "";
  let promptTokens = 0;
  let completionTokens = 0;
  let estimatedCostUsd: number | null = null;
  let sawUsage = false;
  let completedNormally = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        completedNormally = true;
        console.log(
          `[DEBUG] Stream completed. tokens=${promptTokens}/${completionTokens} cost=${estimatedCostUsd}`
        );
        break;
      }

      // Write raw bytes to client in real time.
      res.write(value);

      // Parse SSE to extract usage.
      sseBuffer += decoder.decode(value, { stream: true });
      const { events, rest } = parseSseChunk(sseBuffer);
      sseBuffer = rest;

      for (const ev of events) {
        if (ev === "[DONE]") continue;
        let parsed: any;
        try {
          parsed = JSON.parse(ev);
        } catch {
          continue;
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
    if (!completedNormally) console.error("[ERROR] Stream error:", err);
  } finally {
    if (!res.writableEnded) res.end();
  }

  console.log(`[DEBUG] Handler exit. completedNormally=${completedNormally}`);

  // Record usage only if stream completed successfully
  if (completedNormally) {
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

// --- Phase 5: Admin API ---
app.use("/admin", adminRoutes);

app.listen(PORT, () => {
  console.log(`Pixa gateway (BYOK, Phase 4+5) listening on http://localhost:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/healthz`);
  const adminKey = getOrGenerateAdminKey();
  console.log(`Admin API: http://localhost:${PORT}/admin (requires API key from ${getAdminKeyPath()})`);
});