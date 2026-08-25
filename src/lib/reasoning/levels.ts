/** UI-facing thinking level options and metadata tailored to provider and model capabilities. */

import type { ModelReasoningCapabilities, ThinkingLevel } from "./types";
import { levelsForScheme, resolveSchemeId, SCHEMES, LEVEL_ORDER } from "./schemes";

export interface ThinkingLevelOption {
  value: ThinkingLevel;
  label: string;
  desc: string;
}

const OPTION_META: Record<ThinkingLevel, { label: string; desc: string }> = {
  off: { label: "Off", desc: "No reasoning / thinking" },
  default: { label: "Default", desc: "Model default" },
  minimal: { label: "Minimal", desc: "Minimal reasoning (fastest)" },
  low: { label: "Low", desc: "Efficient reasoning" },
  medium: { label: "Medium", desc: "Balanced reasoning" },
  high: { label: "High", desc: "Deep reasoning" },
  xhigh: { label: "X-High", desc: "Extended deep reasoning" },
  max: { label: "Max", desc: "Maximum reasoning" },
};

export interface GetReasoningLevelsInput {
  providerId: string;
  /** Live per-model reasoning capabilities (OpenRouter metadata etc.). */
  caps?: ModelReasoningCapabilities;
}

/** Returns supported thinking level options for the given provider and model capabilities. */
export function getReasoningLevels(input: GetReasoningLevelsInput): ThinkingLevelOption[] {
  const schemeId = resolveSchemeId(input.providerId, input.caps);
  const scheme = SCHEMES[schemeId];
  if (schemeId === "none" || scheme.supportedLevels.length === 0) return [];
  // Sort in canonical weakest -> strongest order.
  return levelsForScheme(scheme, input.caps)
    .slice()
    .sort((a, b) => LEVEL_ORDER.indexOf(a) - LEVEL_ORDER.indexOf(b))
    .map((value) => ({
      value,
      ...OPTION_META[value],
    }));
}
