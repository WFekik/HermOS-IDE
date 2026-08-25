import { getModelRate } from "@/lib/provider-models";
import type { ModelRate } from "@/lib/provider-models";

/**
 * Structural subset of a chat message needed for usage aggregation.
 * Deliberately decoupled from UIMessage so the store never needs importing.
 */
export interface MessageStatsSource {
  id: string;
  tokensIn?: number | null;
  tokensOut?: number | null;
  promptTokens?: number | null;
  /** True when `promptTokens` was set from a live estimate, not provider usage. */
  promptTokensEstimated?: boolean | null;
  cacheReads?: number | null;
  cacheWrites?: number | null;
  provider?: string | null;
  model?: string | null;
}

/** Structural subset of a provider catalog entry (models with optional pricing). */
export interface MessageStatsModel {
  id: string;
  pricing?: ModelRate;
}

/** Structural subset of a provider catalog entry. */
export interface MessageStatsProvider {
  id: string;
  models?: ReadonlyArray<MessageStatsModel> | null;
}

export interface MessageStats {
  tokensIn: number;
  tokensOut: number;
  totalTokens: number;
  lastPromptTokens: number;
  /** True when the most recent `promptTokens` reading came from an estimate. */
  lastPromptTokensEstimated: boolean;
  cacheReadsTotal: number;
  cacheWritesTotal: number;
  costValue: number;
  costUnknown: boolean;
}

/**
 * Single-pass aggregation of token usage and cost across a message list.
 * All numbers are measured values (or zero) — estimates are only ever
 * surfaced via `lastPromptTokensEstimated`, which tracks the provenance
 * of the most recent `promptTokens` reading (true = live BPE estimate,
 * false = provider-measured).
 * Missing per-message provider/model falls back to the active selection.
 * `costUnknown` mirrors the original semantics: rate missing for at least
 * one measured message AND no priced tokens accumulated yet.
 */
export function aggregateMessageStats(
  messages: readonly MessageStatsSource[],
  selectedProvider: string,
  selectedModel: string,
  providers: readonly MessageStatsProvider[],
): MessageStats {
  let inSum = 0;
  let outSum = 0;
  let lastPromptTokens = 0;
  let lastPromptTokensEstimated = false;
  let cacheReadsTotal = 0;
  let cacheWritesTotal = 0;
  for (const m of messages) {
    inSum += m.tokensIn ?? 0;
    outSum += m.tokensOut ?? 0;
    if (m.promptTokens != null && m.promptTokens > 0) {
      // Most recent measured input is the authoritative context baseline.
      lastPromptTokens = m.promptTokens;
      lastPromptTokensEstimated = m.promptTokensEstimated === true;
    }
    cacheReadsTotal += m.cacheReads ?? 0;
    cacheWritesTotal += m.cacheWrites ?? 0;
  }

  let costSum = 0;
  let anyUnknown = false;
  for (const m of messages) {
    const provider = (m.provider ?? selectedProvider) as string;
    const model = m.model ?? selectedModel;
    const providerModels = providers.find((p) => p.id === provider)?.models ?? undefined;
    const rate = getModelRate(provider, model, providerModels);
    if (!rate) {
      if ((m.tokensIn ?? 0) > 0 || (m.tokensOut ?? 0) > 0) anyUnknown = true;
      continue;
    }
    costSum += ((m.tokensIn ?? 0) * rate.in + (m.tokensOut ?? 0) * rate.out) / 1_000_000;
  }

  return {
    tokensIn: inSum,
    tokensOut: outSum,
    totalTokens: inSum + outSum,
    lastPromptTokens,
    lastPromptTokensEstimated,
    cacheReadsTotal,
    cacheWritesTotal,
    costValue: costSum,
    costUnknown: anyUnknown && costSum === 0,
  };
}