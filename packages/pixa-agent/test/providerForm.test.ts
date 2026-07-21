import { describe, it, expect } from "vitest";
import {
  validateProviderForm,
  parseModelsResponse,
  modelsEndpointUrl,
  PRESETS,
} from "../src/providers/providerForm";
import { providersToModels } from "../src/providers/config";

describe("validateProviderForm", () => {
  const baseForm = {
    id: "ollama",
    name: "Ollama (local)",
    baseUrl: "http://localhost:11434/v1",
    requiresApiKey: false,
    models: [{ id: "qwen2.5-coder:1.5b", name: "Qwen2.5 Coder 1.5B" }],
  };

  it("accepts a valid form and produces a ProviderConfig", () => {
    const result = validateProviderForm(baseForm, []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config).toEqual({
      name: "Ollama (local)",
      baseUrl: "http://localhost:11434/v1",
      requiresApiKey: false,
      models: { "qwen2.5-coder:1.5b": { name: "Qwen2.5 Coder 1.5B" } },
    });
  });

  it("round-trips through providersToModels into a namespaced model entry", () => {
    const result = validateProviderForm(baseForm, []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { models, errors } = providersToModels({ ollama: result.config });
    expect(errors).toEqual([]);
    expect(models[0].id).toBe("ollama:qwen2.5-coder:1.5b");
    expect(models[0].supportsTools).toBe(true);
  });

  it("rejects a duplicate id", () => {
    const result = validateProviderForm(baseForm, ["ollama"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.id).toMatch(/already exists/);
  });

  it("rejects the reserved id 'openrouter' — colliding would silently overwrite the built-in provider", () => {
    const result = validateProviderForm({ ...baseForm, id: "openrouter" }, []);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.id).toMatch(/reserved/);
  });

  it("rejects the reserved id 'local-embeddings'", () => {
    const result = validateProviderForm({ ...baseForm, id: "local-embeddings" }, []);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.id).toMatch(/reserved/);
  });

  it("rejects invalid id characters", () => {
    const result = validateProviderForm({ ...baseForm, id: "My Provider!" }, []);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.id).toBeDefined();
  });

  it("rejects an empty base URL", () => {
    const result = validateProviderForm({ ...baseForm, baseUrl: "" }, []);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.baseUrl).toMatch(/required/);
  });

  it("rejects an unparseable base URL", () => {
    const result = validateProviderForm({ ...baseForm, baseUrl: "not a url" }, []);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.baseUrl).toMatch(/valid URL/);
  });

  it("rejects a form with zero models", () => {
    const result = validateProviderForm({ ...baseForm, models: [] }, []);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.models).toMatch(/at least one/);
  });

  it("ignores model rows with a blank id", () => {
    const result = validateProviderForm({ ...baseForm, models: [{ id: "  " }, { id: "real-model" }] }, []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.config.models)).toEqual(["real-model"]);
  });
});

describe("parseModelsResponse", () => {
  it("parses the OpenAI-style {data:[{id}]} shape", () => {
    expect(parseModelsResponse({ data: [{ id: "qwen2.5-coder:1.5b" }, { id: "llama3.1" }] })).toEqual([
      "qwen2.5-coder:1.5b",
      "llama3.1",
    ]);
  });

  it("parses a bare array of ids", () => {
    expect(parseModelsResponse(["model-a", "model-b"])).toEqual(["model-a", "model-b"]);
  });

  it("returns an empty list for malformed JSON shapes", () => {
    expect(parseModelsResponse({ nonsense: true })).toEqual([]);
    expect(parseModelsResponse(null)).toEqual([]);
    expect(parseModelsResponse("a string")).toEqual([]);
  });

  it("skips entries with no usable id", () => {
    expect(parseModelsResponse({ data: [{ id: "good" }, { name: "no id field" }, {}] })).toEqual(["good"]);
  });

  it("returns an empty list for an empty data array", () => {
    expect(parseModelsResponse({ data: [] })).toEqual([]);
  });
});

describe("modelsEndpointUrl", () => {
  it("appends /models to a base URL", () => {
    expect(modelsEndpointUrl("http://localhost:11434/v1")).toBe("http://localhost:11434/v1/models");
  });

  it("strips a trailing slash before appending", () => {
    expect(modelsEndpointUrl("http://localhost:11434/v1/")).toBe("http://localhost:11434/v1/models");
  });

  it("does not double up if the URL already ends in /models", () => {
    expect(modelsEndpointUrl("http://localhost:11434/v1/models")).toBe("http://localhost:11434/v1/models");
  });
});

describe("PRESETS", () => {
  it("does not include OpenRouter — it opens the built-in key-setup flow instead", () => {
    expect(PRESETS.some((p) => p.id === "openrouter")).toBe(false);
  });

  it("all presets are keyless local servers except NVIDIA NIM", () => {
    for (const preset of PRESETS) {
      expect(preset.requiresApiKey).toBe(preset.id === "nvidia");
    }
  });
});
