import { db } from "@/lib/db";
import { decrypt } from "@/lib/encryption";
import { PROVIDERS } from "@/lib/ai/providers";
import { parseModelsColumn, mergeReasoningCapability, type ModelRate, type ProviderModelConfig } from "@/lib/provider-models";
import { lookupContextWindow } from "@/lib/model-context-windows";
import { lookupModelInRegistry } from "@/lib/models-dev";
import type { ProviderId } from "@/lib/types";
import { checkUrlHost } from "@/lib/ssrf";
import { normalizeThinkingLevel, parseModelReasoningCapabilities } from "@/lib/reasoning";
import type { ModelReasoningCapabilities } from "@/lib/reasoning";

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
  const info = PROVIDERS[provider];
  if (!info) return null;

  const row = await db.providerKey.findUnique({
    where: { userId_provider: { userId, provider } },
  });
  if (!row || !row.isActive) return null;

  let apiKey: string;
  try {
    apiKey = decrypt(row.encryptedKey);
  } catch {
    return null;
  }

  const baseUrl = row.baseUrl || info.baseUrl || "";
  if (!baseUrl) return null;

  try {
    const isAnthropic = provider === "anthropic";
    const url = baseUrl.replace(/\/$/, "") + "/models";
    // SSRF: The provider base URL is user-editable and this auto-refresh runs from
    // the server, so it must go through the same SSRF policy as every other
    // outbound fetch. We validate pre-fetch and re-validate post-redirect
    // (per-hop). `fetch` follows redirects automatically (up to 20); we check
    // `resp.redirected && resp.url` to ensure the final landing URL is still
    // allowed. For full per-hop validation of every 3xx Location intermediate,
    // a manual redirect loop (redirect: 'manual' + re-check each Location header)
    // would be needed; the current check covers the common case where the final
    // target is the security-relevant one, and DNS rebinding is further mitigated
    // by checkUrlHost now failing closed on DNS errors and by post-fetch IP
    // re-verification (see ssrf.ts).
    if (await checkUrlHost(url)) return null;
    const headers: Record<string, string> = { Accept: "application/json" };
    if (isAnthropic) {
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
    } else {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
    if (!resp.ok) return null;
    // Re-validate after redirects: an attacker-controlled domain could 302 to a
    // private/metadata address (link-local, cloud metadata) that was not visible
    // at check time. This covers the final redirect target; see comment above for
    // per-hop completeness. `checkUrlHost` is now fail-closed on DNS failures.
    if (resp.redirected && (await checkUrlHost(resp.url))) return null;

    const json = (await resp.json()) as { data?: Array<Record<string, unknown>>; models?: Array<Record<string, unknown>> };
    const list = json.data || json.models || [];

    const ids = list.map((m) => m?.id).filter((id): id is string => typeof id === "string");
    const deduped = [...new Set(ids)];

    const existing = parseModelsColumn(row.models);
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

    await db.providerKey.update({
      where: { id: row.id },
      data: { models: JSON.stringify(merged) },
    });

    return merged;
  } catch {
    return null;
  }
}
