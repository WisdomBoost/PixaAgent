import { TransformersEmbeddings } from "vectra";
import { RateLimitError } from "./errors";
import type { ChatRequest, ChatResult, ModelProvider, StreamDelta } from "./types";

const LRU_MAX = 2000;

/**
 * True when an error is "the optional local embedding model isn't installed".
 * @huggingface/transformers ships unbundled (150MB+ with a native binary), so
 * this is the expected state on a fresh install, not a fault — callers use it
 * to degrade quietly instead of alarming the user.
 *
 * Both codes matter: vectra require()s the package (CJS -> MODULE_NOT_FOUND)
 * while this module await import()s it (ESM -> ERR_MODULE_NOT_FOUND).
 */
export function isMissingOptionalEmbeddingDep(err: any): boolean {
  const code = err?.code;
  return (
    (code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND") &&
    /@huggingface\/transformers/.test(err?.message ?? "")
  );
}

class LruCache<V> {
  private readonly map = new Map<string, V>();
  private readonly max: number;

  constructor(max: number) {
    this.max = max;
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  get(key: string): V | undefined {
    const value = this.map.get(key);
    if (value !== undefined) {
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }

  set(key: string, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.max) {
      this.map.delete(this.map.keys().next().value!);
    }
    this.map.set(key, value);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

export const embeddingCache = new LruCache<number[]>(LRU_MAX);

export interface EmbeddingCostTracker {
  totalTokens: number;
  costUsd: number;
}

export const embeddingCostTracker: EmbeddingCostTracker = {
  totalTokens: 0,
  costUsd: 0,
};

// IMPORTANT: deliberately a SMALL model (~22M params), not Qwen3-Embedding-0.6B
// (~600M params). A 600M-param model on CPU is the main cause of the extension
// feeling like it "takes a lifetime" — seconds per call, times thousands of
// chunks during a full index, plus every semantic_search call mid-conversation.
export let localEmbeddings: TransformersEmbeddings | null = null;
export let activeModel = "Xenova/all-MiniLM-L6-v2";

let _globalStoragePath: string | null = null;
let _loadingPromise: Promise<TransformersEmbeddings> | null = null;

async function getOrLoadModel(): Promise<TransformersEmbeddings> {
  if (localEmbeddings) return localEmbeddings;
  if (!_loadingPromise) {
    _loadingPromise = (async () => {
      if (_globalStoragePath) {
        const { env } = await import("@huggingface/transformers");
        env.cacheDir = _globalStoragePath;
      }
      const instance = await TransformersEmbeddings.create({ model: activeModel, device: "cpu" });
      localEmbeddings = instance;
      return instance;
    })().finally(() => {
      _loadingPromise = null;
    });
  }
  return _loadingPromise;
}

export function initEmbeddingCache(globalStoragePath: string): void {
  _globalStoragePath = globalStoragePath;
  void import("@huggingface/transformers").then(({ env }) => {
    env.cacheDir = globalStoragePath;
  });
}

export function setEmbeddingModel(modelName: string): void {
  activeModel = modelName;
  localEmbeddings = null;
}

export async function prewarmEmbeddingModel(onError?: (err: unknown) => void): Promise<void> {
  try {
    await getOrLoadModel();
  } catch (err) {
    onError?.(err);
  }
}

export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  await getOrLoadModel();

  const results: number[][] = new Array(texts.length);
  const cacheMisses: { text: string; index: number }[] = [];

  for (let i = 0; i < texts.length; i++) {
    const cached = embeddingCache.get(texts[i]);
    if (cached !== undefined) {
      results[i] = cached;
    } else {
      cacheMisses.push({ text: texts[i], index: i });
    }
  }

  if (cacheMisses.length > 0) {
    const batchSize = 50;
    for (let i = 0; i < cacheMisses.length; i += batchSize) {
      const chunk = cacheMisses.slice(i, i + batchSize);
      const batchTexts = chunk.map((c) => c.text);

      let response;
      try {
        response = await localEmbeddings!.createEmbeddings(batchTexts);
      } catch (err: any) {
        throw new Error(err.message || "Embedding generation failed");
      }

      if (response.status === "rate_limited") {
        throw new RateLimitError(60, response.message || "Rate limited", "upstream");
      }
      if (response.status === "error" || !response.output) {
        throw new Error(response.message || "Embedding generation failed");
      }

      const promptTokens =
        response.usage && typeof response.usage.prompt_tokens === "number"
          ? response.usage.prompt_tokens
          : batchTexts.reduce((acc, t) => acc + Math.ceil(t.length / 4), 0);
      embeddingCostTracker.totalTokens += promptTokens;

      for (let j = 0; j < chunk.length; j++) {
        const vector = response.output[j];
        results[chunk[j].index] = vector;
        embeddingCache.set(chunk[j].text, vector);
      }
    }
  }

  return results;
}

export class LocalEmbeddingsProvider implements ModelProvider {
  readonly id = "local-embeddings";

  async chat(
    _req: ChatRequest,
    _onDelta: (d: StreamDelta) => void,
    _signal: AbortSignal
  ): Promise<ChatResult> {
    throw new Error(
      "LocalEmbeddingsProvider does not support chat. This model is for embedding only."
    );
  }
}