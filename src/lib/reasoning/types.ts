/** Universal reasoning and thinking-level vocabulary shared across all providers. */

/** Canonical, provider-agnostic thinking levels (strongest last). */
export const THINKING_LEVELS = [
  "off",
  "default",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** Legacy thinking levels accepted on input and normalized via {@link normalizeThinkingLevel}. */
export const LEGACY_THINKING_LEVELS = ["disabled", "default", "enabled"] as const;

/** Every value accepted on input (current vocabulary + legacy aliases). */
export const THINKING_LEVEL_INPUTS = [
  ...THINKING_LEVELS,
  ...LEGACY_THINKING_LEVELS,
] as const;

export type ThinkingLevelInput = (typeof THINKING_LEVEL_INPUTS)[number];

const LEGACY_TO_LEVEL: Readonly<Record<string, ThinkingLevel>> = {
  disabled: "off",
  default: "default",
  enabled: "default",
};

/** Normalizes any stored or input thinking level to canonical vocabulary; defaults to `"default"`. */
export function normalizeThinkingLevel(raw: unknown): ThinkingLevel {
  if (typeof raw === "string") {
    if ((THINKING_LEVELS as readonly string[]).includes(raw)) return raw as ThinkingLevel;
    const mapped = LEGACY_TO_LEVEL[raw];
    if (mapped) return mapped;
  }
  return "default";
}

/** Declarative reasoning parameter scheme identifiers per provider family. */
export const REASONING_SCHEME_IDS = [
  "none", // No reasoning parameters exist (or none are officially documented)
  "openai_effort", // OpenAI `reasoning_effort`
  "openrouter_reasoning", // OpenRouter unified `reasoning: { effort }`
  "anthropic_thinking", // Anthropic `thinking` (adaptive / extended) + `output_config.effort`
  "gemini_effort", // Gemini OpenAI-compat `reasoning_effort` → `thinking_level`/`thinking_budget`
  "groq_effort", // Groq `reasoning_effort` (model-dependent subsets)
  "custom_effort", // Unknown OpenAI-compatible endpoint — omit unless the user asks, learn behaviorally
] as const;

export type ReasoningSchemeId = (typeof REASONING_SCHEME_IDS)[number];

/** Per-model reasoning capabilities captured from provider metadata and persisted in model config. */
export interface ModelReasoningCapabilities {
  /** Official effort levels accepted by the model. `[]` indicates reasoning with no user controls. */
  supportedEfforts?: ThinkingLevel[];
  /** Pre-selected effort when reasoning is enabled without an explicit level. */
  defaultEffort?: ThinkingLevel;
  /** Reasoning is mandatory on this model — it cannot be turned off. */
  mandatory?: boolean;
  /** Default on/off state when the user has not chosen anything. */
  defaultEnabled?: boolean;
  /** The model accepts a reasoning token budget (Anthropic-style) too. */
  supportsMaxTokens?: boolean;
  /** Assistant message field used to echo reasoning content back on multi-turn requests. */
  interleavedField?: string;
  /** Optional per-model scheme override (from live provider metadata). */
  scheme?: ReasoningSchemeId;
  /** Per-model provider extras merged into request body when reasoning parameters are emitted. */
  extraBody?: Record<string, unknown>;
}

/** Read a field accepting the live snake_case key or the persisted camelCase key. */
function pickCapsKey(raw: Record<string, unknown>, snake: string, camel: string): unknown {
  return raw[camel] ?? raw[snake];
}

/** Parses raw wire or persisted reasoning metadata into normalized capabilities. */
export function parseModelReasoningCapabilities(raw: unknown): ModelReasoningCapabilities | undefined {
  if (!raw || typeof raw !== "object") return undefined;

  const r = raw as Record<string, unknown>;
  const caps: ModelReasoningCapabilities = {};

  const supportedEfforts = pickCapsKey(r, "supported_efforts", "supportedEfforts");
  if (Array.isArray(supportedEfforts)) {
    // Empty array denotes reasoning support without user-controllable effort options.
    const efforts = supportedEfforts
      .map((e) => normalizeThinkingLevel(e))
      .filter((e): e is ThinkingLevel => e !== "default");
    caps.supportedEfforts = efforts.length > 0 ? efforts : [];
  }

  const defaultEffort = normalizeThinkingLevel(pickCapsKey(r, "default_effort", "defaultEffort"));
  if (defaultEffort !== "default" && defaultEffort !== "off") caps.defaultEffort = defaultEffort;

  const mandatory = pickCapsKey(r, "mandatory", "mandatory");
  if (typeof mandatory === "boolean") caps.mandatory = mandatory;

  const defaultEnabled = pickCapsKey(r, "default_enabled", "defaultEnabled");
  if (typeof defaultEnabled === "boolean") caps.defaultEnabled = defaultEnabled;

  const supportsMaxTokens = pickCapsKey(r, "supports_max_tokens", "supportsMaxTokens");
  if (typeof supportsMaxTokens === "boolean") caps.supportsMaxTokens = supportsMaxTokens;

  const interleavedField = pickCapsKey(r, "interleaved_field", "interleavedField");
  if (typeof interleavedField === "string" && interleavedField.trim()) {
    caps.interleavedField = interleavedField;
  }

  const scheme = pickCapsKey(r, "scheme", "scheme");
  if (typeof scheme === "string" && (REASONING_SCHEME_IDS as readonly string[]).includes(scheme)) {
    caps.scheme = scheme as ReasoningSchemeId;
  }

  const extraBody = pickCapsKey(r, "extra_body", "extraBody");
  if (extraBody && typeof extraBody === "object" && !Array.isArray(extraBody)) {
    caps.extraBody = extraBody as Record<string, unknown>;
  }

  return Object.keys(caps).length > 0 ? caps : undefined;
}

