import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import {
  embed,
  localEmbeddings,
  embeddingCache,
  embeddingCostTracker,
  setEmbeddingModel,
} from "../src/providers/embeddings";

describe("embeddings provider", { timeout: 120000 }, () => {
  beforeAll(() => {
    // Use a small, fast model so the download completes quickly in CI / local runs.
    setEmbeddingModel("Xenova/all-MiniLM-L6-v2");
  });

  beforeEach(() => {
    embeddingCache.clear();
    embeddingCostTracker.totalTokens = 0;
    embeddingCostTracker.costUsd = 0;
  });

  it("can embed a list of test strings and get back vectors of expected dimension", async () => {
    const texts = ["hello", "world"];
    const vectors = await embed(texts);

    expect(vectors).toHaveLength(2);
    expect(Array.isArray(vectors[0])).toBe(true);
    // Xenova/all-MiniLM-L6-v2 produces 384-dimensional vectors.
    expect(vectors[0].length).toBe(384);
    expect(typeof vectors[0][0]).toBe("number");
  });

  it("proves batching works by splitting 110 texts into 3 calls of ≤50 each", async () => {
    // Warm up so the model is loaded before we spy.
    await embed(["warmup"]);

    if (!localEmbeddings) throw new Error("localEmbeddings not initialized");
    const spy = vi.spyOn(localEmbeddings, "createEmbeddings");

    const texts = Array.from({ length: 110 }, (_, i) => `batch string ${i}`);
    const vectors = await embed(texts);

    expect(vectors).toHaveLength(110);
    // 110 texts → batch 0-49 (50), 50-99 (50), 100-109 (10) → 3 calls.
    expect(spy).toHaveBeenCalledTimes(3);
    spy.mockRestore();
  });

  it("proves that a second call with unchanged input hits the cache and never re-embeds", async () => {
    const texts = ["caching test a", "caching test b"];
    const vectors1 = await embed(texts);
    expect(vectors1).toHaveLength(2);

    if (!localEmbeddings) throw new Error("localEmbeddings not initialized");
    const spy = vi.spyOn(localEmbeddings, "createEmbeddings");

    const vectors2 = await embed(texts);
    expect(vectors2).toEqual(vectors1);
    expect(spy).toHaveBeenCalledTimes(0); // pure cache hit

    spy.mockRestore();
  });
});
