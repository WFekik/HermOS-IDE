import { getProvider } from "@/lib/ai/providers";
import { parseModelsColumn } from "@/lib/provider-models";
import type { ProviderId, ProviderInfo } from "@/lib/types";

/** Minimal key-row shape needed to synthesize catalog entries (DB rows). */
export interface CustomProviderKeyRow {
  provider: string;
  baseUrl: string | null;
  models: string | null;
}

/**
 * Synthesize catalog entries for named custom providers (`custom:<name>`)
 * saved via BYOK. The static catalog (listProviders) only contains the bare
 * `custom` template, so without this the chat model picker — which renders
 * the store `providers` list, unlike the settings tab which merges keys
 * locally — can never show a saved custom provider.
 *
 * Stored model configs become the entry's model list (same mapping as the
 * /api/providers merge); entries with no stored models still appear (with
 * an empty list) so the picker shows the provider with a "no models"
 * affordance instead of dropping it silently.
 */
export function customProvidersFromKeys(
  rows: CustomProviderKeyRow[],
  knownIds: Set<string>,
): ProviderInfo[] {
  const out: ProviderInfo[] = [];
  for (const row of rows) {
    if (!row.provider.startsWith("custom")) continue;
    if (knownIds.has(row.provider)) continue;
    if (out.some((p) => p.id === row.provider)) continue;
    const base = getProvider(row.provider as ProviderId);
    if (!base) continue;
    const stored = parseModelsColumn(row.models);
    out.push({
      ...base,
      baseUrl: row.baseUrl ?? base.baseUrl ?? "",
      models: stored.map((m) => ({
        id: m.id,
        name: m.id,
        enabled: m.enabled,
        contextWindow: m.contextWindow,
        maxOutput: m.maxOutput,
        pricing: m.pricing,
        reasoning: m.reasoning,
      })),
    });
    knownIds.add(row.provider);
  }
  return out;
}
