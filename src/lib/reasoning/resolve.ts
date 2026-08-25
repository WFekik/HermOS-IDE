/** Resolves user thinking-level preferences into provider-specific request parameters without heuristics. */

import type { ModelReasoningCapabilities, ThinkingLevel } from "./types";
import { normalizeThinkingLevel } from "./types";
import {
  LEVEL_ORDER,
  SCHEMES,
  levelsForScheme,
  resolveSchemeId,
  type ReasoningPlan,
  type ReasoningScheme,
  type SchemeMapContext,
} from "./schemes";

export interface ResolveReasoningInput {
  providerId: string;
  /** Raw user preference (canonical or legacy vocabulary). */
  userLevel?: string;
  /** Live per-model reasoning capabilities (OpenRouter metadata etc.). */
  caps?: ModelReasoningCapabilities;
  maxTokens?: number;
  /** Learned flag: this host previously rejected reasoning params (custom endpoints). */
  hostRejectsReasoning?: boolean;
  /** Learned flag: this specific model on this host previously rejected reasoning params. */
  modelRejectsReasoning?: boolean;
  /** Forced Anthropic thinking mode (used by the executor's retry ladder). */
  anthropicMode?: "adaptive" | "extended";
  /** Force-omit all reasoning parameters during retry-after-rejection attempts. */
  stripReasoning?: boolean;
}

function none(scheme: string, level: ThinkingLevel, note?: string): ReasoningPlan {
  return { kind: "none", scheme: scheme as ReasoningPlan["scheme"], level, note };
}

/** Clamp a level to the nearest expressible level (weakest→strongest order). */
function clampToSupported(
  scheme: ReasoningScheme,
  caps: ModelReasoningCapabilities | undefined,
  level: ThinkingLevel,
): ThinkingLevel {
  const levels = levelsForScheme(scheme, caps);
  if (levels.includes(level)) return level;
  if (levels.length === 0) return "default";

  // Pick nearest supported level in canonical order; ties favor the weaker level.
  const idx = LEVEL_ORDER.indexOf(level);
  let best: ThinkingLevel = levels[0];
  let bestDist = Infinity;
  for (const candidate of levels) {
    const dist = Math.abs(LEVEL_ORDER.indexOf(candidate) - idx);
    if (dist < bestDist || (dist === bestDist && LEVEL_ORDER.indexOf(candidate) < LEVEL_ORDER.indexOf(best))) {
      best = candidate;
      bestDist = dist;
    }
  }
  return best;
}

/** Resolves the complete reasoning plan for a request based on provider and capability metadata. */
export function resolveReasoningPlan(input: ResolveReasoningInput): ReasoningPlan {
  const schemeId = resolveSchemeId(input.providerId, input.caps);
  const scheme = SCHEMES[schemeId];
  const level = normalizeThinkingLevel(input.userLevel);

  // No officially documented reasoning surface → nothing to send.
  if (schemeId === "none" || scheme.supportedLevels.length === 0) {
    return none(schemeId, "default", "no reasoning scheme for provider");
  }

  // Retry-after-rejection: omit all reasoning parameters to avoid repeating failures.
  if (input.stripReasoning) {
    return none(schemeId, normalizeThinkingLevel(input.userLevel), "reasoning parameters stripped after rejection");
  }

  // Provider default → omit reasoning parameters entirely.
  if (level === "default") return none(schemeId, "default");

  // Skip reasoning parameters if this custom host previously rejected them.
  if (input.hostRejectsReasoning && schemeId === "custom_effort") {
    return none(schemeId, "default", "host previously rejected reasoning parameters");
  }

  // Skip reasoning parameters if this specific model previously rejected them.
  if (input.modelRejectsReasoning) {
    return none(schemeId, "default", "model previously rejected reasoning parameters");
  }

  const ctx: SchemeMapContext = {
    maxTokens: input.maxTokens,
    caps: input.caps,
    anthropicMode: input.anthropicMode,
  };

  // "off" — disable reasoning where the scheme allows it.
  if (level === "off") {
    if (!scheme.canDisable) return none(schemeId, "default", "reasoning cannot be disabled on this model");
    if (input.caps?.mandatory) {
      const fallback = clampToSupported(scheme, input.caps, input.caps.defaultEffort ?? "medium");
      return emitParams(scheme, fallback, ctx, input, "mandatory reasoning — off clamped to model default");
    }
    // If the model cannot express "off", omit parameters so model default applies.
    const expressible = levelsForScheme(scheme, input.caps);
    if (expressible.length > 0 && !expressible.includes("off")) {
      return none(schemeId, "off", "off not expressible on this model — omitting reasoning parameters");
    }
    return emitParams(scheme, "off", ctx, input);
  }

  // Explicit effort level — clamp to what the model can actually express.
  const effective = clampToSupported(scheme, input.caps, level);
  if (effective === "default") return none(schemeId, level, "no expressible level for this model");
  if (effective === "off") return emitParams(scheme, "off", ctx, input, `${level} → off`);
  return emitParams(
    scheme,
    effective,
    ctx,
    input,
    effective !== level ? `${level} clamped to ${effective}` : undefined,
  );
}

function emitParams(
  scheme: ReasoningScheme,
  level: ThinkingLevel,
  ctx: SchemeMapContext,
  input: ResolveReasoningInput,
  note?: string,
): ReasoningPlan {
  let params: Record<string, any> | null = null;
  try {
    params = scheme.map(level, ctx);
  } catch {
    params = null;
  }
  if (!params || Object.keys(params).length === 0) {
    // Retain requested level for diagnostics when no parameters are expressible.
    return none(scheme.id, level, note ? `${note}; parameters not applicable` : "parameters not applicable");
  }
  return {
    kind: "params",
    scheme: scheme.id,
    level,
    params,
    extraBody: ctx.caps?.extraBody,
    note,
  };
}
