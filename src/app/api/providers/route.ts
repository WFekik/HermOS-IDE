import { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { listProviders } from "@/lib/ai/providers";
import { db } from "@/lib/db";
import { withErrorHandler, ok } from "@/app/api/_lib/helpers";
import { parseModelsColumn, mergeReasoningCapability } from "@/lib/provider-models";
import { customProvidersFromKeys } from "@/lib/custom-providers";
import { peekModelInRegistry } from "@/lib/models-dev";
import { lookupContextWindow } from "@/lib/model-context-windows";
import type { ProviderId, ModelInfo } from "@/lib/types";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(async () => {
  const user = await requireUser();
  const keys = await db.providerKey.findMany({
    where: { userId: user.id, isActive: true },
  });
  const keyMap = new Map(keys.map((k) => [k.provider as ProviderId, k]));
  // Named custom providers (`custom:<name>`) live only as key rows — the
  // static catalog has just the bare `custom` template. Append synthesized
  // entries so every consumer of this list (chat model picker, agent tab)
  // sees saved custom providers, not only the settings tab (which merges
  // keys locally as a fallback).
  const catalog = [
    ...listProviders(),
    ...customProvidersFromKeys(keys, new Set(listProviders().map((p) => p.id))),
  ];
  const providers = await Promise.all(
    catalog.map(async (p) => {
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
        const serverCap = stored?.serverContextWindow ?? staticModel.contextWindow;
        let cw: number | undefined;
        if (typeof serverCap === "number" && serverCap > 0) {
          cw =
            stored?.contextWindowSource === "user" && typeof stored.contextWindow === "number"
              ? Math.min(stored.contextWindow, serverCap)
              : (stored?.contextWindow ?? serverCap);
          cw = Math.min(cw, serverCap);
        } else {
          cw = stored?.contextWindow ?? staticModel.contextWindow ?? lookupContextWindow(staticModel.id);
          if (cw === undefined && (p.id === "ollama" || p.id === "lmstudio")) {
            cw = 4096;
          }
        }

        mergedModels.push({
          ...staticModel,
          ...(stored?.enabled !== undefined ? { enabled: stored.enabled } : {}),
          contextWindow: cw,
          ...(serverCap !== undefined ? { serverContextWindow: serverCap } : {}),
          ...(stored?.maxOutput !== undefined ? { maxOutput: stored.maxOutput } : {}),
          ...(stored?.pricing !== undefined ? { pricing: stored.pricing } : {}),
          ...(stored?.reasoning !== undefined ? { reasoning: stored.reasoning } : {}),
        });
        used.add(staticModel.id);
      }
      // Append models that exist only in stored config (e.g. fetched live)
      for (const stored of storedModels) {
        if (!used.has(stored.id)) {
          const serverCap = stored.serverContextWindow;
          let cw: number | undefined;
          if (typeof serverCap === "number" && serverCap > 0) {
            cw =
              stored.contextWindowSource === "user" && typeof stored.contextWindow === "number"
                ? Math.min(stored.contextWindow, serverCap)
                : (stored.contextWindow ?? serverCap);
            cw = Math.min(cw, serverCap);
          } else {
            cw = stored.contextWindow ?? lookupContextWindow(stored.id);
            if (cw === undefined && (p.id === "ollama" || p.id === "lmstudio")) {
              cw = 4096;
            }
          }
          mergedModels.push({
            id: stored.id,
            name: stored.id,
            enabled: stored.enabled,
            contextWindow: cw,
            ...(serverCap !== undefined ? { serverContextWindow: serverCap } : {}),
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
  const res = ok({ providers });
  res.headers.set("Cache-Control", "private, max-age=30, stale-while-revalidate=60");
  return res;
});
