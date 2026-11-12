import { PROVIDERS, getProvider } from "@/lib/ai/providers";
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
  /** Maximum context window allowed by the server / provider definition. Caps UI config. */
  serverContextWindow?: number;
  /** Present when the user explicitly set `contextWindow`; capped by `serverContextWindow`. */
  contextWindowSource?: "user";
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
          const serverContextWindow = typeof item.serverContextWindow === "number" ? item.serverContextWindow : undefined;
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
            serverContextWindow,
            contextWindowSource: item.contextWindowSource === "user" ? "user" : undefined,
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

/**
 * Persist decision for a models fetch: only overwrite the stored config when
 * the fetch actually listed something, or when there is nothing stored to
 * lose. An empty fetch means "endpoint silent/absent" — persisting it would
 * wipe hand-curated entries on every transient failure (401/429/5xx).
 */
export function shouldPersistFetchedModels(fetchedCount: number, storedCount: number): boolean {
  return fetchedCount > 0 || storedCount === 0;
}

/**
 * Effective context window for a freshly fetched model. When the server
 * defines a context window (live detection or stored server definition),
 * that server context is prioritized and acts as the default one AND the
 * strict maximum cap for any user UI configuration.
 */
export function resolveModelContextWindow(
  prev: ProviderModelConfig | undefined,
  detected: number | undefined,
  fallbacks: readonly (number | undefined)[],
): { contextWindow?: number; serverContextWindow?: number; contextWindowSource?: "user" } {
  const serverContext =
    typeof detected === "number" && detected > 0
      ? detected
      : typeof prev?.serverContextWindow === "number" && prev.serverContextWindow > 0
        ? prev.serverContextWindow
        : undefined;

  if (serverContext !== undefined) {
    const userCw =
      prev?.contextWindowSource === "user" && typeof prev.contextWindow === "number" && prev.contextWindow > 0
        ? prev.contextWindow
        : undefined;

    const effectiveCw = userCw !== undefined ? Math.min(userCw, serverContext) : serverContext;

    return {
      contextWindow: effectiveCw,
      serverContextWindow: serverContext,
      contextWindowSource: userCw !== undefined && userCw < serverContext ? "user" : undefined,
    };
  }

  if (prev?.contextWindowSource === "user" && typeof prev.contextWindow === "number" && prev.contextWindow > 0) {
    return { contextWindow: prev.contextWindow, contextWindowSource: "user" };
  }
  if (typeof prev?.contextWindow === "number" && prev.contextWindow > 0) {
    return { contextWindow: prev.contextWindow, contextWindowSource: prev.contextWindowSource };
  }
  const fallback = fallbacks.find((f) => typeof f === "number" && f > 0);
  return fallback !== undefined ? { contextWindow: fallback } : {};
}

/** Resolves model billing rate (USD per 1M tokens) from runtime model config or provider catalog. */
export function getModelRate(
  provider: string,
  model: string,
  runtimeModels?: ReadonlyArray<{ id: string; pricing?: ModelRate }>,
): ModelRate | null {
  const runtime = runtimeModels?.find((m) => m.id === model);
  if (runtime?.pricing) return runtime.pricing;
  const providerPricing =
    (getProvider(provider as ProviderId) ?? PROVIDERS[provider as ProviderId])?.pricing;
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


