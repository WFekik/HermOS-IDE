import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "fs";
import * as path from "path";
import * as os from "os";
import {
  normalizeModelId,
  lookupModelInRegistry,
  peekModelInRegistry,
  warmRegistryCache,
  reasoningCapsFromRegistryEntry,
  resetRegistryCache,
} from "./models-dev";
import { lookupContextWindow } from "./model-context-windows";
import { mergeReasoningCapability, parseModelsColumn } from "./provider-models";

const CACHE_PATH = path.join(os.tmpdir(), ".hermos", "models-dev-v4.json");

describe("Model Registry Stress — Models Dev Registry & Caching", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(async () => {
    resetRegistryCache();
    originalFetch = global.fetch;
    // Clean up disk cache file before each test
    try {
      await fs.unlink(CACHE_PATH);
    } catch {}
  });

  afterEach(async () => {
    resetRegistryCache();
    global.fetch = originalFetch;
    vi.restoreAllMocks();
    try {
      await fs.unlink(CACHE_PATH);
    } catch {}
  });

  it("handles corrupted disk cache JSON gracefully without throwing", async () => {
    await fs.mkdir(path.dirname(CACHE_PATH), { recursive: true });
    await fs.writeFile(CACHE_PATH, "INVALID JSON {{{", "utf-8");

    // Stub fetch so warmRegistryCache doesn't crash on network if offline
    global.fetch = vi.fn().mockImplementation(() =>
      Promise.reject(new Error("Network offline"))
    );

    const result = await peekModelInRegistry("gpt-4", "openai");
    expect(result).toEqual({});
  });

  it("ignores stale disk cache older than TTL (5 minutes)", async () => {
    await fs.mkdir(path.dirname(CACHE_PATH), { recursive: true });
    const stalePayload = {
      ts: Date.now() - (6 * 60 * 1000), // 6 minutes ago
      entries: [
        ["openai/gpt-4", { contextWindow: 8192 }]
      ]
    };
    await fs.writeFile(CACHE_PATH, JSON.stringify(stalePayload), "utf-8");

    global.fetch = vi.fn().mockImplementation(() =>
      Promise.reject(new Error("Network offline"))
    );

    const result = await peekModelInRegistry("gpt-4", "openai");
    expect(result).toEqual({});
  });

  it("ignores malformed payload structure in disk cache", async () => {
    await fs.mkdir(path.dirname(CACHE_PATH), { recursive: true });
    // ts is not a number
    await fs.writeFile(CACHE_PATH, JSON.stringify({ ts: "invalid", entries: [] }), "utf-8");

    global.fetch = vi.fn().mockImplementation(() =>
      Promise.reject(new Error("Network offline"))
    );

    const res1 = await peekModelInRegistry("gpt-4", "openai");
    expect(res1).toEqual({});

    // entries is not an array
    await fs.writeFile(CACHE_PATH, JSON.stringify({ ts: Date.now(), entries: "not array" }), "utf-8");
    const res2 = await peekModelInRegistry("gpt-4", "openai");
    expect(res2).toEqual({});
  });

  it("prevents thundering herd on concurrent cold lookupModelInRegistry calls", async () => {
    let fetchCount = 0;
    global.fetch = vi.fn().mockImplementation(async () => {
      fetchCount++;
      // Artificial delay to simulate network latency
      await new Promise((r) => setTimeout(r, 50));
      return {
        ok: true,
        json: async () => ({
          openai: {
            models: {
              "gpt-4": { limit: { context: 8192, output: 4096 } },
              "gpt-4o": { limit: { context: 128000, output: 16384 }, reasoning: false },
            },
          },
        }),
      };
    });

    // Launch 50 concurrent lookups
    const promises = Array.from({ length: 50 }).map(() =>
      lookupModelInRegistry("gpt-4o", "openai")
    );

    const results = await Promise.all(promises);

    expect(fetchCount).toBe(1);
    for (const res of results) {
      expect(res.contextWindow).toBe(128000);
      expect(res.maxOutput).toBe(16384);
      expect(res.reasoning).toBe(false);
    }
  });

  it("correctly handles cross-provider normalization and disambiguation", async () => {
    global.fetch = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({
        nvidia: {
          models: {
            "thinkingmachines/inkling": { limit: { context: 131072, output: 16384 }, reasoning: true },
          },
        },
        baseten: {
          models: {
            "thinkingmachines/inkling": {
              limit: { context: 131072, output: 16384 },
              reasoning: true,
              interleaved: { field: "reasoning_content" },
            },
          },
        },
        uniquehost: {
          models: {
            "custom-solo-model": { limit: { context: 65536 } },
          },
        },
      }),
    }));

    // Explicit lookup to force remote fetch
    const nvidiaRes = await lookupModelInRegistry("thinkingmachines/inkling", "nvidia");
    expect(nvidiaRes.interleavedField).toBeUndefined();

    const basetenRes = await lookupModelInRegistry("thinkingmachines/inkling", "baseten");
    expect(basetenRes.interleavedField).toBe("reasoning_content");

    // Unscoped lookup for multi-host model stays ambiguous -> returns {}
    const ambiguousRes = await lookupModelInRegistry("thinkingmachines/inkling");
    expect(ambiguousRes).toEqual({});

    // Unscoped lookup for single-host model resolves!
    const soloRes = await lookupModelInRegistry("custom-solo-model");
    expect(soloRes.contextWindow).toBe(65536);

    // Case-insensitive / upper-case single-host lookup resolves!
    const soloUpperRes = await lookupModelInRegistry("CUSTOM-SOLO-MODEL");
    expect(soloUpperRes.contextWindow).toBe(65536);
  });
});

describe("Model Registry Stress — Reasoning Capabilities & Echo Cleanup", () => {
  it("converts registry reasoning: false to scheme none", () => {
    const caps = reasoningCapsFromRegistryEntry({ reasoning: false });
    expect(caps).toEqual({ scheme: "none" });
  });

  it("converts empty reasoningOptions [] to empty supportedEfforts []", () => {
    const caps = reasoningCapsFromRegistryEntry({ reasoningOptions: [] });
    expect(caps).toEqual({ supportedEfforts: [] });
  });

  it("maps reasoningOptions correctly ('none' -> 'off', duplicates removed)", () => {
    const caps = reasoningCapsFromRegistryEntry({
      reasoningOptions: ["none", "low", "high", "low", "none", "unknown_val"],
    });
    expect(caps?.supportedEfforts).toEqual(["off", "low", "high"]);
  });

  it("cleans up stale interleaved echo field when switching providers for same model", () => {
    const prevCaps = { interleavedField: "reasoning_content" as const };
    // NIM registry entry has reasoning: true but no interleavedField
    const nimRegistryEntry = { reasoning: true };

    const merged = mergeReasoningCapability(undefined, prevCaps, nimRegistryEntry);
    expect(merged?.interleavedField).toBeUndefined();
  });

  it("preserves prevCaps when registry entry only carries contextWindow (no reasoning facts)", () => {
    const prevCaps = { interleavedField: "reasoning_content" as const };
    const limitsOnlyEntry = { contextWindow: 128000 };

    const merged = mergeReasoningCapability(undefined, prevCaps, limitsOnlyEntry);
    expect(merged?.interleavedField).toBe("reasoning_content");
  });

  it("closes reasoning surface to scheme none when registry has reasoning: false even if prevCaps existed", () => {
    const prevCaps = { interleavedField: "reasoning_content" as const, supportedEfforts: ["low" as const, "high" as const] };
    const merged = mergeReasoningCapability(undefined, prevCaps, { reasoning: false });
    expect(merged).toEqual({ scheme: "none" });
  });
});

describe("Model Registry Stress — Offline Token Suffix Parsing (lookupContextWindow)", () => {
  it("parses numeric k/K suffixes accurately", () => {
    expect(lookupContextWindow("gpt-4-128k")).toBe(128000);
    expect(lookupContextWindow("model-32K")).toBe(32000);
    expect(lookupContextWindow("custom/model-1.5k")).toBe(1500);
    expect(lookupContextWindow("model-0.5k")).toBe(500);
  });

  it("parses numeric m/M suffixes accurately", () => {
    expect(lookupContextWindow("model-1m")).toBe(1000000);
    expect(lookupContextWindow("gemini-2.5M")).toBe(2500000);
    expect(lookupContextWindow("org/model-0.5m")).toBe(500000);
  });

  it("returns undefined for unlisted models without embedded token suffixes (ZERO hardcoded defaults)", () => {
    const unlistedModels = [
      "gpt-4",
      "claude-3-5-sonnet",
      "llama-3.3-70b-instruct",
      "deepseek-v3",
      "mistral-large",
      "qwen-2.5-72b",
    ];

    for (const m of unlistedModels) {
      expect(lookupContextWindow(m)).toBeUndefined();
    }
  });

  it("returns undefined for false positive suffix patterns", () => {
    expect(lookupContextWindow("model-128kb")).toBeUndefined();
    expect(lookupContextWindow("model-1m0")).toBeUndefined();
    expect(lookupContextWindow("model-0k")).toBeUndefined();
    expect(lookupContextWindow("model-0m")).toBeUndefined();
  });
});
