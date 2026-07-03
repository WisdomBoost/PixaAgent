import { describe, it, expect } from "vitest";
import { loadModels, ProviderRegistry } from "../src/providers/registry";
import type { ModelProvider } from "../src/providers/types";

const validJson = JSON.stringify({
  models: [
    {
      id: "glm",
      label: "GLM (OpenRouter)",
      provider: "openrouter",
      slug: "z-ai/glm-5.2",
      contextWindow: 200000,
      supportsTools: true,
    },
  ],
});

describe("loadModels", () => {
  it("parses a valid registry", () => {
    const models = loadModels(validJson);
    expect(models).toHaveLength(1);
    expect(models[0].slug).toBe("z-ai/glm-5.2");
    expect(models[0].supportsTools).toBe(true);
  });

  it("throws on missing slug", () => {
    const bad = JSON.stringify({ models: [{ id: "x", label: "X", provider: "openrouter", contextWindow: 1000, supportsTools: true }] });
    expect(() => loadModels(bad)).toThrow(/slug/);
  });

  it("throws on non-array models", () => {
    expect(() => loadModels(JSON.stringify({ models: "nope" }))).toThrow();
  });
});

describe("ProviderRegistry", () => {
  const fake: ModelProvider = {
    id: "openrouter",
    chat: async () => ({ content: "", toolCalls: [], finishReason: "stop" }),
  };

  it("resolves a model to its provider", () => {
    const reg = new ProviderRegistry();
    reg.register(fake);
    const models = loadModels(validJson);
    const { provider, entry } = reg.resolve("glm", models);
    expect(provider.id).toBe("openrouter");
    expect(entry.contextWindow).toBe(200000);
  });

  it("throws on unknown model id", () => {
    const reg = new ProviderRegistry();
    reg.register(fake);
    expect(() => reg.resolve("nope", loadModels(validJson))).toThrow(/Unknown model/);
  });

  it("throws on unregistered provider", () => {
    const reg = new ProviderRegistry();
    expect(() => reg.resolve("glm", loadModels(validJson))).toThrow(/provider/i);
  });
});
