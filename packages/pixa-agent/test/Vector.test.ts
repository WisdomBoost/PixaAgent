import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { VectorStore } from "../src/indexer/vectorStore";
import { setEmbeddingModel, embeddingCache } from "../src/providers/embeddings";
import type { Chunk } from "../src/indexer/chunker";

function makeChunk(overrides: Partial<Chunk>): Chunk {
  return {
    id: `${overrides.filePath}:${overrides.startLine}:${overrides.endLine}`,
    filePath: "a.ts",
    startLine: 0,
    endLine: 5,
    symbolName: null,
    symbolKind: null,
    text: "placeholder",
    ...overrides,
  };
}

describe("VectorStore", { timeout: 120000 }, () => {
  let workspaceRoot: string;
  let store: VectorStore;

  beforeAll(() => {
    setEmbeddingModel("Xenova/all-MiniLM-L6-v2"); // fast model for CI
  });

  beforeEach(() => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pixa-vecstore-"));
    store = new VectorStore(workspaceRoot);
    embeddingCache.clear();
  });

  afterAll(() => {
    // best-effort cleanup of temp dirs is left to the OS; not critical for CI
  });

  it("creates the .pixa/index folder and adds .pixa/ to .gitignore", async () => {
    await store.size(); // forces init to complete
    expect(fs.existsSync(path.join(workspaceRoot, ".pixa", "index"))).toBe(true);
    const gitignore = fs.readFileSync(path.join(workspaceRoot, ".gitignore"), "utf8");
    expect(gitignore).toContain(".pixa/");
  });

  it("does not duplicate on re-upsert of an unchanged chunk (idempotent by id)", async () => {
    const chunk = makeChunk({
      filePath: "a.ts",
      startLine: 0,
      endLine: 3,
      symbolName: "foo",
      text: "function foo() { return 1; }",
    });

    await store.upsertChunks([chunk]);
    expect(await store.size()).toBe(1);

    await store.upsertChunks([chunk]); // same id, same content
    expect(await store.size()).toBe(1); // still 1, not 2
  });

  it("ranks results sensibly for a hand-verifiable query across two files", async () => {
    const chunks: Chunk[] = [
      makeChunk({
        filePath: "auth.ts",
        startLine: 0,
        endLine: 10,
        symbolName: "retryWithBackoff",
        text: "function retryWithBackoff(fn) { // retries a failing request with exponential backoff and jitter }",
      }),
      makeChunk({
        filePath: "auth.ts",
        startLine: 12,
        endLine: 20,
        symbolName: "login",
        text: "function login(user, pass) { // authenticates a user against the auth server }",
      }),
      makeChunk({
        filePath: "ui.ts",
        startLine: 0,
        endLine: 8,
        symbolName: "renderButton",
        text: "function renderButton(props) { // renders a styled button component in the UI }",
      }),
    ];
    await store.upsertChunks(chunks);

    const results = await store.query("where do we retry failed requests with backoff", 3);

    expect(results.length).toBeGreaterThan(0);
    // The retry/backoff chunk should be the top hit, not the unrelated UI chunk.
    expect(results[0].symbolName).toBe("retryWithBackoff");
    expect(results.find((r) => r.symbolName === "renderButton")).toBeUndefined();
  });

  it("removes a file's chunks from query results after deleteChunksForFile", async () => {
    const chunk = makeChunk({
      filePath: "temp.ts",
      startLine: 0,
      endLine: 4,
      symbolName: "tempFn",
      text: "function tempFn() { // does something temporary and specific }",
    });
    await store.upsertChunks([chunk]);

    let results = await store.query("does something temporary and specific", 5);
    expect(results.some((r) => r.filePath === "temp.ts")).toBe(true);

    await store.deleteChunksForFile("temp.ts");

    results = await store.query("does something temporary and specific", 5);
    expect(results.some((r) => r.filePath === "temp.ts")).toBe(false);
  });

  it("finds semantic-indexing code for a conceptual workspace query", async () => {
    const chunkText = [
      "export async function indexWorkspaceWithProgress(",
      "  workspaceRoot: string,",
      "  vectorStore: VectorStore",
      "): Promise<{ filesIndexed: number; filesSkipped: number; chunksIndexed: number }> {",
      "  return vscode.window.withProgress(",
      "    {",
      "      location: vscode.ProgressLocation.Notification,",
      '      title: "Pixa: indexing workspace for semantic search",',
      "      cancellable: false,",
      "    },",
      "    async (progress) => {",
      "      return indexWorkspace(workspaceRoot, vectorStore);",
      "    }",
      "  );",
      "}",
    ].join("\n");

    await store.upsertChunks([
      makeChunk({
        filePath: "packages/pixa-agent/src/indexer/indexingPipeline.ts",
        startLine: 150,
        endLine: 168,
        symbolName: "indexWorkspaceWithProgress",
        text: chunkText,
      }),
    ]);

    const diagnostics = await store.queryWithDiagnostics(
      "where do we build the semantic search index",
      5
    );
    const results = diagnostics.results;
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].filePath).toBe("packages/pixa-agent/src/indexer/indexingPipeline.ts");
  });

  it("returns no results below the relevance threshold instead of the least-bad match", async () => {
    const chunk = makeChunk({
      filePath: "unrelated.ts",
      startLine: 0,
      endLine: 3,
      symbolName: "parseCsv",
      text: "function parseCsv(input) { // parses a CSV string into rows and columns }",
    });
    await store.upsertChunks([chunk]);

    const results = await store.query("quantum entanglement in distributed databases", 5);
    expect(results.length).toBe(0);
  });
});