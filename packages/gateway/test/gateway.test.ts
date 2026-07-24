import { describe, it, beforeAll, afterAll, expect } from "vitest";
import http from "node:http";
import * as path from "node:path";
import * as fs from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";

const TEST_PORT = 8081;
const MOCK_UPSTREAM_PORT = 9091;

const tempDir = path.join(process.cwd(), ".test-run");
const testDbPath = path.join(tempDir, "test-gateway.db");
const testAdminKey = "test-secret-admin-key";

let mockUpstreamServer: http.Server;
let gatewayProcess: ChildProcess;

describe("Pixa Gateway Integration Test", () => {
  beforeAll(async () => {
    // 1. Clean and create temporary folder
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    fs.mkdirSync(tempDir, { recursive: true });

    // 2. Set environment variables to run gateway in test mode
    process.env.PORT = String(TEST_PORT);
    process.env.USAGE_DB_PATH = testDbPath;
    process.env.ADMIN_API_KEY = testAdminKey;
    process.env.OPENROUTER_URL = `http://localhost:${MOCK_UPSTREAM_PORT}`;

    // 3. Start mock OpenRouter upstream server on port 9091
    const mockChunks = [
      { choices: [{ delta: { content: "Hello" } }] },
      { choices: [{ delta: { content: " test" } }] },
      {
        choices: [{ delta: { content: " response." }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.0002 },
      },
    ];

    mockUpstreamServer = http.createServer((req, res) => {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      let i = 0;
      const interval = setInterval(() => {
        if (i >= mockChunks.length) {
          res.write("data: [DONE]\n\n");
          res.end();
          clearInterval(interval);
          return;
        }
        res.write(`data: ${JSON.stringify(mockChunks[i])}\n\n`);
        i++;
      }, 50);
    });

    await new Promise<void>((resolve) => {
      mockUpstreamServer.listen(MOCK_UPSTREAM_PORT, () => resolve());
    });

    // 4. Start the gateway server in a separate process
    let exited = false;
    let spawnError: any = null;
    gatewayProcess = spawn("node", ["--import", "tsx", "src/server.ts"], {
      env: {
        ...process.env,
      },
    });

    gatewayProcess.on("error", (err) => {
      spawnError = err;
    });

    gatewayProcess.on("exit", (code) => {
      exited = true;
    });

    // Pipe outputs to console for debugging test
    gatewayProcess.stdout?.on("data", (data) => console.log(`[GW-stdout] ${data}`));
    gatewayProcess.stderr?.on("data", (data) => console.error(`[GW-stderr] ${data}`));

    // Wait for the gateway to boot (poll healthz)
    const start = Date.now();
    const timeout = 10000;
    while (Date.now() - start < timeout) {
      if (spawnError) {
        throw new Error(`Failed to spawn gateway process: ${spawnError.message}`);
      }
      if (exited) {
        throw new Error("Gateway process exited early during test boot.");
      }
      try {
        const res = await fetch(`http://localhost:${TEST_PORT}/healthz`);
        if (res.ok) break;
      } catch {
        // ignore and poll again
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  });

  afterAll(async () => {
    // Stop the gateway
    if (gatewayProcess) {
      await new Promise<void>((resolve) => {
        if (gatewayProcess.exitCode !== null) {
          resolve();
          return;
        }
        gatewayProcess.on("exit", () => resolve());
        gatewayProcess.kill();
      });
    }

    // Stop mock upstream
    if (mockUpstreamServer) {
      await new Promise<void>((resolve) => mockUpstreamServer.close(() => resolve()));
    }

    // Clean up temporary folder
    if (fs.existsSync(tempDir)) {
      await new Promise((r) => setTimeout(r, 200));
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch (err) {
        console.error(`Failed to clean up temp dir ${tempDir}:`, err);
      }
    }
  });

  it("should respond to health check", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/healthz`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.ok).toBe(true);
    expect(data.service).toBe("pixa-gateway");
  });

  it("should enforce admin authentication", async () => {
    // Request without Authorization header
    let res = await fetch(`http://localhost:${TEST_PORT}/admin/identities`);
    expect(res.status).toBe(401);

    // Request with invalid API key
    res = await fetch(`http://localhost:${TEST_PORT}/admin/identities`, {
      headers: { Authorization: "Bearer wrong-key" },
    });
    expect(res.status).toBe(401);

    // Request with correct API key
    res = await fetch(`http://localhost:${TEST_PORT}/admin/identities`, {
      headers: { Authorization: `Bearer ${testAdminKey}` },
    });
    expect(res.status).toBe(200);
    const identities = (await res.json()) as any[];
    expect(Array.isArray(identities)).toBe(true);
  });

  it("should register identities and policies via Admin API", async () => {
    // 1. Create a new identity
    let res = await fetch(`http://localhost:${TEST_PORT}/admin/identities`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${testAdminKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: "test-org",
        name: "Test Organization",
        metadata: { tier: "developer" },
      }),
    });
    expect(res.status).toBe(201);
    const identity = (await res.json()) as any;
    expect(identity.id).toBe("test-org");

    // 2. Add model policy
    res = await fetch(`http://localhost:${TEST_PORT}/admin/identities/test-org/policy/allow`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${testAdminKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "openai/gpt-4-turbo" }),
    });
    expect(res.status).toBe(200);

    // 3. Verify policy allowed check
    res = await fetch(`http://localhost:${TEST_PORT}/admin/check-policy`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${testAdminKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ identity_id: "test-org", model: "openai/gpt-4-turbo" }),
    });
    expect(res.status).toBe(200);
    const checkResult = (await res.json()) as any;
    expect(checkResult.allowed).toBe(true);
  });

  it("should block request if identity policy blocks the model", async () => {
    // 1. Block a model
    let res = await fetch(`http://localhost:${TEST_PORT}/admin/identities/test-org/policy/block`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${testAdminKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "google/gemini-pro" }),
    });
    expect(res.status).toBe(200);

    // 2. Perform chat proxy call on blocked model - should reject 403 before calling upstream
    res = await fetch(`http://localhost:${TEST_PORT}/v1/chat`, {
      method: "POST",
      headers: {
        Authorization: "Bearer mock-openrouter-key",
        "Content-Type": "application/json",
        "X-Pixa-Identity": "test-org",
      },
      body: JSON.stringify({ model: "google/gemini-pro", messages: [{ role: "user", content: "test" }] }),
    });
    expect(res.status).toBe(403);
    const errorBody = (await res.json()) as any;
    expect(errorBody.error.code).toBe("MODEL_BLOCKED");
  });

  it("should stream and record usage logs on successful completions", async () => {
    // 1. Send chat request to allowed model
    const res = await fetch(`http://localhost:${TEST_PORT}/v1/chat`, {
      method: "POST",
      headers: {
        Authorization: "Bearer mock-openrouter-key",
        "Content-Type": "application/json",
        "X-Pixa-Identity": "test-org",
      },
      body: JSON.stringify({
        model: "openai/gpt-4-turbo",
        messages: [{ role: "user", content: "test" }],
      }),
    });
    expect(res.status).toBe(200);

    // 2. Read full response stream
    const reader = res.body?.getReader();
    const decoder = new TextDecoder();
    let responseText = "";

    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      responseText += decoder.decode(value, { stream: true });
    }

    expect(responseText).toContain("Hello");
    expect(responseText).toContain("response.");

    // 3. Verify usage was recorded in database
    const usageRes = await fetch(`http://localhost:${TEST_PORT}/admin/usage/summary`, {
      headers: { Authorization: `Bearer ${testAdminKey}` },
    });
    expect(usageRes.status).toBe(200);
    const summary = (await usageRes.json()) as any;
    expect(summary.totals.total_requests).toBeGreaterThanOrEqual(1);
    expect(summary.totals.total_prompt_tokens).toBe(10);
    expect(summary.totals.total_completion_tokens).toBe(5);
  });
});
