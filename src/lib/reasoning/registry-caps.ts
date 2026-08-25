/** Maps models.dev registry reasoning facts onto the canonical capability surface (browser-safe). */

import { normalizeThinkingLevel, type ModelReasoningCapabilities } from "./types";

/** Registry facts about a model's reasoning surface (models.dev). */
export interface RegistryReasoningInfo {
  /** Official per-model reasoning support flag. */
  reasoning?: boolean;
  /** Official effort values from models.dev `reasoning_options` (`[]` = no user-controllable effort). */
  reasoningOptions?: string[];
  /** models.dev `interleaved.field` (e.g. `"reasoning_content"`). */
  interleavedField?: string;
}

export function reasoningCapsFromRegistryEntry(
  entry: RegistryReasoningInfo | undefined,
): ModelReasoningCapabilities | undefined {
  if (!entry) return undefined;
  const caps: ModelReasoningCapabilities = {};
  if (entry.reasoning === false) caps.scheme = "none";
  if (entry.reasoningOptions !== undefined) {
    if (entry.reasoningOptions.length === 0) {
      // Empty effort options: close surface and send no effort parameters.
      caps.supportedEfforts = [];
    } else {
      const seen = new Set<string>();
      const efforts: ModelReasoningCapabilities["supportedEfforts"] = [];
      for (const raw of entry.reasoningOptions) {
        const level = raw === "none" ? "off" : normalizeThinkingLevel(raw);
        if (level === "default" || seen.has(level)) continue;
        seen.add(level);
        efforts.push(level);
      }
      if (efforts.length > 0) caps.supportedEfforts = efforts;
    }
  }
  if (entry.interleavedField) caps.interleavedField = entry.interleavedField;
  return Object.keys(caps).length > 0 ? caps : undefined;
}
