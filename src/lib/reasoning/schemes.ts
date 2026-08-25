/** Declarative, officially-sourced mappings from universal reasoning levels to provider API parameters. */

import type {
  ModelReasoningCapabilities,
  ReasoningSchemeId,
  ThinkingLevel,
} from "./types";
import { THINKING_LEVELS } from "./types";

/** Canonical display order, weakest → strongest (used for clamping/UI). */
export const LEVEL_ORDER: readonly ThinkingLevel[] = THINKING_LEVELS;

/**
 * Restricts a scheme's level menu to the model's advertised effort vocabulary (models.dev `reasoning_options`).
 * Returns `[]` when reasoning has no user-controllable options, or `undefined` when no vocabulary is advertised.
 */
function restrictByCapabilities(
  caps?: ModelReasoningCapabilities,
  opts?: { keepOff?: boolean },
): readonly ThinkingLevel[] | undefined {
  if (caps?.supportedEfforts === undefined) return undefined;
  if (caps.supportedEfforts.length === 0) {
    // No user-controllable effort options: omit reasoning parameters entirely.
    return [];
  }
  const seen = new Set<ThinkingLevel>();
  const list: ThinkingLevel[] = [];
  const seed: ThinkingLevel[] = opts?.keepOff ? ["off", "default"] : ["default"];
  for (const level of [...seed, ...caps.supportedEfforts]) {
    if (seen.has(level)) continue;
    seen.add(level);
    list.push(level);
  }
  return list;
}

export interface ReasoningPlan {
  kind: "none" | "params";
  scheme: ReasoningSchemeId;
  /** The effective level that was applied (after normalization/clamping). */
  level: ThinkingLevel;
  /** Body parameters to merge into the request when `kind === "params"`. */
  params?: Record<string, any>;
  /**
   * Per-model provider-specific extras to merge alongside `params` when reasoning is emitted.
   * Sourced from live per-model metadata via `caps.extraBody`; never derived from model ids.
   */
  extraBody?: Record<string, unknown>;
  /** Why a selection was dropped/clamped (for logs and diagnostics). */
  note?: string;
}

export interface SchemeMapContext {
  /** The model's max output tokens (Anthropic-style budget math needs it). */
  maxTokens?: number;
  /** Live per-model capabilities when available. */
  caps?: ModelReasoningCapabilities;
  /** For Anthropic: which thinking mode to emit (adaptive vs extended). */
  anthropicMode?: "adaptive" | "extended";
}

export interface ReasoningScheme {
  id: ReasoningSchemeId;
  docUrl: string;
  /** Levels the scheme can express, weakest → strongest. */
  supportedLevels: readonly ThinkingLevel[];
  /** Whether "off" is expressible (vs. always-on models). */
  canDisable: boolean;
  /** Map a level to official request-body params; null = omit reasoning params. */
  map: (level: ThinkingLevel, ctx: SchemeMapContext) => Record<string, any> | null;
  /** Restrict the levels offered for a specific model (capability-driven). */
  restrictForModel?: (caps?: ModelReasoningCapabilities) => readonly ThinkingLevel[] | undefined;
}

/** Compute an Anthropic-style extended-thinking token budget from an effort level. */
export function anthropicBudgetTokens(level: ThinkingLevel, maxTokens?: number): number | null {
  // Effort → budget ratios documented by OpenRouter for Anthropic models
  // (budget_tokens = max(min(max_tokens * ratio, 128000), 1024)).
  const RATIOS: Partial<Record<ThinkingLevel, number>> = {
    low: 0.2,
    medium: 0.5,
    high: 0.8,
    xhigh: 0.95,
    max: 0.95,
  };
  const ratio = RATIOS[level];
  if (ratio === undefined) return null;
  if (!maxTokens || maxTokens <= 0) return null;

  // Official constraints: minimum 1,024 tokens; budget must be < max_tokens.
  const raw = Math.min(maxTokens * ratio, 128_000);
  const floor = Math.max(Math.round(raw), 1024);
  if (floor >= maxTokens) {
    return maxTokens > 1024 ? maxTokens - 1 : null;
  }
  return floor;
}

export const SCHEMES: Record<ReasoningSchemeId, ReasoningScheme> = {
  none: {
    id: "none",
    docUrl: "",
    supportedLevels: [],
    canDisable: false,
    map: () => null,
  },

  openai_effort: {
    id: "openai_effort",
    docUrl: "https://platform.openai.com/docs/guides/reasoning",
    supportedLevels: ["off", "default", "minimal", "low", "medium", "high", "xhigh", "max"],
    canDisable: true,
    map: (level, ctx) => {
      if (level === "default") return null;
      if (level === "off") {
        // Only send "none" if the model's advertised vocabulary supports turning reasoning off.
        if (ctx.caps?.supportedEfforts && !ctx.caps.supportedEfforts.includes("off")) return null;
        return { reasoning_effort: "none" };
      }
      return { reasoning_effort: level };
    },
    restrictForModel: restrictByCapabilities,
  },

  openrouter_reasoning: {
    id: "openrouter_reasoning",
    docUrl: "https://openrouter.ai/docs/guides/best-practices/reasoning-tokens.mdx",
    supportedLevels: ["off", "default", "minimal", "low", "medium", "high", "xhigh", "max"],
    canDisable: true,
    map: (level, ctx) => {
      if (level === "default") return null;
      if (level === "off") {
        // Mandatory reasoning models are clamped prior to reaching this handler.
        return { reasoning: { effort: "none", exclude: false } };
      }
      return { reasoning: { effort: level, exclude: false } };
    },
    restrictForModel: (caps) => restrictByCapabilities(caps, { keepOff: true }),
  },

  anthropic_thinking: {
    id: "anthropic_thinking",
    docUrl: "https://docs.anthropic.com/en/docs/build-with-claude/effort",
    supportedLevels: ["off", "default", "low", "medium", "high", "xhigh", "max"],
    canDisable: true,
    map: (level, ctx) => {
      if (level === "default") return null;
      if (level === "off") {
        // Anthropic disables thinking by omitting the parameter entirely across all models.
        return null;
      }

      const mode = ctx.anthropicMode ?? "adaptive";
      if (mode === "extended") {
        // Manual extended thinking requires a budget token floor of 1,024 and temperature: 1.
        const budget = anthropicBudgetTokens(level, ctx.maxTokens);
        if (budget === null) return null;
        return {
          thinking: { type: "enabled", budget_tokens: budget },
          temperature: 1,
        };
      }
      // Adaptive thinking lets Claude adjust depth via `output_config.effort`.
      return {
        thinking: { type: "adaptive" },
        output_config: { effort: level },
        temperature: 1,
      };
    },
  },

  gemini_effort: {
    id: "gemini_effort",
    docUrl: "https://ai.google.dev/gemini-api/docs/openai",
    supportedLevels: ["off", "default", "minimal", "low", "medium", "high"],
    canDisable: true,
    map: (level, ctx) => {
      if (level === "default") return null;
      if (level === "off") {
        // Only send "none" if advertised in the model's vocabulary; otherwise omit.
        if (ctx.caps?.supportedEfforts && !ctx.caps.supportedEfforts.includes("off")) return null;
        return { reasoning_effort: "none" };
      }
      return { reasoning_effort: level };
    },
    restrictForModel: restrictByCapabilities,
  },

  groq_effort: {
    id: "groq_effort",
    docUrl: "https://console.groq.com/docs/reasoning",
    // Groq accepts `low | medium | high`; `off` and `default` omit reasoning parameters.
    supportedLevels: ["off", "default", "low", "medium", "high"],
    canDisable: true,
    map: (level, ctx) => {
      if (level === "default") return null;
      if (level === "off") {
        // Send "none" only if supported by the model's capability vocabulary; otherwise omit.
        if (ctx.caps?.supportedEfforts && !ctx.caps.supportedEfforts.includes("off")) return null;
        return { reasoning_effort: "none" };
      }
      return { reasoning_effort: level };
    },
    restrictForModel: restrictByCapabilities,
  },


  custom_effort: {
    id: "custom_effort",
    docUrl: "",
    supportedLevels: ["off", "default", "minimal", "low", "medium", "high", "xhigh", "max"],
    canDisable: true,
    map: (level) => {
      // Omit parameters for default/off; forward explicit levels per OpenAI-compatible standard.
      if (level === "default" || level === "off") return null;
      return { reasoning_effort: level };
    },
    restrictForModel: (caps) => restrictByCapabilities(caps, { keepOff: true }),
  },
};

/** Resolves the scheme ID for a provider, prioritizing live per-model capability overrides. */
export function resolveSchemeId(providerId: string, caps?: ModelReasoningCapabilities): ReasoningSchemeId {
  if (caps?.scheme && caps.scheme in SCHEMES) return caps.scheme;
  switch (providerId) {
    case "openai":
    case "puter":
      return "openai_effort";
    case "openrouter":
      return "openrouter_reasoning";
    case "anthropic":
      return "anthropic_thinking";
    case "gemini":
      return "gemini_effort";
    case "groq":
      return "groq_effort";
    // OpenAI-compatible gateways routed through custom effort scheme.
    case "nvidia":
    case "zen":
    case "custom":
      return "custom_effort";
    default:
      // Providers without documented reasoning parameters send nothing.
      return "none";
  }
}

/** The levels a scheme can offer for a specific model (after capability filtering). */
export function levelsForScheme(scheme: ReasoningScheme, caps?: ModelReasoningCapabilities): readonly ThinkingLevel[] {
  const restricted = scheme.restrictForModel?.(caps);
  const base = restricted ?? scheme.supportedLevels;
  if (caps?.mandatory) {
    // Reasoning cannot be turned off on this model.
    return base.filter((l) => l !== "off");
  }
  return base;
}
