import { describe, it, expect } from "vitest";
import { parseModelsColumn, mergeReasoningCapability, type ProviderModelConfig } from "./provider-models";

describe("parseModelsColumn", () => {
  it("should return empty array for null/undefined/empty input", () => {
    expect(parseModelsColumn(null)).toEqual([]);
    expect(parseModelsColumn(undefined)).toEqual([]);
    expect(parseModelsColumn("")).toEqual([]);
  });

  it("should parse array of plain strings", () => {
    const result = parseModelsColumn(JSON.stringify(["gpt-4", "gpt-3.5-turbo"]));
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ id: "gpt-4", enabled: true, thinkingLevel: "default" });
    expect(result[1]).toEqual({ id: "gpt-3.5-turbo", enabled: true, thinkingLevel: "default" });
  });

  it("should parse array of config objects", () => {
    const input = JSON.stringify([
      { id: "claude-3-opus", enabled: true, thinkingLevel: "high", contextWindow: 200000, maxOutput: 4096 },
      { id: "claude-3-sonnet", enabled: false, thinkingLevel: "default" },
    ]);
    const result = parseModelsColumn(input);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      id: "claude-3-opus",
      enabled: true,
      thinkingLevel: "high",
      contextWindow: 200000,
      maxOutput: 4096,
    });
    expect(result[1]).toMatchObject({
      id: "claude-3-sonnet",
      enabled: false,
      thinkingLevel: "default",
    });
  });

  it("should reject items with missing id", () => {
    const result = parseModelsColumn(JSON.stringify([
      { id: "valid-model", enabled: true, thinkingLevel: "default" },
      { noId: true },
    ]));
    expect(result).toHaveLength(1);
  });

  it("should default enabled to true when not explicitly false", () => {
    const result = parseModelsColumn(JSON.stringify([
      { id: "model-a" },
      { id: "model-b", enabled: false },
    ]));
    expect(result[0].enabled).toBe(true);
    expect(result[1].enabled).toBe(false);
  });

  it("should normalize legacy thinking levels to canonical values", () => {
    const result = parseModelsColumn(JSON.stringify([
      { id: "model-a", thinkingLevel: "disabled" },
      { id: "model-b", thinkingLevel: "default" },
      { id: "model-c", thinkingLevel: "enabled" },
    ]));
    expect(result[0].thinkingLevel).toBe("off");
    expect(result[1].thinkingLevel).toBe("default");
    expect(result[2].thinkingLevel).toBe("default");
  });

  it("should fall back to 'auto' for invalid thinking levels", () => {
    const result = parseModelsColumn(JSON.stringify([
      { id: "model-a", thinkingLevel: "invalid-level" },
      { id: "model-b", thinkingLevel: "medium" },
    ]));
    expect(result[0].thinkingLevel).toBe("default");
    expect(result[1].thinkingLevel).toBe("medium");
  });

  it("should accept all valid canonical thinking levels", () => {
    const result = parseModelsColumn(JSON.stringify([
      { id: "m1", thinkingLevel: "off" },
      { id: "m2", thinkingLevel: "auto" },
      { id: "m3", thinkingLevel: "minimal" },
      { id: "m4", thinkingLevel: "low" },
      { id: "m5", thinkingLevel: "medium" },
      { id: "m6", thinkingLevel: "high" },
      { id: "m7", thinkingLevel: "xhigh" },
      { id: "m8", thinkingLevel: "max" },
    ]));
    expect(result).toHaveLength(8);
    expect(result.map((r) => r.thinkingLevel)).toEqual(["off", "default", "minimal", "low", "medium", "high", "xhigh", "max"]);
  });

  it("should return empty array for invalid JSON", () => {
    expect(parseModelsColumn("not json")).toEqual([]);
  });

  it("should return empty array for non-array JSON", () => {
    expect(parseModelsColumn('{"id":"model"}')).toEqual([]);
  });

  it("should infer contextWindow and maxOutput as numbers", () => {
    const result = parseModelsColumn(JSON.stringify([
      { id: "m1", contextWindow: "200k", maxOutput: "4k" },
    ]));
    expect(result[0].contextWindow).toBeUndefined();
    expect(result[0].maxOutput).toBeUndefined();
  });

  it("should parse live pricing metadata when present", () => {
    const result = parseModelsColumn(JSON.stringify([
      { id: "m1", enabled: true, thinkingLevel: "default", pricing: { in: 2500, out: 10000 } },
      { id: "m2", enabled: true, thinkingLevel: "default", pricing: { in: "bad", out: 1 } },
    ]));
    expect(result[0].pricing).toEqual({ in: 2500, out: 10000 });
    expect(result[1].pricing).toBeUndefined();
  });

  it("should parse live reasoning capabilities metadata when present", () => {
    const result = parseModelsColumn(JSON.stringify([
      {
        id: "m1",
        enabled: true,
        thinkingLevel: "default",
        reasoning: { default_enabled: true, mandatory: false, interleaved_field: "reasoning_content" },
      },
      { id: "m2", enabled: true, thinkingLevel: "default", reasoning: null },
    ]));
    expect(result[0].reasoning).toEqual({
      defaultEnabled: true,
      mandatory: false,
      interleavedField: "reasoning_content",
    });
    expect(result[1].reasoning).toBeUndefined();
  });

  it("should parse a persisted scheme:none caps entry (non-reasoning model)", () => {
    const result = parseModelsColumn(JSON.stringify([
      { id: "m1", enabled: true, thinkingLevel: "default", reasoning: { scheme: "none" } },
    ]));
    expect(result[0].reasoning).toEqual({ scheme: "none" });
  });
});

describe("mergeReasoningCapability", () => {
  it("live provider metadata wins over everything", () => {
    const live = { interleavedField: "reasoning_content" as const };
    const prev = { interleavedField: "other_field" as const };
    expect(mergeReasoningCapability(live, prev, { reasoning: false })).toBe(live);
    expect(mergeReasoningCapability(live, undefined, { reasoning: true })).toBe(live);
  });

  it("previously persisted caps survive refreshes that omit live metadata", () => {
    const prev = { interleavedField: "reasoning_content" as const };
    // No registry entry resolved for this provider+model — nothing to
    // reconcile against; persisted caps survive untouched.
    expect(mergeReasoningCapability(undefined, prev, undefined)).toBe(prev);
  });

  it("registry reasoning:false narrows the surface to scheme none (never adds)", () => {
    expect(mergeReasoningCapability(undefined, undefined, { reasoning: false })).toEqual({ scheme: "none" });
  });

  it("registry reasoning:true or unknown leaves the provider scheme intact", () => {
    expect(mergeReasoningCapability(undefined, undefined, { reasoning: true })).toBeUndefined();
    expect(mergeReasoningCapability(undefined, undefined, undefined)).toBeUndefined();
  });

  it("registry interleaved.field fills the eager-echo field", () => {
    const caps = mergeReasoningCapability(undefined, undefined, {
      reasoning: true,
      interleavedField: "reasoning_content",
    });
    expect(caps).toEqual({ interleavedField: "reasoning_content" });
  });

  it("registry reasoning:false beats persisted caps", () => {
    const caps = mergeReasoningCapability(undefined, { interleavedField: "reasoning_content" as const }, {
      reasoning: false,
    });
    expect(caps).toEqual({ scheme: "none" });
  });

  it("registry entry without an interleaved echo drops a stale persisted echo", () => {
    // The same model id is hosted by many providers with different echo
    // requirements: NVIDIA NIM's Inkling advertises NO interleaved field
    // while baseten's entry does. A stale echo from the other provider's
    // entry must not be sent to NIM.
    const caps = mergeReasoningCapability(undefined, { interleavedField: "reasoning_content" as const }, {
      reasoning: true,
    });
    expect(caps).toEqual({});
  });

  it("limits-only registry entries never touch persisted reasoning caps", () => {
    // Entries resolved purely for context/max-output carry no reasoning
    // facts and must not disturb persisted caps.
    const prev = { interleavedField: "reasoning_content" as const };
    expect(mergeReasoningCapability(undefined, prev, { contextWindow: 262144 })).toEqual(prev);
  });
});
