import { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { listProviders, PROVIDERS } from "@/lib/ai/providers";
import { db } from "@/lib/db";
import { withErrorHandler, ok } from "@/app/api/_lib/helpers";
import { parseModelsColumn, mergeReasoningCapability } from "@/lib/provider-models";
import { peekModelInRegistry } from "@/lib/models-dev";
import type { ProviderId, ModelInfo } from "@/lib/types";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(async () => {
  const user = await requireUser();
  const keys = await db.providerKey.findMany({
    where: { userId: user.id, isActive: true },
  });
  const keyMap = new Map(keys.map((k) => [k.provider as ProviderId, k]));
  const providers = await Promise.all(
    listProviders().map(async (p) => {
      const keyRow = keyMap.get(p.id);
      // Merge stored model configs (fetched via POST /api/providers/models)
      // into the provider's static model list so contextWindow etc. are
      // available in the frontend (e.g. for the context circle indicator).
      const storedModels = keyRow?.models ? parseModelsColumn(keyRow.models) : [];
      const mergedModels: ModelInfo[] = [];
      const staticModels = p.models ?? [];
      const used = new Set<string>();
      for (const staticModel of staticModels) {
        const stored = storedModels.find((m) => m.id === staticModel.id);
        if (stored) {
          // Merge any stored overrides (live-fetched contextWindow, maxOutput,
          // pricing). Only defined fields override the static catalog — a
          // stored entry without a contextWindow must not clobber the static
          // one with `undefined`.
          mergedModels.push({
            ...staticModel,
            ...(stored.enabled !== undefined ? { enabled: stored.enabled } : {}),
            ...(stored.contextWindow !== undefined ? { contextWindow: stored.contextWindow } : {}),
            ...(stored.maxOutput !== undefined ? { maxOutput: stored.maxOutput } : {}),
            ...(stored.pricing !== undefined ? { pricing: stored.pricing } : {}),
            ...(stored.reasoning !== undefined ? { reasoning: stored.reasoning } : {}),
          });
        } else {
          mergedModels.push(staticModel);
        }
        used.add(staticModel.id);
      }
      // Append models that exist only in stored config (e.g. fetched live)
      for (const stored of storedModels) {
        if (!used.has(stored.id)) {
          mergedModels.push({
            id: stored.id,
            name: stored.id,
            enabled: stored.enabled,
            contextWindow: stored.contextWindow,
            maxOutput: stored.maxOutput,
            pricing: stored.pricing,
            reasoning: stored.reasoning,
          });
        }
      }
      // Self-heal stale rows: models fetched before per-model reasoning
      // flags existed carry no reasoning caps. The models.dev registry fills
      // the gaps — `reasoning: false` → `{ scheme: "none" }` (selector
      // hides), `reasoning_options` effort values → `supportedEfforts`,
      // `interleaved.field` → `interleavedField`. Rows that already carry
      // live caps are never disturbed.
      const missing = mergedModels.filter((m) => m.reasoning === undefined);
      if (missing.length > 0) {
        const enriched = await Promise.all(
          missing.map(async (m) => {
            const reg = await peekModelInRegistry(m.id, p.id);
            const reasoning = mergeReasoningCapability(undefined, undefined, reg);
            return reasoning ? { ...m, reasoning } : m;
          }),
        );
        const enrichedById = new Map(enriched.map((m) => [m.id, m]));
        mergedModels.splice(0, mergedModels.length, ...mergedModels.map((m) => enrichedById.get(m.id) ?? m));
      }
      return {
        ...p,
        models: mergedModels,
        configured: !p.requiresKey ? true : !!keyRow,
        keyHint: keyRow?.keyHint
          ? "••••" + keyRow.keyHint.slice(-4)
          : undefined,
      };
    }),
  );
  // Suppress unused PROVIDERS warning — it's intentionally re-exported below
  void PROVIDERS;
  return ok({ providers });
});
