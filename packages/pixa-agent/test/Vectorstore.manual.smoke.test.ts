import { describe, it, expect } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import { VectorStore } from "../src/indexer/vectorStore";
import { initEmbeddingCache } from "../src/providers/embeddings";

// ---------------------------------------------------------------------------
// This is a MANUAL / LOCAL-ONLY smoke test, not a CI test. It exercises the
// real embedding model against a real workspace's real .pixa index, which
// means it needs two things a CI runner usually doesn't have:
//   1. Network access to Hugging Face to download model weights on a cold
//      cache (a few hundred MB, first run only).
//   2. A workspace that has ALREADY been indexed by the actual extension.
//      VectorStore.query() only reads an existing index — it does not build
//      one, and it can't: indexing calls vscode.executeDocumentSymbolProvider,
//      which only exists inside a running VS Code extension host, not a
//      plain Vitest process. If you haven't opened this folder in VS Code
//      and run "Pixa: Rebuild Semantic Index" (or waited for activation's
//      initial index) first, this test will correctly report an empty
//      index rather than hang.
//
// Skipped by default so it can never hang CI. Run explicitly with:
//   RUN_MANUAL_SMOKE=1 npx vitest run test/vectorStore.manual.smoke.test.ts
//
// Set SMOKE_WORKSPACE_ROOT to point at the real, already-indexed workspace
// you want to query (defaults to the TelemetryX path from earlier).
// ---------------------------------------------------------------------------

const RUN = process.env.RUN_MANUAL_SMOKE === "1";
const WORKSPACE_ROOT = process.env.SMOKE_WORKSPACE_ROOT ?? "C:/Users/kalea/TelemetryX";

describe.skipIf(!RUN)("VectorStore manual smoke test (real model, real workspace)", () => {
    it(
        "queries a real, already-indexed workspace and prints results",
        async () => {
            // Stable cache dir so the model is only downloaded once across runs,
            // instead of falling back to whatever default @huggingface/transformers
            // picks when the extension's own initEmbeddingCache() never ran.
            const cacheDir = path.join(os.tmpdir(), "pixa-manual-smoke-model-cache");
            initEmbeddingCache(cacheDir);
            console.log("Using model cache dir:", cacheDir);

            console.log("Creating store for:", WORKSPACE_ROOT);
            const store = new VectorStore(WORKSPACE_ROOT);

            const indexedChunkCount = await store.size();
            console.log("Existing chunk count in index:", indexedChunkCount);
            if (indexedChunkCount === 0) {
                throw new Error(
                    `Index at ${WORKSPACE_ROOT}/.pixa is empty. Open this folder in VS Code and run ` +
                    `"Pixa: Rebuild Semantic Index" first — this test only queries, it doesn't build.`
                );
            }

            console.log("Calling query (first call may take a while: cold model download/load)...");
            const start = Date.now();
            const results = await store.query("How does the application avoid doing expensive work twice?");
            console.log(`Query finished in ${Date.now() - start}ms`);
            console.log("Results:", results);

            expect(results).toBeDefined();
        },
        // Generous: covers a cold multi-hundred-MB model download, not just inference.
        120_000
    );
});