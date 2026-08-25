import { describe, expect, it } from "vitest";
import { BRAND_BY_PROVIDER_ID, MODEL_FAMILY_RULES, resolveBrand } from "@/lib/brands";

describe("resolveBrand", () => {
  it("resolves known provider ids exactly", () => {
    expect(resolveBrand("openai")).toBe("openai");
    expect(resolveBrand("anthropic")).toBe("anthropic");
    expect(resolveBrand("groq")).toBe("groq");
    expect(resolveBrand("nvidia")).toBe("nvidia");
    expect(resolveBrand("gemini")).toBe("google");
    expect(resolveBrand("doubao")).toBe("doubao");
    expect(resolveBrand("ark")).toBe("doubao");
    expect(resolveBrand("xai")).toBe("grok");
    expect(resolveBrand("huggingface")).toBe("huggingface");
    expect(resolveBrand("hf")).toBe("huggingface");
    expect(resolveBrand("zen")).toBe("opencode");
    expect(resolveBrand("puter")).toBe("puter");
    expect(resolveBrand("modal")).toBe("modal");
  });

  it("is case/whitespace insensitive", () => {
    expect(resolveBrand("OpenAI")).toBe("openai");
    expect(resolveBrand("  Anthropic  ")).toBe("anthropic");
  });

  it("prefers the model family brand over the provider", () => {
    expect(resolveBrand("groq", "meta-llama/Llama-3.3-70B-Instruct")).toBe("meta");
    expect(resolveBrand("groq", "qwen/qwen-2.5-coder-32b")).toBe("qwen");
    expect(resolveBrand("puter", "claude-3-5-sonnet")).toBe("anthropic");
    expect(resolveBrand("openai", "gemini-2.0-flash")).toBe("google");
    expect(resolveBrand("custom", "deepseek-chat")).toBe("deepseek");
  });

  it("resolves common model families", () => {
    expect(resolveBrand(undefined, "llama-3.1-8b-instruct")).toBe("meta");
    expect(resolveBrand(undefined, "gpt-4o")).toBe("openai");
    expect(resolveBrand(undefined, "claude-3-7-sonnet")).toBe("anthropic");
    expect(resolveBrand(undefined, "gemma-3-27b")).toBe("google");
    expect(resolveBrand(undefined, "phi-4")).toBe("microsoft");
    expect(resolveBrand(undefined, "solar-pro")).toBe("upstage");
    expect(resolveBrand(undefined, "command-r-plus")).toBe("cohere");
    expect(resolveBrand(undefined, "grok-3")).toBe("grok");
    expect(resolveBrand(undefined, "yi-34b")).toBe("yi");
  });

  it("recognizes compact hyphen-less ids (no boundary before the digit)", () => {
    expect(resolveBrand(undefined, "llama3-8b")).toBe("meta");
    expect(resolveBrand(undefined, "gpt4o")).toBe("openai");
    expect(resolveBrand(undefined, "gemma3-27b")).toBe("google");
    expect(resolveBrand(undefined, "phi4")).toBe("microsoft");
  });

  it("never false-positives on ambiguous substrings", () => {
    expect(resolveBrand("spark", "")).toBe("neutral");
    expect(resolveBrand("dark-ai", "")).toBe("neutral");
    expect(resolveBrand("openrouter", "")).toBe("neutral");
    expect(resolveBrand("custom", "cross-encoder/ms-marco-minilm")).toBe("neutral");
    expect(resolveBrand("custom", "multilingual-e5-large")).toBe("neutral");
    expect(resolveBrand("custom", "custom")).toBe("neutral");
  });

  it("matches gateways with a model family as a whole word only", () => {
    expect(resolveBrand("gpt-oss-120b", "")).toBe("openai");
    expect(resolveBrand("", "gpt-oss-120b")).toBe("openai");
    expect(resolveBrand("meta-llama", "")).toBe("meta");
    expect(resolveBrand("deepseek-proxy", "")).toBe("deepseek");
  });

  it("falls back to neutral for unknown providers", () => {
    expect(resolveBrand("unknown-provider", "generic-model")).toBe("neutral");
    expect(resolveBrand()).toBe("neutral");
    expect(resolveBrand(null, null)).toBe("neutral");
  });

  it("round-trips every provider mapping and never maps to neutral", () => {
    for (const [id, expected] of Object.entries(BRAND_BY_PROVIDER_ID)) {
      expect(resolveBrand(id)).toBe(expected);
      expect(expected).not.toBe("neutral");
    }
    for (const rule of MODEL_FAMILY_RULES) {
      expect(rule.brand).not.toBe("neutral");
    }
  });
});
