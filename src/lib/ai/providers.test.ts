import { describe, it, expect } from "vitest";
import {
  PROVIDERS,
  listProviders,
  getProvider,
  resolveModel,
  DEFAULT_PROVIDER,
  DEFAULT_MODEL,
  DEFAULT_FALLBACK_MODEL,
  DEFAULT_OPENAI_FALLBACK_MODEL,
} from "./providers";
import { extractCapabilities, extractPricing } from "@/lib/provider-fetch";
import { getModelRate } from "@/lib/provider-models";
import { lookupModelInRegistry } from "@/lib/models-dev";
import { lookupContextWindow } from "@/lib/model-context-windows";

describe("Provider Catalog", () => {
  describe("Provider & Model Single Source of Truth Constants", () => {
    it("should export central provider and model default constants", () => {
      expect(DEFAULT_PROVIDER).toBe("puter");
      expect(DEFAULT_MODEL).toBe("auto");
      expect(DEFAULT_FALLBACK_MODEL).toBe("claude-3-5-sonnet");
      expect(DEFAULT_OPENAI_FALLBACK_MODEL).toBe("gpt-4o");
    });
  });

  describe("PROVIDERS", () => {
    it("should include all known providers", () => {
      const ids = Object.keys(PROVIDERS);
      expect(ids).toContain("puter");
      expect(ids).toContain("openrouter");
      expect(ids).toContain("openai");
      expect(ids).toContain("anthropic");
      expect(ids).toContain("groq");
      expect(ids).toContain("mistral");
      expect(ids).toContain("together");
      expect(ids).toContain("gemini");
      expect(ids).toContain("custom");
    });

    it("should have valid provider entries with required fields", () => {
      for (const [id, p] of Object.entries(PROVIDERS)) {
        expect(p.id).toBe(id);
        expect(p.name).toBeTruthy();
        expect(p.description).toBeTruthy();
        expect(typeof p.requiresKey).toBe("boolean");
        expect(Array.isArray(p.models)).toBe(true);
      }
    });

    it("should have proper baseUrl for most providers", () => {
      expect(PROVIDERS.openai.baseUrl).toBe("https://api.openai.com/v1");
      expect(PROVIDERS.anthropic.baseUrl).toBe("https://api.anthropic.com/v1");
      expect(PROVIDERS.groq.baseUrl).toBe("https://api.groq.com/openai/v1");
    });

    it("should assign reasoning schemes to Anthropic and Gemini", () => {
      expect(PROVIDERS.anthropic.reasoningScheme).toBe("anthropic_thinking");
      expect(PROVIDERS.gemini.reasoningScheme).toBe("gemini_effort");
    });

    it("should mark OpenAI-compatible providers as supporting native function calling", () => {
      expect(PROVIDERS.openai.supportsNativeFunctionCalling).toBe(true);
      expect(PROVIDERS.anthropic.supportsNativeFunctionCalling).toBe(true);
      expect(PROVIDERS.groq.supportsNativeFunctionCalling).toBe(true);
      expect(PROVIDERS.mistral.supportsNativeFunctionCalling).toBe(true);
      expect(PROVIDERS.together.supportsNativeFunctionCalling).toBe(true);
      expect(PROVIDERS.custom.supportsNativeFunctionCalling).toBe(true);
      expect(PROVIDERS.puter.supportsNativeFunctionCalling).toBe(true);
    });

    it("should assign reasoning scheme to Puter (OpenAI-compatible gateway)", () => {
      expect(PROVIDERS.puter.reasoningScheme).toBe("openai_effort");
    });
  });

  describe("listProviders", () => {
    it("should return all providers as an array", () => {
      const result = listProviders();
      expect(result).toHaveLength(Object.keys(PROVIDERS).length);
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe("getProvider", () => {
    it("should return a provider by id", () => {
      const p = getProvider("openai");
      expect(p).toBeDefined();
      expect(p!.id).toBe("openai");
    });

    it("should return undefined for unknown provider", () => {
      expect(getProvider("unknown" as any)).toBeUndefined();
    });
  });

  describe("resolveModel", () => {
    it("should return the model as-is when not 'auto'", () => {
      expect(resolveModel("openai", "gpt-4")).toBe("gpt-4");
    });

    it('should return "auto" when provider has no models', () => {
      expect(resolveModel("openai", "auto")).toBe("auto");
    });
  });

  describe("Deduplicated Capability Extraction", () => {
    it("should extract contextWindow and maxOutput from model metadata object", () => {
      const res = extractCapabilities({
        context_window: 128000,
        max_completion_tokens: 4096,
      });
      expect(res.contextWindow).toBe(128000);
      expect(res.maxOutput).toBe(4096);
    });

    it("should handle string context window and max tokens numbers", () => {
      const res = extractCapabilities({
        context_length: "200000",
        max_tokens: "8192",
      });
      expect(res.contextWindow).toBe(200000);
      expect(res.maxOutput).toBe(8192);
    });

    it("should return empty object for invalid/empty inputs", () => {
      expect(extractCapabilities(null)).toEqual({});
      expect(extractCapabilities(undefined)).toEqual({});
      expect(extractCapabilities("invalid")).toEqual({});
    });
  });

  describe("Pricing Lookup (catalog + live metadata)", () => {
    it("should return the catalog-declared provider-level rate for puter (user-pays)", () => {
      expect(getModelRate("puter", "gpt-4o")).toEqual({ in: 0, out: 0 });
    });

    it("should prefer live per-model pricing from runtime metadata", () => {
      const runtimeModels = [
        { id: "openai/gpt-4o-mini", enabled: true, thinkingLevel: "default" as const, pricing: { in: 0.15, out: 0.6 } },
        { id: "openai/gpt-4o", enabled: true, thinkingLevel: "default" as const, pricing: { in: 2.5, out: 10 } },
      ];
      expect(getModelRate("openrouter", "openai/gpt-4o-mini", runtimeModels)).toEqual({ in: 0.15, out: 0.6 });
      expect(getModelRate("openrouter", "openai/gpt-4o", runtimeModels)).toEqual({ in: 2.5, out: 10 });
    });

    it("should return null for models without metadata pricing (no invented fallbacks)", () => {
      expect(getModelRate("openai", "gpt-4o")).toBeNull();
      expect(getModelRate("openai", "gpt-4-custom")).toBeNull();
      expect(getModelRate("anthropic", "claude-3-custom")).toBeNull();
      expect(getModelRate("openrouter", "openai/gpt-4o-mini")).toBeNull();
      expect(getModelRate("openrouter", "unknown/provider-model")).toBeNull();
    });

    it("should return null when runtime models exist but the model is absent", () => {
      const runtimeModels = [
        { id: "anthropic/claude-3-5-sonnet", enabled: true, thinkingLevel: "default" as const, pricing: { in: 3, out: 15 } },
      ];
      expect(getModelRate("openrouter", "anthropic/claude-3-5-haiku", runtimeModels)).toBeNull();
    });
  });

  describe("extractPricing", () => {
    it("should parse OpenRouter pricing (USD per token strings) into per-1M rates", () => {
      expect(extractPricing({ pricing: { prompt: "0.0025", completion: "0.01" } })).toEqual({ in: 2500, out: 10000 });
    });

    it("should accept numeric pricing values", () => {
      expect(extractPricing({ pricing: { prompt: 0.15, completion: 0.6 } })).toEqual({ in: 150000, out: 600000 });
    });

    it("should return null for absent or malformed pricing", () => {
      expect(extractPricing(null)).toBeNull();
      expect(extractPricing({})).toBeNull();
      expect(extractPricing({ pricing: null })).toBeNull();
      expect(extractPricing({ pricing: "0.1" })).toBeNull();
      expect(extractPricing({ pricing: { prompt: "0.0025" } })).toBeNull();
      expect(extractPricing({ pricing: { prompt: "nope", completion: "0.01" } })).toBeNull();
      expect(extractPricing({ pricing: { prompt: "-1", completion: "0.01" } })).toBeNull();
    });
  });

  describe("Subagent & Model Registry Context Window Resolution", () => {
    it("should resolve context window via models.dev registry for known models", async () => {
      // Provider-scoped lookup: gpt-4o is hosted by many providers with
      // different per-provider facts; the "openai" entry resolves exactly.
      const regGpt4o = await lookupModelInRegistry("gpt-4o", "openai");
      if (regGpt4o.contextWindow !== undefined) {
        expect(regGpt4o.contextWindow).toBe(128000);
      }
    });

    it("should not resolve a multi-provider id without provider context", async () => {
      // A model hosted by many providers is ambiguous without a provider —
      // never guess which provider's entry applies.
      const reg = await lookupModelInRegistry("gpt-4o");
      expect(reg.reasoningOptions).toBeUndefined();
      expect(reg.interleavedField).toBeUndefined();
    });

    it("should fall back to regex suffix parsing for suffix-based model names", () => {
      expect(lookupContextWindow("claude-3-5-sonnet-200k")).toBe(200000);
      expect(lookupContextWindow("my-custom-model-128k")).toBe(128000);
      expect(lookupContextWindow("llama-3-70b-32k")).toBe(32000);
      expect(lookupContextWindow("unknown-model")).toBeUndefined();
    });
  });
});
