import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Chunk } from "../src/indexer/chunker.js";

function fakeEmbed(text: string): number[] {
  const dims = 256;
  const vec = new Array(dims).fill(0);
  for (const word of text.toLowerCase().split(/\W+/).filter(Boolean)) {
    let h = 0;
    for (const ch of word) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    vec[h % dims] += 1;
  }
  const norm = Math.sqrt(vec.reduce((a, b) => a + b * b, 0)) || 1;
  return vec.map((v) => v / norm);
}

vi.mock("../src/providers/embeddings.js", () => ({
  embed: vi.fn(async (texts: string[]) => texts.map(fakeEmbed)),
}));

import { VectorStore } from "../src/indexer/vectorStore.js";
import { embed } from "../src/providers/embeddings.js";

describe("VectorStore.query() speed + correctness", () => {
  let workspaceRoot: string;

  beforeEach(() => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pixa-vectorstore-test-"));
  });

  afterEach(() => {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  function writeSourceFile(relPath: string, content: string): void {
    const abs = path.join(workspaceRoot, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }

  function makeChunk(overrides: Partial<Chunk> & Pick<Chunk, "filePath" | "text">): Chunk {
    return {
      id: `${overrides.filePath}:${overrides.startLine ?? 0}:${overrides.endLine ?? 0}`,
      startLine: 0,
      endLine: 0,
      symbolName: null,
      symbolKind: null,
      ...overrides,
    };
  }

  it("returns the semantically relevant chunk quickly, without loading a real model", async () => {
    const retryText = "function retryWithBackoff() { retries failed network requests using exponential backoff }";
    const avatarText = "function renderAvatar() { renders the user profile avatar image widget }";

    writeSourceFile("retry.ts", retryText);
    writeSourceFile("avatar.ts", avatarText);

    const store = new VectorStore(workspaceRoot);
    await store.upsertChunks([
      makeChunk({ filePath: "retry.ts", endLine: 0, symbolName: "retryWithBackoff", text: retryText }),
      makeChunk({ filePath: "avatar.ts", endLine: 0, symbolName: "renderAvatar", text: avatarText }),
    ]);

    const start = Date.now();
    const results = await store.query("exponential backoff retry network requests", 5);
    const elapsedMs = Date.now() - start;

    // Generous ceiling — the point isn't to pin down an exact millisecond
    // budget, it's to catch a regression back to real model loading
    // (multi-second) sneaking into the query path. Mocked embed + a local
    // vectra index over 2 items should be near-instant.
    expect(elapsedMs).toBeLessThan(1000);

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].filePath).toBe("retry.ts");
    expect(results[0].symbolName).toBe("retryWithBackoff");
    // Confirms text is read live from disk (not duplicated in the index).
    expect(results[0].text).toBe(retryText);

    expect(embed).toHaveBeenCalled();
  });

  it("does not include unrelated chunks below the relevance threshold", async () => {
    const retryText = "function retryWithBackoff() { retries failed network requests using exponential backoff }";
    const avatarText = "function renderAvatar() { renders the user profile avatar image widget }";

    writeSourceFile("retry.ts", retryText);
    writeSourceFile("avatar.ts", avatarText);

    const store = new VectorStore(workspaceRoot);
    await store.upsertChunks([
      makeChunk({ filePath: "retry.ts", endLine: 0, symbolName: "retryWithBackoff", text: retryText }),
      makeChunk({ filePath: "avatar.ts", endLine: 0, symbolName: "renderAvatar", text: avatarText }),
    ]);

    const results = await store.query("exponential backoff retry network requests", 5);

    const filePaths = results.map((r) => r.filePath);

    expect(filePaths).not.toContain("avatar.ts");
  });
});