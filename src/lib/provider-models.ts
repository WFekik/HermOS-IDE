import { PROVIDERS } from "@/lib/ai/providers";
import type { ProviderId } from "@/lib/types";
import {
  THINKING_LEVELS,
  normalizeThinkingLevel,
  parseModelReasoningCapabilities,
  type ModelReasoningCapabilities,
  type ThinkingLevel,
} from "@/lib/reasoning";
import {
  reasoningCapsFromRegistryEntry,
  type RegistryReasoningInfo,
} from "@/lib/reasoning/registry-caps";

/** Re-exports canonical thinking-level vocabulary and reasoning types for backward compatibility. */
export { THINKING_LEVELS, type ModelReasoningCapabilities, type ThinkingLevel };

/** Billing rate in USD per 1M tokens (input `in`, output `out`). */
export type ModelRate = { in: number; out: number };

export interface ProviderModelConfig {
  id: string;
  enabled: boolean;
  thinkingLevel: ThinkingLevel;
  contextWindow?: number;
  maxOutput?: number;
  /** Live per-model pricing (USD per 1M tokens) from provider /models metadata. */
  pricing?: ModelRate;
  /** Live per-model reasoning capabilities (OpenRouter metadata etc.). */
  reasoning?: ModelReasoningCapabilities;
}

/** Parses `ProviderKey.models` JSON into configured model array, normalizing legacy thinking levels. */
export function parseModelsColumn(raw: string | null | undefined): ProviderModelConfig[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v
      .map((item): ProviderModelConfig | null => {
        if (typeof item === "string") {
          return { id: item, enabled: true, thinkingLevel: "default" };
        }
        if (item && typeof item === "object") {
          const id = typeof item.id === "string" ? item.id : null;
          if (!id) return null;
          const enabled = item.enabled !== false;
          const contextWindow = typeof item.contextWindow === "number" ? item.contextWindow : undefined;
          const maxOutput = typeof item.maxOutput === "number" ? item.maxOutput : undefined;
          const pricing =
            item.pricing &&
            typeof item.pricing === "object" &&
            typeof item.pricing.in === "number" &&
            typeof item.pricing.out === "number"
              ? { in: item.pricing.in, out: item.pricing.out }
              : undefined;
          return {
            id,
            enabled,
            thinkingLevel: normalizeThinkingLevel(item.thinkingLevel),
            contextWindow,
            maxOutput,
            pricing,
            reasoning: parseModelReasoningCapabilities(item.reasoning),
          };
        }
        return null;
      })
      .filter((x): x is ProviderModelConfig => x !== null);
  } catch {
    return [];
  }
}

/** Resolves model billing rate (USD per 1M tokens) from runtime model config or provider catalog. */
export function getModelRate(
  provider: string,
  model: string,
  runtimeModels?: ReadonlyArray<{ id: string; pricing?: ModelRate }>,
): ModelRate | null {
  const runtime = runtimeModels?.find((m) => m.id === model);
  if (runtime?.pricing) return runtime.pricing;
  const providerPricing = PROVIDERS[provider as ProviderId]?.pricing;
  if (providerPricing) return providerPricing;
  return null;
}

/** Merges per-model reasoning capabilities from live metadata, persisted state, and registry facts. */
export function mergeReasoningCapability(
  liveCaps: ModelReasoningCapabilities | undefined,
  prevCaps: ModelReasoningCapabilities | undefined,
  registryEntry: RegistryReasoningInfo | undefined,
): ModelReasoningCapabilities | undefined {
  if (liveCaps) return liveCaps;
  const registryCaps = reasoningCapsFromRegistryEntry(registryEntry);
  if (!prevCaps) return registryCaps;
  // Explicit `reasoning: false` closes the surface and drops stale persisted efforts.
  if (registryCaps?.scheme === "none") return { scheme: "none" };
  // No registry entry available; keep persisted capabilities.
  if (!registryEntry) return prevCaps;
  const merged: ModelReasoningCapabilities = { ...prevCaps };
  // Reconcile against registry facts (reasoning flag, effort options, interleaved field).
  if (
    registryEntry.reasoning !== undefined ||
    registryEntry.reasoningOptions !== undefined ||
    registryEntry.interleavedField !== undefined
  ) {
    // Drop stale interleaved field if the provider registry entry specifies none.
    if (registryEntry.interleavedField === undefined && merged.interleavedField) {
      delete merged.interleavedField;
    }
    // Empty effort options indicates no user control: clear supported efforts.
    if (registryCaps?.supportedEfforts !== undefined && registryCaps.supportedEfforts.length === 0) {
      merged.supportedEfforts = [];
    }
  }
  if (!merged.supportedEfforts?.length && registryCaps?.supportedEfforts?.length) {
    merged.supportedEfforts = registryCaps.supportedEfforts;
  }
  if (!merged.interleavedField && registryCaps?.interleavedField) {
    merged.interleavedField = registryCaps.interleavedField;
  }
  return merged;
}


