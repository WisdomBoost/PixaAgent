import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ToolRegistry, registerBuiltinTools } from "../src/tools/registry.js";
import type { QueryResult } from "../src/indexer/vectorStore.js";
import type { ToolContext } from "../src/tools/types.js";
import { ChangeSet } from "../src/edits/changeSet.js";
import type { RepoIndex } from "../src/indexer/types.js";

function fakeEmbed(text: string): number[] {
  const dims = 32;
  const vec = new Array(dims).fill(0);
  for (const word of text.toLowerCase().split(/\W+/).filter(Boolean)) {
    let h = 0;
    for (const ch of word) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    vec[h % dims] += 1;
  }
  const norm = Math.sqrt(vec.reduce((a, b) => a + b * b, 0)) || 1;
  return vec.map((v) => v / norm);
}

// vi.mock() is hoisted to the top of the file automatically by vitest, so
// the plain static VectorStore import below still resolves to this mock —
// no dynamic `await import()` needed, which was the source of the top-level
// await error under CommonJS.
vi.mock("../src/providers/embeddings.js", () => ({
  embed: vi.fn(async (texts: string[]) => texts.map(fakeEmbed)),
}));

import { VectorStore } from "../src/indexer/vectorStore.js";

class TestSemanticIndex implements RepoIndex {
  constructor(private store: InstanceType<typeof VectorStore>) {}

  refresh(): void {}

  getProjectMap(): Promise<string> {
    return Promise.resolve("(test map)");
  }

  getFileOutline(): Promise<string> {
    return Promise.resolve("(test outline)");
  }

  chunkCount(): Promise<number> {
    return this.store.size();
  }

  async query(text: string, topK = 10): Promise<QueryResult[]> {
    return this.store.query(text, topK);
  }
}

describe("semantic_search tool", () => {
  let workspaceRoot: string;
  let tools: ToolRegistry;
  let ctx: ToolContext;
  let vectorStore: InstanceType<typeof VectorStore>;

  beforeEach(() => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pixa-semantic-tool-"));
    tools = new ToolRegistry();
    registerBuiltinTools(tools);

    vectorStore = new VectorStore(workspaceRoot);
    ctx = {
      workspaceRoot,
      changeSet: new ChangeSet(),
      index: new TestSemanticIndex(vectorStore),
      approvals: { requestApproval: async () => true },
      readWorkspaceFile: async (absPath) => fs.readFileSync(absPath, "utf8"),
      emit: () => {},
    };
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

  it("returns ranked chunks for a conceptual query", async () => {
    const retryText =
      "function retryWithBackoff() { retries failed network requests using exponential backoff }";
    writeSourceFile("retry.ts", retryText);

    await vectorStore.upsertChunks([
      {
        id: "retry.ts:0:0",
        filePath: "retry.ts",
        startLine: 0,
        endLine: 0,
        symbolName: "retryWithBackoff",
        symbolKind: "function",
        text: retryText,
      },
    ]);

    const output = await tools.run(
      "semantic_search",
      JSON.stringify({ query: "where do we retry failed requests with backoff" }),
      ctx
    );

    expect(output).toContain("retry.ts");
    expect(output).toContain("retryWithBackoff");
    expect(output).not.toMatch(/^Error:/);
  });

  it("suggests search_workspace when the index is still empty", async () => {
    const output = await tools.run(
      "semantic_search",
      JSON.stringify({ query: "where is authentication handled" }),
      ctx
    );

    expect(output).toContain("search_workspace");
    expect(output).toContain("empty or still building");
  });
});