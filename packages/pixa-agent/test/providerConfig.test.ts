import { describe, it, expect } from "vitest";
import { chatCompletionsUrl, providersToModels, type ProvidersConfig } from "../src/providers/config";

describe("chatCompletionsUrl", () => {
  it("appends the chat/completions path to an OpenAI-style base URL", () => {
    expect(chatCompletionsUrl("http://localhost:11434/v1")).toBe("http://localhost:11434/v1/chat/completions");
    expect(chatCompletionsUrl("https://integrate.api.nvidia.com/v1")).toBe(
      "https://integrate.api.nvidia.com/v1/chat/completions"
    );
  });

  it("tolerates a trailing slash", () => {
    expect(chatCompletionsUrl("http://localhost:8000/v1/")).toBe("http://localhost:8000/v1/chat/completions");
  });

  it("leaves a full endpoint URL untouched", () => {
    const full = "https://openrouter.ai/api/v1/chat/completions";
    expect(chatCompletionsUrl(full)).toBe(full);
  });
});

describe("providersToModels", () => {
  it("converts a self-hosted provider into namespaced model entries", () => {
    const cfg: ProvidersConfig = {
      ollama: {
        name: "Ollama (local)",
        baseUrl: "http://localhost:11434/v1",
        requiresApiKey: false,
        models: { "llama3.1": { name: "Llama 3.1", contextWindow: 131072 } },
      },
    };
    const { models, errors } = providersToModels(cfg);
    expect(errors).toEqual([]);
    expect(models).toEqual([
      {
        id: "ollama:llama3.1",
        label: "Llama 3.1 (Ollama (local))",
        provider: "ollama",
        slug: "llama3.1",
        contextWindow: 131072,
        supportsTools: true,
      },
    ]);
  });

  it("applies sensible defaults when optional fields are omitted", () => {
    const cfg: ProvidersConfig = {
      mylab: { baseUrl: "http://192.168.1.50:8000/v1", models: { "qwen-coder": {} } },
    };
    const { models } = providersToModels(cfg);
    expect(models[0].label).toBe("qwen-coder (mylab)");
    expect(models[0].contextWindow).toBe(128000);
    expect(models[0].supportsTools).toBe(true);
  });

  it("keeps ids unique across providers that expose the same model name", () => {
    const cfg: ProvidersConfig = {
      ollama: { baseUrl: "http://localhost:11434/v1", models: { "qwen3": {} } },
      vllm: { baseUrl: "http://localhost:8000/v1", models: { "qwen3": {} } },
    };
    const { models } = providersToModels(cfg);
    expect(models.map((m) => m.id)).toEqual(["ollama:qwen3", "vllm:qwen3"]);
  });

  it("skips an invalid provider but keeps the valid ones working", () => {
    const cfg = {
      broken: { models: { a: {} } }, // no baseUrl
      good: { baseUrl: "http://localhost:11434/v1", models: { b: {} } },
    } as unknown as ProvidersConfig;
    const { models, errors } = providersToModels(cfg);
    expect(models.map((m) => m.id)).toEqual(["good:b"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/broken/);
    expect(errors[0]).toMatch(/baseUrl/);
  });

  it("reports a provider that declares no models", () => {
    const cfg = { empty: { baseUrl: "http://localhost:11434/v1" } } as unknown as ProvidersConfig;
    const { models, errors } = providersToModels(cfg);
    expect(models).toEqual([]);
    expect(errors[0]).toMatch(/empty/);
  });

  it("returns nothing for an empty config", () => {
    expect(providersToModels({})).toEqual({ models: [], errors: [] });
  });
});
