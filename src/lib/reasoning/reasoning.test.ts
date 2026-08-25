import { describe, it, expect } from "vitest";
import {
  normalizeThinkingLevel,
  parseModelReasoningCapabilities,
  anthropicBudgetTokens,
  resolveReasoningPlan,
  getReasoningLevels,
  resolveSchemeId,
  SCHEMES,
} from "./index";
import { isBehavioralScheme } from "./learn";

describe("normalizeThinkingLevel", () => {
  it("passes canonical values through", () => {
    expect(normalizeThinkingLevel("off")).toBe("off");
    expect(normalizeThinkingLevel("default")).toBe("default");
    expect(normalizeThinkingLevel("minimal")).toBe("minimal");
    expect(normalizeThinkingLevel("low")).toBe("low");
    expect(normalizeThinkingLevel("medium")).toBe("medium");
    expect(normalizeThinkingLevel("high")).toBe("high");
    expect(normalizeThinkingLevel("xhigh")).toBe("xhigh");
    expect(normalizeThinkingLevel("max")).toBe("max");
  });

  it("maps legacy stored values to the canonical vocabulary", () => {
    expect(normalizeThinkingLevel("disabled")).toBe("off");
    expect(normalizeThinkingLevel("default")).toBe("default");
    expect(normalizeThinkingLevel("enabled")).toBe("default");
  });

  it("falls back to default for invalid/unknown input", () => {
    expect(normalizeThinkingLevel("turbo")).toBe("default");
    expect(normalizeThinkingLevel("")).toBe("default");
    expect(normalizeThinkingLevel(42)).toBe("default");
    expect(normalizeThinkingLevel(undefined)).toBe("default");
    expect(normalizeThinkingLevel(null)).toBe("default");
  });
});

describe("parseModelReasoningCapabilities", () => {
  it("parses OpenRouter reasoning metadata", () => {
    const caps = parseModelReasoningCapabilities({
      default_effort: "medium",
      default_enabled: true,
      mandatory: true,
      supports_max_tokens: true,
    });
    expect(caps).toEqual({
      defaultEffort: "medium",
      mandatory: true,
      defaultEnabled: true,
      supportsMaxTokens: true,
    });
  });

  it("accepts the persisted camelCase form (DB round-trip)", () => {
    const caps = parseModelReasoningCapabilities({
      defaultEffort: "high",
      mandatory: false,
      defaultEnabled: true,
      supportsMaxTokens: true,
    });
    expect(caps).toEqual({
      defaultEffort: "high",
      mandatory: false,
      defaultEnabled: true,
      supportsMaxTokens: true,
    });
  });

  it("round-trips the interleaved echo field (persisted camelCase form)", () => {
    const caps = parseModelReasoningCapabilities({
      interleavedField: "reasoning_content",
    });
    expect(caps?.interleavedField).toBe("reasoning_content");
  });

  it("drops non-canonical effort values like 'none' (only canonical levels kept)", () => {
    // "none" is not part of the canonical vocabulary — it normalizes to the
    // "auto" sentinel and is filtered out; the persisted camelCase form with
    // canonical values passes through untouched.
    const caps = parseModelReasoningCapabilities({
      supported_efforts: ["none", "low", "medium", "high"],
    });
    expect(caps?.supportedEfforts).toEqual(["low", "medium", "high"]);
    const camel = parseModelReasoningCapabilities({
      supportedEfforts: ["minimal", "low", "medium", "high"],
    });
    expect(camel?.supportedEfforts).toEqual(["minimal", "low", "medium", "high"]);
  });

  it("preserves an explicitly empty effort vocabulary (surface closes)", () => {
    const caps = parseModelReasoningCapabilities({ supported_efforts: [] });
    expect(caps?.supportedEfforts).toEqual([]);
  });

  it("drops invalid effort values, never guessing", () => {
    const caps = parseModelReasoningCapabilities({ supported_efforts: ["turbo", "low", 42] });
    expect(caps?.supportedEfforts).toEqual(["low"]);
  });

  it("returns undefined for absent/malformed metadata", () => {
    expect(parseModelReasoningCapabilities(undefined)).toBeUndefined();
    expect(parseModelReasoningCapabilities(null)).toBeUndefined();
    expect(parseModelReasoningCapabilities({})).toBeUndefined();
    expect(parseModelReasoningCapabilities("nope")).toBeUndefined();
  });
});

describe("anthropicBudgetTokens", () => {
  it("applies official effort ratios with a 1,024-token floor", () => {
    // low = 20%, medium = 50%, high = 80% of max_tokens (OpenRouter-documented
    // mapping for Anthropic models), floor 1024.
    expect(anthropicBudgetTokens("low", 100_000)).toBe(20_000);
    expect(anthropicBudgetTokens("medium", 100_000)).toBe(50_000);
    expect(anthropicBudgetTokens("high", 100_000)).toBe(80_000);
    expect(anthropicBudgetTokens("xhigh", 100_000)).toBe(95_000);
    expect(anthropicBudgetTokens("max", 100_000)).toBe(95_000);
  });

  it("enforces the 1,024-token minimum", () => {
    expect(anthropicBudgetTokens("low", 4_000)).toBe(1024);
    expect(anthropicBudgetTokens("medium", 2_000)).toBe(1024);
  });

  it("caps at 128,000 tokens and stays below max_tokens", () => {
    expect(anthropicBudgetTokens("xhigh", 500_000)).toBe(128_000);
    // high = 80% of max_tokens per the official formula
    // (budget = max(min(max_tokens * ratio, 128000), 1024)).
    expect(anthropicBudgetTokens("high", 1_500)).toBe(1_200);
  });

  it("returns null when a valid budget is impossible", () => {
    expect(anthropicBudgetTokens("medium", 1_000)).toBeNull();
    expect(anthropicBudgetTokens("medium", undefined)).toBeNull();
    expect(anthropicBudgetTokens("off", 100_000)).toBeNull();
    expect(anthropicBudgetTokens("auto", 100_000)).toBeNull();
  });
});

describe("resolveReasoningPlan — provider schemes", () => {
  it("openai: maps minimal/low/medium/high to reasoning_effort; off sends none, auto omits", () => {
    expect(resolveReasoningPlan({ providerId: "openai", userLevel: "minimal" })).toMatchObject({
      kind: "params",
      params: { reasoning_effort: "minimal" },
    });
    expect(resolveReasoningPlan({ providerId: "openai", userLevel: "low" })).toMatchObject({
      kind: "params",
      params: { reasoning_effort: "low" },
    });
    expect(resolveReasoningPlan({ providerId: "openai", userLevel: "medium" })).toMatchObject({
      kind: "params",
      params: { reasoning_effort: "medium" },
    });
    expect(resolveReasoningPlan({ providerId: "openai", userLevel: "high" })).toMatchObject({
      kind: "params",
      params: { reasoning_effort: "high" },
    });
    // Without live vocabulary metadata the documented "none" mapping applies.
    const off = resolveReasoningPlan({ providerId: "openai", userLevel: "off" });
    expect(off).toMatchObject({ kind: "params", level: "off", params: { reasoning_effort: "none" } });
    expect(resolveReasoningPlan({ providerId: "openai", userLevel: "default" }).kind).toBe("none");
  });

  it("openai: off sends reasoning_effort none when the model's official vocabulary advertises it", () => {
    // models.dev reasoning_options: GPT-5.1 → [none, low, medium, high];
    // "none" is the documented disable mechanism on those models.
    const caps: ModelReasoningCapabilities = { supportedEfforts: ["off", "low", "medium", "high"] };
    const plan = resolveReasoningPlan({ providerId: "openai", userLevel: "off", caps });
    expect(plan).toMatchObject({ kind: "params", params: { reasoning_effort: "none" } });
  });

  it("openai: levels outside the model's official vocabulary never reach the wire", () => {
    // GPT-5 → [minimal, low, medium, high] (no "none"): "off" cannot be
    // expressed — parameters are omitted entirely instead of sending a
    // value the model rejects.
    const gpt5: ModelReasoningCapabilities = { supportedEfforts: ["minimal", "low", "medium", "high"] };
    const off = resolveReasoningPlan({ providerId: "openai", userLevel: "off", caps: gpt5 });
    expect(off).toMatchObject({ kind: "none", level: "off" });
    expect(off.note).toContain("off not expressible");
    const minimal = resolveReasoningPlan({ providerId: "openai", userLevel: "minimal", caps: gpt5 });
    expect(minimal).toMatchObject({ kind: "params", params: { reasoning_effort: "minimal" } });
    // xhigh is outside the scheme menu → clamped to the nearest level.
    const xhigh = resolveReasoningPlan({ providerId: "openai", userLevel: "xhigh", caps: gpt5 });
    expect(xhigh).toMatchObject({ kind: "params", level: "high", params: { reasoning_effort: "high" } });
  });

  it("openai: xhigh/max are expressible and sent verbatim", () => {
    const xhigh = resolveReasoningPlan({ providerId: "openai", userLevel: "xhigh" });
    expect(xhigh).toMatchObject({ kind: "params", level: "xhigh", params: { reasoning_effort: "xhigh" } });
    const max = resolveReasoningPlan({ providerId: "openai", userLevel: "max" });
    expect(max).toMatchObject({ kind: "params", level: "max", params: { reasoning_effort: "max" } });
  });

  it("openrouter: sends the unified reasoning object with exclude: false", () => {
    const plan = resolveReasoningPlan({ providerId: "openrouter", userLevel: "medium" });
    expect(plan).toMatchObject({
      kind: "params",
      params: { reasoning: { effort: "medium", exclude: false } },
    });
  });

  it("openrouter: off sends reasoning: { effort: 'none' } (Cline codec)", () => {
    const plan = resolveReasoningPlan({ providerId: "openrouter", userLevel: "off" });
    expect(plan).toMatchObject({
      kind: "params",
      params: { reasoning: { effort: "none", exclude: false } },
    });
  });

  it("openrouter: mandatory models never get off", () => {
    const caps = { mandatory: true, defaultEffort: "medium" as const };
    const plan = resolveReasoningPlan({ providerId: "openrouter", userLevel: "off", caps });
    expect(plan.kind).toBe("params");
    expect(plan.level).toBe("medium");
    expect(plan.params).toEqual({ reasoning: { effort: "medium", exclude: false } });
  });

  it("anthropic: adaptive thinking with official output_config.effort", () => {
    const plan = resolveReasoningPlan({ providerId: "anthropic", userLevel: "high" });
    expect(plan).toMatchObject({
      kind: "params",
      params: { thinking: { type: "adaptive" }, output_config: { effort: "high" } },
    });
  });

  it("anthropic: extended thinking computes a valid budget", () => {
    const plan = resolveReasoningPlan({
      providerId: "anthropic",

      userLevel: "high",
      maxTokens: 32_000,
      anthropicMode: "extended",
    });
    expect(plan.kind).toBe("params");
    const budget = (plan.params as any).thinking?.budget_tokens as number;
    expect(budget).toBe(25_600);
    expect(budget).toBeGreaterThanOrEqual(1024);
    expect(budget).toBeLessThan(32_000);
  });

  it("anthropic: off omits thinking entirely (always-on models reject 'disabled')", () => {
    const plan = resolveReasoningPlan({ providerId: "anthropic", userLevel: "off" });
    expect(plan).toMatchObject({ kind: "none", level: "off" });
  });

  it("gemini: maps to reasoning_effort with the official subset", () => {
    const plan = resolveReasoningPlan({ providerId: "gemini", userLevel: "high" });
    expect(plan).toMatchObject({ kind: "params", params: { reasoning_effort: "high" } });
    // xhigh/max are not expressible on Gemini — clamped to high.
    const clamped = resolveReasoningPlan({ providerId: "gemini", userLevel: "xhigh" });
    expect(clamped).toMatchObject({ kind: "params", level: "high", params: { reasoning_effort: "high" } });
  });

  it("gemini: off sends reasoning_effort none (documented mapping)", () => {
    const plan = resolveReasoningPlan({ providerId: "gemini", userLevel: "off" });
    expect(plan).toMatchObject({ kind: "params", level: "off", params: { reasoning_effort: "none" } });
  });

  it("groq: off sends reasoning_effort none; xhigh clamps to the scheme vocabulary", () => {
    const withOff = resolveReasoningPlan({ providerId: "groq", userLevel: "off" });
    expect(withOff).toMatchObject({ kind: "params", params: { reasoning_effort: "none" } });
    const xhigh = resolveReasoningPlan({ providerId: "groq", userLevel: "xhigh" });
    expect(xhigh).toMatchObject({ kind: "params", level: "high", params: { reasoning_effort: "high" } });
  });

  it("groq: off is vocabulary-gated — GPT-OSS omits, Qwen sends none", () => {
    // Official Groq vocabulary: GPT-OSS → [low, medium, high] (sending
    // "none" is rejected); Qwen 3.6 27B → [none, default].
    const gptOss: ModelReasoningCapabilities = { supportedEfforts: ["low", "medium", "high"] };
    const off = resolveReasoningPlan({ providerId: "groq", userLevel: "off", caps: gptOss });
    expect(off).toMatchObject({ kind: "none", level: "off" });
    expect(off.note).toContain("off not expressible");
    const qwen: ModelReasoningCapabilities = { supportedEfforts: ["off", "default"] };
    const plan = resolveReasoningPlan({ providerId: "groq", userLevel: "off", caps: qwen });
    expect(plan).toMatchObject({ kind: "params", params: { reasoning_effort: "none" } });
    // Qwen cannot express high — clamped to the weakest expressible level.
    const high = resolveReasoningPlan({ providerId: "groq", userLevel: "high", caps: qwen });
    expect(high.kind).toBe("none");
  });



  it("per-model scheme: none (non-reasoning model) sends nothing on every provider", () => {
    for (const providerId of ["openai", "openrouter", "anthropic", "gemini", "groq", "custom"]) {
      const plan = resolveReasoningPlan({
        providerId,
        userLevel: "high",
        caps: { scheme: "none" },
      });
      expect(plan.kind).toBe("none");
      expect(plan.note).toContain("no reasoning scheme");
    }
  });

  it("unknown providers send nothing", () => {
    expect(resolveReasoningPlan({ providerId: "mistral", userLevel: "high" }).kind).toBe("none");
    expect(resolveReasoningPlan({ providerId: "together", userLevel: "high" }).kind).toBe("none");
    expect(resolveReasoningPlan({ providerId: "totally-unknown", userLevel: "high" }).kind).toBe("none");
  });

  it("puter: resolves to standard openai_effort scheme (OpenAI-compatible gateway)", () => {
    expect(resolveSchemeId("puter")).toBe("openai_effort");
    const plan = resolveReasoningPlan({ providerId: "puter", userLevel: "high" });
    expect(plan).toMatchObject({
      kind: "params",
      scheme: "openai_effort",
      params: { reasoning_effort: "high" },
    });
  });

  it("auto/default always omits parameters on every scheme", () => {
    for (const providerId of ["openai", "openrouter", "anthropic", "gemini", "groq", "custom"]) {
      expect(resolveReasoningPlan({ providerId, userLevel: "default" }).kind).toBe("none");
    }
  });

  it("custom: resolves to the custom_effort scheme (OpenAI-compatible fallback)", () => {
    // Arbitrary OpenAI-compatible endpoints use the generic custom_effort
    // scheme — no per-host special casing.
    expect(resolveSchemeId("custom")).toBe("custom_effort");
    const explicit = resolveReasoningPlan({ providerId: "custom", userLevel: "high" });
    expect(explicit).toMatchObject({ kind: "params", params: { reasoning_effort: "high" } });
    const off = resolveReasoningPlan({ providerId: "custom", userLevel: "off" });
    expect(off.kind).toBe("none");
  });

  it("the custom_effort scheme is registered for custom endpoints", () => {
    expect(SCHEMES.custom_effort).toBeDefined();
    expect(Object.values(SCHEMES).some((s) => s.id === "custom_effort")).toBe(true);
  });

  it("stripReasoning omits every parameter regardless of scheme", () => {
    for (const providerId of ["openai", "openrouter", "anthropic", "gemini", "groq", "custom"]) {
      const plan = resolveReasoningPlan({ providerId, userLevel: "high", stripReasoning: true });
      expect(plan.kind).toBe("none");
    }
  });

  it("legacy user levels are normalized before resolution", () => {
    expect(resolveReasoningPlan({ providerId: "openai", userLevel: "disabled" }).level).toBe("off");
    expect(resolveReasoningPlan({ providerId: "openai", userLevel: "default" }).kind).toBe("none");
  });
});

describe("getReasoningLevels", () => {
  it("returns only model-supported levels per scheme", () => {
    const openai = getReasoningLevels({ providerId: "openai" });
    expect(openai.map((l) => l.value)).toEqual(["off", "default", "minimal", "low", "medium", "high", "xhigh", "max"]);

    const gemini = getReasoningLevels({ providerId: "gemini" });
    expect(gemini.map((l) => l.value)).toEqual(["off", "default", "minimal", "low", "medium", "high"]);

    const anthropic = getReasoningLevels({ providerId: "anthropic" });
    expect(anthropic.map((l) => l.value)).toEqual(["off", "default", "low", "medium", "high", "xhigh", "max"]);
  });

  it("narrows the menu to the model's official effort vocabulary", () => {
    // GPT-5.1 → [none, low, medium, high] (none is dropped — not canonical);
    // GPT-5 → [minimal, low, medium, high] (no off — reasoning cannot be disabled).
    const gpt51 = getReasoningLevels({ providerId: "openai", caps: { supportedEfforts: ["off", "low", "medium", "high"] } });
    expect(gpt51.map((l) => l.value)).toEqual(["off", "default", "low", "medium", "high"]);
    const gpt5 = getReasoningLevels({ providerId: "openai", caps: { supportedEfforts: ["minimal", "low", "medium", "high"] } });
    expect(gpt5.map((l) => l.value)).toEqual(["default", "minimal", "low", "medium", "high"]);
    // GPT-OSS 20B → [low, medium, high].
    const groq = getReasoningLevels({ providerId: "groq", caps: { supportedEfforts: ["low", "medium", "high"] } });
    expect(groq.map((l) => l.value)).toEqual(["default", "low", "medium", "high"]);
  });

  it("closes the surface when the model advertises no effort options", () => {
    // reasoning_options: [] — reasoning advertised but no user-controllable
    // effort options: the selector hides and no effort parameter is sent.
    expect(getReasoningLevels({ providerId: "openai", caps: { supportedEfforts: [] } })).toEqual([]);
  });

  it("returns an empty list for per-model scheme none (non-reasoning models)", () => {
    // A model the registry marks as non-reasoning carries `{ scheme: "none" }`
    // caps — the selector must disappear even on reasoning-capable providers.
    expect(getReasoningLevels({ providerId: "openai", caps: { scheme: "none" } })).toEqual([]);
    expect(getReasoningLevels({ providerId: "nvidia", caps: { scheme: "none" } })).toEqual([]);
    expect(getReasoningLevels({ providerId: "openrouter", caps: { scheme: "none" } })).toEqual([]);
  });

  it("offers the scheme's full documented menu", () => {
    const levels = getReasoningLevels({ providerId: "openrouter" });
    expect(levels.map((l) => l.value)).toEqual(["off", "default", "minimal", "low", "medium", "high", "xhigh", "max"]);
  });

  it("hides off for mandatory-reasoning models", () => {
    const levels = getReasoningLevels({
      providerId: "openrouter",
      caps: { mandatory: true },
    });
    expect(levels.some((l) => l.value === "off")).toBe(false);
  });

  it("returns an empty list for providers with no reasoning surface", () => {
    expect(getReasoningLevels({ providerId: "mistral" })).toEqual([]);
    expect(getReasoningLevels({ providerId: "unknown" })).toEqual([]);
  });

  it("puter returns full openai_effort levels (OpenAI-compatible gateway)", () => {
    const levels = getReasoningLevels({ providerId: "puter" });
    expect(levels.map((l) => l.value)).toEqual(["off", "default", "minimal", "low", "medium", "high", "xhigh", "max"]);
  });
});
