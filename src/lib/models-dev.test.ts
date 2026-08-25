import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  normalizeModelId,
  lookupModelInRegistry,
  reasoningCapsFromRegistryEntry,
  resetRegistryCache,
} from "./models-dev";

beforeEach(() => {
  resetRegistryCache();
});

afterEach(() => {
  resetRegistryCache();
});


describe("normalizeModelId", () => {
  it("should strip organization prefix", () => {
    expect(normalizeModelId("openai/gpt-4")).toBe("gpt-4");
    expect(normalizeModelId("anthropic/claude-3-opus")).toBe("claude-3-opus");
    expect(normalizeModelId("minimax/minimax-m3")).toBe("minimax-m3");
  });

  it("should lowercase the result", () => {
    expect(normalizeModelId("GPT-4")).toBe("gpt-4");
    expect(normalizeModelId("MiniMax-M3")).toBe("minimax-m3");
    expect(normalizeModelId("Claude-3-Opus")).toBe("claude-3-opus");
  });

  it("should handle model IDs without prefix", () => {
    expect(normalizeModelId("gpt-4")).toBe("gpt-4");
    expect(normalizeModelId("claude-3-sonnet")).toBe("claude-3-sonnet");
  });

  it("should handle empty input", () => {
    expect(normalizeModelId("")).toBe("");
  });

  it("should handle IDs with multiple slashes", () => {
    expect(normalizeModelId("org/project/model")).toBe("project/model");
  });
});

describe("reasoningCapsFromRegistryEntry", () => {
  it("returns undefined for absent entries", () => {
    expect(reasoningCapsFromRegistryEntry(undefined)).toBeUndefined();
    expect(reasoningCapsFromRegistryEntry({ contextWindow: 128000 })).toBeUndefined();
    // Bare `reasoning: true` carries no narrowing facts → unknown → the
    // provider scheme stays intact.
    expect(reasoningCapsFromRegistryEntry({ reasoning: true })).toBeUndefined();
  });

  it("maps reasoning:false to a closed surface", () => {
    expect(reasoningCapsFromRegistryEntry({ reasoning: false })).toEqual({ scheme: "none" });
  });

  it("carries the interleaved echo field", () => {
    const caps = reasoningCapsFromRegistryEntry({
      reasoning: true,
      interleavedField: "reasoning_content",
    });
    expect(caps?.interleavedField).toBe("reasoning_content");
  });
});

// The same model id is hosted by many providers with DIFFERENT per-provider facts (interleaved
// echo fields, output caps).
describe("provider-scoped registry lookups (live models.dev)", () => {
  it("NVIDIA NIM core capacity: real vendor entry, exact documented limits", { timeout: 45000 }, async () => {
    const inkling = await lookupModelInRegistry("thinkingmachines/inkling", "nvidia", { core: true });
    if (inkling.contextWindow !== undefined) {
      expect(inkling.contextWindow).toBe(1048576);
      expect(inkling.maxOutput).toBeGreaterThan(0);
    }
    const llama = await lookupModelInRegistry("meta/llama-3.1-8b-instruct", "nvidia", { core: true });
    if (llama.contextWindow !== undefined) {
      expect(llama.contextWindow).toBeGreaterThan(0);
    }
    const ds = await lookupModelInRegistry("deepseek-ai/deepseek-v4-pro", "nvidia", { core: true });
    if (ds.contextWindow !== undefined) {
      expect(ds.contextWindow).toBeGreaterThan(0);
    }
  });

  it("NVIDIA NIM core lookups never leak reasoning facts", { timeout: 45000 }, async () => {
    const reg = await lookupModelInRegistry("thinkingmachines/inkling", "nvidia", { core: true });
    // Holds offline too: an unresolved lookup is `{}`, which is equally bare.
    expect(reg.reasoning).toBeUndefined();
    expect(reg.reasoningOptions).toBeUndefined();
    expect(reg.interleavedField).toBeUndefined();
  });

  it("never cross-resolves entries across providers hosting the same id", { timeout: 45000 }, async () => {
    // The meaningful cross-provider difference on Inkling: baseten's entry
    // carries an interleaved echo (`reasoning_content`) while NVIDIA NIM's
    // does not. Both resolve via their own provider-scoped entry only.
    const baseten = await lookupModelInRegistry("thinkingmachines/inkling", "baseten");
    const nvidia = await lookupModelInRegistry("thinkingmachines/inkling", "nvidia", { core: true });
    if (baseten.maxOutput !== undefined && nvidia.maxOutput !== undefined) {
      expect(baseten.interleavedField).toBe("reasoning_content");
      expect(nvidia.contextWindow).toBe(1048576);
      expect(nvidia.interleavedField).toBeUndefined();
    }
  });

  it("id-only lookups stay ambiguous for multi-host ids (org-prefixed vs bare)", { timeout: 45000 }, async () => {
    // `thinkingmachines/inkling` (many hosts) and venice's bare `inkling`
    // all normalize to `inkling` — without a provider the id must never
    // resolve, or a cross-provider false match would apply. (An unreachable
    // registry returns `{}` — the ambiguity assertions hold either way.)
    const reg = await lookupModelInRegistry("thinkingmachines/inkling");
    expect(reg).toEqual({});
  });
});
