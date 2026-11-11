import { db } from "@/lib/db";
import { decrypt, encrypt } from "@/lib/encryption";
import { PROVIDERS, getProvider } from "@/lib/ai/providers";
import { parseModelsColumn, mergeReasoningCapability, shouldPersistFetchedModels, type ModelRate, type ProviderModelConfig } from "@/lib/provider-models";
import { lookupContextWindow } from "@/lib/model-context-windows";
import { lookupModelInRegistry } from "@/lib/models-dev";
import type { ProviderId } from "@/lib/types";
import { fetchWithSsrf } from "@/lib/ai/ssrf-fetch";
import { normalizeThinkingLevel, parseModelReasoningCapabilities } from "@/lib/reasoning";
import type { ModelReasoningCapabilities } from "@/lib/reasoning";
import { buildProviderHeaders, resolveProviderModelsUrl, resolveProviderBaseUrl } from "@/lib/ai/provider-payloads";

interface ModelCapabilities {
  id: string;
  name: string;
  contextWindow?: number;
  maxOutput?: number;
}

/** Extracts per-model billing rates (USD per 1M tokens) from live provider metadata. */
export function extractPricing(m: any): ModelRate | null {
  if (!m || typeof m !== "object") return null;
  const p = m.pricing;
  if (!p || typeof p !== "object") return null;
  const toPerMillion = (v: unknown): number | null => {
    const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
    return Number.isFinite(n) && n >= 0 ? n * 1_000_000 : null;
  };
  const input = toPerMillion(p.prompt);
  const output = toPerMillion(p.completion);
  if (input === null || output === null) return null;
  return { in: input, out: output };
}

export function extractCapabilities(
  m: any,
  provider?: string,
  modelId?: string,
): { contextWindow?: number; maxOutput?: number } {
  if (!m || typeof m !== "object") return {};
  const ctxCandidates = [
    m.context_window, m.contextWindow, m.context_length,
    m.contextLength, m.max_context_length, m.max_position_embeddings,
    m.max_model_len, m.max_seq_len, m.max_tokens, m.maxTokens,
  ];
  let contextWindow: number | undefined;
  for (const val of ctxCandidates) {
    if (typeof val === "number" && val > 0) { contextWindow = val; break; }
    if (typeof val === "string" && !isNaN(parseInt(val, 10))) {
      const parsed = parseInt(val, 10);
      if (parsed > 0) { contextWindow = parsed; break; }
    }
  }
  const outCandidates = [
    m.max_output, m.maxOutput, m.max_output_tokens, m.max_completion_tokens,
    m.per_request_limits?.completion_tokens, m.top_provider?.max_completion_tokens,
    m.max_tokens, m.maxTokens,
  ];
  let maxOutput: number | undefined;
  for (const val of outCandidates) {
    if (typeof val === "number" && val > 0) { maxOutput = val; break; }
    if (typeof val === "string" && !isNaN(parseInt(val, 10))) {
      const parsed = parseInt(val, 10);
      if (parsed > 0) { maxOutput = parsed; break; }
    }
  }
  if (contextWindow !== undefined && maxOutput !== undefined && maxOutput >= contextWindow) {
    maxOutput = undefined;
  }
  return { contextWindow, maxOutput };
}

/** Extracts per-model reasoning capabilities from live provider metadata. */
export function extractReasoningCapabilities(m: any): ModelReasoningCapabilities | undefined {
  return parseModelReasoningCapabilities(m?.reasoning);
}

/** Fetches and persists the available model list for a provider to the database. */
export async function refreshProviderModels(
  userId: string,
  provider: ProviderId,
): Promise<ProviderModelConfig[] | null> {
  // getProvider() synthesizes named custom providers (`custom:<name>`);
  // the static dict alone would drop every saved custom endpoint here.
  const info = getProvider(provider) ?? PROVIDERS[provider];
  if (!info) return null;

  const row = await db.providerKey.findUnique({
    where: { userId_provider: { userId, provider } },
  });
  // Local model servers need no key: they are reachable straight from the
  // registry endpoint, with or without a saved row.
  const keyless = info.requiresKey === false;
  if ((!row || !row.isActive) && !keyless) return null;

  let apiKey = "";
  if (row?.isActive && !keyless) {
    try {
      apiKey = decrypt(row.encryptedKey);
    } catch {
      return null;
    }
  }

  const baseUrl = resolveProviderBaseUrl(provider, row?.baseUrl);
  if (!baseUrl) return null;

  try {
    const isAnthropic = provider === "anthropic";
    const url = isAnthropic
      ? baseUrl.replace(/\/$/, "") + "/models"
      : resolveProviderModelsUrl(provider, baseUrl);
    if (!url) return null;
    // SSRF: the provider base URL is user-editable and this auto-refresh runs
    // from the server. fetchWithSsrf validates every redirect hop (manual
    // redirects, 3-hop cap, cross-origin credential strip); violations throw
    // and are caught below as null (fail-closed).
    const headers: Record<string, string> = isAnthropic
      ? {
          Accept: "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        }
      : buildProviderHeaders({
          providerId: provider,
          baseUrl,
          apiKey,
          acceptStream: false,
          includeContentType: false,
        });

    const resp = await fetchWithSsrf(url, { headers, signal: AbortSignal.timeout(15000) });
    if (!resp.ok) return null;

    const json = (await resp.json()) as { data?: Array<Record<string, unknown>>; models?: Array<Record<string, unknown>> };
    const list = json.data || json.models || [];

    const ids = list.map((m) => m?.id).filter((id): id is string => typeof id === "string");
    const deduped = [...new Set(ids)];

    const existing = parseModelsColumn(row?.models);
    // Same never-wipe rule as the models API route: an empty listing means
    // "endpoint silent", not "user has no models". Persisting [] would
    // destroy hand-curated config on every transient empty response —
    // return the stored config untouched instead.
    if (!shouldPersistFetchedModels(deduped.length, existing.length)) {
      return existing;
    }
    const existingById = new Map(existing.map((m) => [m.id, m]));

    const merged: ProviderModelConfig[] = await Promise.all(
      deduped.map(async (id) => {
        const item = list.find((m) => m?.id === id);
        const caps = extractCapabilities(item);
        const prev = existingById.get(id);
        // Persist only core capacity facts (contextWindow/maxOutput) from registry; reasoning facts are scoped separately.
        const reg = await lookupModelInRegistry(id, provider, { core: true });
        return {
          id,
          enabled: prev ? prev.enabled : true,
          thinkingLevel: normalizeThinkingLevel(prev?.thinkingLevel),
          contextWindow: caps.contextWindow ?? reg.contextWindow ?? lookupContextWindow(id),
          maxOutput: caps.maxOutput ?? reg.maxOutput,
          pricing: extractPricing(item) ?? prev?.pricing,
          reasoning: mergeReasoningCapability(
            extractReasoningCapabilities(item),
            prev?.reasoning,
            reg,
          ),
        };
      }),
    );

    if (row) {
      await db.providerKey.update({
        where: { id: row.id },
        data: { models: JSON.stringify(merged) },
      });
    } else {
      // Keyless provider fetched before it was connected: store the list on
      // a credential-less row so the models can be picked. Best-effort — a
      // concurrent connect may have created the row first, and that race must
      // not discard a successfully fetched list.
      try {
        await db.providerKey.create({
          data: {
            userId,
            provider,
            encryptedKey: encrypt(""),
            keyHint: "",
            baseUrl: baseUrl || null,
            models: JSON.stringify(merged),
            isActive: true,
          },
        });
      } catch {
        /* row created concurrently */
      }
    }

    return merged;
  } catch {
    return null;
  }
}
