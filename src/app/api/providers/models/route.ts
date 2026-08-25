import { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { withRateLimit, getClientIp } from "@/lib/rate-limit";
import {
  withErrorHandler,
  parseJson,
  ok,
  apiError,
  audit,
} from "@/app/api/_lib/helpers";
import { encrypt, decrypt } from "@/lib/encryption";
import { PROVIDERS } from "@/lib/ai/providers";
import { db } from "@/lib/db";
import { z } from "zod";
import { providerIdSchema, thinkingLevelSchema } from "@/lib/validation";
import { parseModelsColumn, mergeReasoningCapability, type ModelRate, type ProviderModelConfig } from "@/lib/provider-models";
import { extractCapabilities, extractPricing, extractReasoningCapabilities } from "@/lib/provider-fetch";
import { normalizeThinkingLevel } from "@/lib/reasoning";
import { assertUrlAllowed } from "@/lib/ssrf";
import type { ModelReasoningCapabilities } from "@/lib/reasoning";
import { lookupContextWindow } from "@/lib/model-context-windows";
import { lookupModelInRegistry } from "@/lib/models-dev";
import type { ProviderId } from "@/lib/types";

export const dynamic = "force-dynamic";

const MODELS_RATE = { capacity: 10, refillPerSec: 10 / 60 };

/**
 * Parse the `models` JSON column on ProviderKey into a normalized
 * ProviderModelConfig[]. Handles three legacy shapes gracefully:
 *   - null/undefined → []
 *   - string[]      → all enabled, "auto" thinking
 *   - object[]      → as-is (with defaults filled)
 */

const fetchSchema = z.object({
  provider: providerIdSchema,
});

const putSchema = z.object({
  provider: providerIdSchema,
  models: z
    .array(
      z.object({
        id: z.string().trim().min(1).max(200),
        enabled: z.boolean().optional(),
        thinkingLevel: thinkingLevelSchema.optional(),
        contextWindow: z.number().int().positive().optional(),
        pricing: z
          .object({ in: z.number().nonnegative(), out: z.number().nonnegative() })
          .optional(),
      }),
    )
    .max(500),
});

interface FetchedModel {
  id: string;
  name: string;
  contextWindow?: number;
  maxOutput?: number;
  pricing?: ModelRate;
  reasoning?: ModelReasoningCapabilities;
}

/**
 * Dynamic filter to exclude dead, deprecated, inactive, or non-chat models (embeddings, audio, guardrails)
 * returned by provider /models APIs WITHOUT hardcoding specific model names.
 */
function isDynamicActiveChatModel(item: any): boolean {
  if (!item || typeof item !== "object" || typeof item.id !== "string") return false;

  const id = item.id.trim();
  if (!id) return false;

  // 1. Explicit status / flag checks sent by provider metadata
  if (item.active === false || item.enabled === false || item.ready === false || item.archived === true) {
    return false;
  }
  if (typeof item.status === "string") {
    const status = item.status.toLowerCase();
    if (status === "deprecated" || status === "inactive" || status === "deleted" || status === "offline" || status === "disabled") {
      return false;
    }
  }

  // 2. Non-chat model type checks in metadata (type, kind, object, task)
  const metaType = String(item.type || item.kind || item.object || item.task || "").toLowerCase();
  if (
    metaType.includes("embed") ||
    metaType.includes("rerank") ||
    metaType.includes("guard") ||
    metaType.includes("image")
  ) {
    return false;
  }

  const idLower = id.toLowerCase();

  // 3. Dynamic generic category checks on model ID for non-chat utility endpoints
  if (
    idLower.includes("embed") ||
    idLower.includes("bge-") ||
    idLower.includes("e5-") ||
    idLower.includes("whisper") ||
    idLower.includes("tts-") ||
    idLower.includes("dall-e") ||
    idLower.includes("rerank") ||
    idLower.includes("guardrail") ||
    idLower.includes("clip-") ||
    idLower.includes("sdxl") ||
    idLower.includes("stable-diffusion")
  ) {
    return false;
  }

  return true;
}

async function fetchProviderModels(
  provider: ProviderId,
  apiKey: string,
  baseUrl: string,
): Promise<{ ok: true; models: FetchedModel[] } | { ok: false; error: string }> {
  try {
    // Puter exposes a public catalog endpoint (no auth required).
    // FIXED PRESET URL — not user-editable, SSRF policy not applicable.
    if (provider === "puter") {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      try {
        const resp = await fetch("https://api.puter.com/puterai/chat/models/details", {
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        if (!resp.ok) return { ok: true, models: [] };
        const json = (await resp.json()) as { models?: Array<any> };
        const rawList = json.models ?? [];
        const models: FetchedModel[] = rawList
          .filter((m: any) => {
            if (!m || typeof m.id !== "string") return false;
            // Skip image/audio/video/embed modality-only models
            const output: string[] = m.modalities?.output ?? [];
            if (!output.includes("text")) return false;
            return true;
          })
          .map((m: any) => ({
            id: m.id as string,
            name: (m.name ?? m.id) as string,
            contextWindow: typeof m.context === "number" ? m.context : undefined,
            maxOutput: typeof m.max_tokens === "number" ? m.max_tokens : undefined,
          }));
        return { ok: true, models };
      } finally {
        clearTimeout(timer);
      }
    }

    if (provider === "anthropic") {
      const url = baseUrl.replace(/\/$/, "") + "/models";
      await assertUrlAllowed(url);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      try {
        const resp = await fetch(url, {
          headers: {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            Accept: "application/json",
          },
          signal: controller.signal,
        });
        // SSRF per-hop re-validation: the user-editable baseUrl could 302 to a
        // private/metadata address. Re-check final URL after redirects (fail-closed
        // on DNS, see ssrf.ts). For full per-hop coverage see provider-fetch.ts.
        if (resp.redirected) await assertUrlAllowed(resp.url);
        if (!resp.ok) {
          return { ok: true, models: [] };
        }
        const json = (await resp.json()) as { data?: Array<any> };
        const rawList = json.data || [];
        const activeList = rawList.filter(isDynamicActiveChatModel);
        const ids = activeList
          .map((m) => m?.id)
          .filter((id): id is string => typeof id === "string");
        const models = await Promise.all(
          dedupeByIds(ids).map(async (id) => {
            const item = activeList.find((m) => m?.id === id);
            const caps = extractCapabilities(item, provider, id);
            const reg = caps.contextWindow !== undefined ? {} : await lookupModelInRegistry(id, provider, { core: true });
            return { id, name: id, contextWindow: caps.contextWindow ?? reg.contextWindow ?? lookupContextWindow(id), maxOutput: caps.maxOutput ?? reg.maxOutput, pricing: extractPricing(item) ?? undefined, reasoning: extractReasoningCapabilities(item) };
          }),
        );
        return { ok: true, models };
      } finally {
        clearTimeout(timer);
      }
    }
    // OpenAI-compatible (openrouter, openai, groq, mistral, together, custom, puter, nvidia, zen)
    const url = baseUrl.replace(/\/$/, "") + "/models";
    await assertUrlAllowed(url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const resp = await fetch(url, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
        },
        signal: controller.signal,
      });
      // SSRF per-hop re-validation: re-check final URL after any redirects.
      if (resp.redirected) await assertUrlAllowed(resp.url);
      if (!resp.ok) {
        // If the provider doesn't implement /models (e.g. 404), return empty list cleanly
        return { ok: true, models: [] };
      }
      const json = (await resp.json()) as {
        data?: Array<any>;
        models?: Array<any>;
      };
      const list = json.data || json.models || [];
      const activeList = list.filter(isDynamicActiveChatModel);
      const ids = activeList
        .map((m) => m?.id)
        .filter((id): id is string => typeof id === "string");
      const deduped = dedupeByIds(ids);
      const models = await Promise.all(
        deduped.map(async (id) => {
          const item = activeList.find((m) => m?.id === id);
          const caps = extractCapabilities(item);
          const reg = caps.contextWindow !== undefined ? {} : await lookupModelInRegistry(id, provider, { core: true });
          return { id, name: id, contextWindow: caps.contextWindow ?? reg.contextWindow ?? lookupContextWindow(id), maxOutput: caps.maxOutput ?? reg.maxOutput, pricing: extractPricing(item) ?? undefined, reasoning: extractReasoningCapabilities(item) };
        }),
      );
      return { ok: true, models };
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Failed to fetch models.",
    };
  }
}

function dedupeByIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * POST /api/providers/models
 * Body: { provider }
 *
 * Loads the user's saved key for `provider`, decrypts it, and calls the
 * provider's REAL /models endpoint. Returns `{ models: [{ id, name }] }`.
 * On any error returns 200 with `{ ok: false, error }` so the UI can show
 * the error gracefully without an HTTP failure.
 */
export const POST = withErrorHandler(async (req: NextRequest) => {
  const user = await requireUser();
  const limited = await withRateLimit(req, `providers-models:${user.id}`, MODELS_RATE);
  if (limited) return limited;

  const body = await parseJson<unknown>(req);
  if (!body) return apiError("Invalid JSON body.", 400);
  const parsed = fetchSchema.safeParse(body);
  if (!parsed.success) {
    return apiError("Invalid models payload.", 400, { details: parsed.error.flatten() });
  }
  const provider = parsed.data.provider as ProviderId;

  const info = PROVIDERS[provider];
  if (!info) return ok({ ok: false, error: "Unknown provider." });

  const row = await db.providerKey.findUnique({
    where: { userId_provider: { userId: user.id, provider } },
  });
  if (!row || !row.isActive) {
    return ok({ ok: false, error: `No API key saved for ${info.name}.` });
  }
  let apiKey: string;
  try {
    apiKey = decrypt(row.encryptedKey);
  } catch {
    return ok({ ok: false, error: "Saved key could not be decrypted. Re-save it." });
  }
  const baseUrl = row.baseUrl || info.baseUrl || "";
  if (!baseUrl) {
    return ok({ ok: false, error: "No base URL configured for this provider." });
  }

  const result = await fetchProviderModels(provider, apiKey, baseUrl);
  if (!result.ok) {
    return ok({ ok: false, error: result.error });
  }

  // Persist the freshly-fetched id list to the models column (preserving any
  // per-model enabled/thinkingLevel overrides the user previously set).
  const existing = parseModelsColumn(row.models);
  const existingById = new Map(existing.map((m) => [m.id, m]));
  const merged: ProviderModelConfig[] = await Promise.all(
    result.models.map(async (m) => {
      const prev = existingById.get(m.id);
      // Registry consult is cached (memory + disk, 5-min TTL) and provides
      // the per-model facts that narrow each model's thinking surface —
      // `reasoning`, `reasoning_options`, `interleaved.field` — see
      // mergeReasoningCapability.
      const reg = await lookupModelInRegistry(m.id, provider);
      return {
        id: m.id,
        enabled: prev ? prev.enabled : true,
        thinkingLevel: normalizeThinkingLevel(prev?.thinkingLevel),
        contextWindow: m.contextWindow,
        maxOutput: m.maxOutput,
        pricing: m.pricing ?? prev?.pricing,
        reasoning: mergeReasoningCapability(m.reasoning, prev?.reasoning, reg),
      };
    }),
  );
  try {
    await db.providerKey.update({
      where: { id: row.id },
      data: { models: JSON.stringify(merged) },
    });
  } catch {
    /* persisting is best-effort */
  }

  await audit(
    user.id,
    "provider_models_fetch",
    `provider=${provider} count=${result.models.length}`,
    getClientIp(req),
  );

  return ok({ ok: true, models: result.models });
});

/**
 * PUT /api/providers/models
 * Body: { provider, models: [{ id, enabled?, thinkingLevel?, contextWindow? }] }
 *
 * Persist per-model enabled/thinkingLevel overrides. Does NOT change the
 * API key itself. thinkingLevel is one of the canonical levels
 * (off | auto | minimal | low | medium | high | xhigh | max); legacy values
 * are normalized on input by the zod transform.
 */
export const PUT = withErrorHandler(async (req: NextRequest) => {
  const user = await requireUser();
  const limited = await withRateLimit(req, `providers-models:${user.id}`, MODELS_RATE);
  if (limited) return limited;

  const body = await parseJson<unknown>(req);
  if (!body) return apiError("Invalid JSON body.", 400);
  const parsed = putSchema.safeParse(body);
  if (!parsed.success) {
    return apiError("Invalid models payload.", 400, { details: parsed.error.flatten() });
  }
  const provider = parsed.data.provider as ProviderId;
  const row = await db.providerKey.findUnique({
    where: { userId_provider: { userId: user.id, provider } },
  });
  if (!row) {
    return apiError("Save an API key for this provider first.", 404);
  }
  const existing = parseModelsColumn(row.models);
  const existingById = new Map(existing.map((m) => [m.id, m]));
  const config: ProviderModelConfig[] = parsed.data.models.map((m) => {
    const prev = existingById.get(m.id);
    return {
      id: m.id,
      enabled: m.enabled !== false,
      thinkingLevel: m.thinkingLevel ?? "default",
      contextWindow: m.contextWindow ?? prev?.contextWindow,
      maxOutput: prev?.maxOutput,
      pricing: m.pricing ?? prev?.pricing,
      reasoning: prev?.reasoning,
    };
  });
  await db.providerKey.update({
    where: { id: row.id },
    data: { models: JSON.stringify(config) },
  });
  await audit(
    user.id,
    "provider_models_update",
    `provider=${provider} count=${config.length}`,
    getClientIp(req),
  );
  return ok({ ok: true, models: config });
});

