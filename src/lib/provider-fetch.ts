import { db } from "@/lib/db";
import { decrypt, encrypt } from "@/lib/encryption";
import { PROVIDERS, getProvider } from "@/lib/ai/providers";
import { parseModelsColumn, mergeReasoningCapability, resolveModelContextWindow, shouldPersistFetchedModels, type ModelRate, type ProviderModelConfig } from "@/lib/provider-models";
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
    m.loaded_context_length, m.loadedContextLength, m.context_window_size,
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

/**
 * Parses a model's context length out of an Ollama `/api/show` payload.
 * The native listing is the only place Ollama reports it: `model_info`
 * carries a `<architecture>.context_length` key (e.g. `llama.context_length`),
 * and a `num_ctx` Modelfile parameter — when set — is the effective serving
 * context and wins.
 */
export function extractOllamaContextLength(show: unknown): number | undefined {
  if (!show || typeof show !== "object") return undefined;
  const s = show as { context_length?: unknown; parameters?: unknown; model_info?: unknown };
  const params = typeof s.parameters === "string" ? s.parameters : "";
  const numCtx = params.match(/(?:^|\n)\s*num_ctx\s+(\d+)\s*$/im);
  if (numCtx) {
    const n = Number.parseInt(numCtx[1], 10);
    if (n > 0) return n;
  }
  const topLevel =
    typeof s.context_length === "number" && s.context_length > 0 ? s.context_length : undefined;
  if (topLevel) return topLevel;
  if (s.model_info && typeof s.model_info === "object") {
    for (const [k, v] of Object.entries(s.model_info as Record<string, unknown>)) {
      if (
        (k.endsWith(".context_length") || k.endsWith("_context_length") || k === "context_length") &&
        typeof v === "number" &&
        v > 0
      ) {
        return v;
      }
    }
  }
  return undefined;
}

/**
 * Resolves context lengths for Ollama models via the native `/api/show`
 * endpoint — `/v1/models` never reports them, and without a known window the
 * executors cannot truncate or auto-compact. Per-model failures resolve to
 * "unknown" (the caller falls back to registry/suffix/user overrides).
 */
export async function resolveOllamaContextWindows(
  baseUrl: string,
  ids: readonly string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!baseUrl || ids.length === 0) return out;
  let origin: string;
  try {
    origin = new URL(baseUrl).origin;
  } catch {
    return out;
  }
  // Probe in small batches: a local Ollama can list hundreds of models, and an
  // unbounded fan-out would open a socket per model at once.
  const BATCH = 8;
  for (let i = 0; i < ids.length; i += BATCH) {
    await Promise.all(
      ids.slice(i, i + BATCH).map(async (id) => {
        try {
          // SSRF: same user-editable baseUrl as the /models fetch — fetchWithSsrf
          // validates it (loopback + port 11434 are policy-allowed for Ollama).
          const resp = await fetchWithSsrf(`${origin}/api/show`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({ model: id }),
            signal: AbortSignal.timeout(8000),
          });
          if (!resp.ok) return;
          const win = extractOllamaContextLength(await resp.json());
          if (win) out.set(id, win);
        } catch {
          /* model stays unknown */
        }
      }),
    );
  }
  return out;
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
    // Ollama reports context lengths only on its native /api/show endpoint —
    // probe them so truncation and auto-compact have a real window to work with.
    const ollamaWins = provider === "ollama" ? await resolveOllamaContextWindows(baseUrl, deduped) : undefined;

    const merged: ProviderModelConfig[] = await Promise.all(
      deduped.map(async (id) => {
        const item = list.find((m) => m?.id === id);
        const caps = extractCapabilities(item);
        const prev = existingById.get(id);
        // Persist only core capacity facts (contextWindow/maxOutput) from registry; reasoning facts are scoped separately.
        const reg = await lookupModelInRegistry(id, provider, { core: true });
        const { contextWindow, contextWindowSource } = resolveModelContextWindow(
          prev,
          caps.contextWindow ?? ollamaWins?.get(id),
          [reg.contextWindow, lookupContextWindow(id)],
        );
        return {
          id,
          enabled: prev ? prev.enabled : true,
          thinkingLevel: normalizeThinkingLevel(prev?.thinkingLevel),
          contextWindow,
          contextWindowSource,
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
