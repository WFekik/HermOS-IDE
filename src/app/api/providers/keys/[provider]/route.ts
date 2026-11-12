import { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { withRateLimit, getClientIp } from "@/lib/rate-limit";
import { db } from "@/lib/db";
import {
  withErrorHandler,
  ok,
  notFound,
  apiError,
  audit,
} from "@/app/api/_lib/helpers";
import { providerIdSchema, thinkingLevelSchema } from "@/lib/validation";
import { parseModelsColumn as parseProviderModelsColumn, type ProviderModelConfig } from "@/lib/provider-models";
import { isKeylessProvider } from "@/lib/ai/providers";
import { encrypt } from "@/lib/encryption";
import { z } from "zod";

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  models: z
    .array(
      z.object({
        id: z.string().trim().min(1).max(200),
        enabled: z.boolean().optional(),
        thinkingLevel: thinkingLevelSchema.optional(),
        contextWindow: z.number().int().positive().optional(),
        serverContextWindow: z.number().int().positive().optional(),
      }),
    )
    .max(500),
});

/**
 * PATCH /api/providers/keys/[provider]
 * Body: { models: [{ id, enabled?, thinkingLevel? }] }
 *
 * Update the per-model config (enabled / thinkingLevel) on a saved provider
 * key WITHOUT changing the encrypted key itself.
 */
export const PATCH = withErrorHandler(
  async (req: NextRequest, { params }: { params: Promise<{ provider: string }> }) => {
    const user = await requireUser();
    const limited = await withRateLimit(req, `provider-keys:${user.id}`, { capacity: 10, refillPerSec: 10 / 60 });
    if (limited) return limited;
    const { provider } = await params;
    const parsed = providerIdSchema.safeParse(provider);
    if (!parsed.success) {
      return apiError("Invalid provider id.", 400);
    }
    let row = await db.providerKey.findUnique({
      where: { userId_provider: { userId: user.id, provider: parsed.data } },
    });
    if (!row) {
      if (isKeylessProvider(parsed.data)) {
        row = await db.providerKey.create({
          data: {
            userId: user.id,
            provider: parsed.data,
            encryptedKey: encrypt(""),
            keyHint: "",
            baseUrl: null,
            models: "[]",
            isActive: true,
          },
        });
      } else {
        return notFound("Provider key not found");
      }
    }

    const body = await req
      .json()
      .catch(() => null) as unknown;
    if (!body) return apiError("Invalid JSON body.", 400);
    const parsedBody = patchSchema.safeParse(body);
    if (!parsedBody.success) {
      return apiError("Invalid patch payload.", 400, {
        details: parsedBody.error.flatten(),
      });
    }

    const existing = parseProviderModelsColumn(row.models);
    const existingById = new Map(existing.map((m) => [m.id, m]));
    const config: ProviderModelConfig[] = parsedBody.data.models.map((m) => {
      const prev = existingById.get(m.id);
      // The stored cap is server-authoritative: a UI save may refine the
      // effective window, but it must never shrink or invent the provider's
      // maximum (a stale client cap would otherwise become the hard limit).
      const serverCap = prev?.serverContextWindow ?? m.serverContextWindow;
      let targetCw = m.contextWindow ?? prev?.contextWindow;
      if (typeof targetCw === "number" && typeof serverCap === "number" && serverCap > 0) {
        targetCw = Math.min(targetCw, serverCap);
      }
      const isUserOverride =
        m.contextWindow !== undefined && (serverCap === undefined || targetCw !== serverCap);
      return {
        id: m.id,
        enabled: m.enabled !== false,
        thinkingLevel: m.thinkingLevel ?? "default",
        contextWindow: targetCw ?? serverCap,
        serverContextWindow: serverCap,
        contextWindowSource: isUserOverride ? "user" : prev?.contextWindowSource,
        // Live-fetched fields (maxOutput/pricing/reasoning caps) are not part
        // of this patch's body — carry them over from the stored row so a
        // "Save model config" never silently drops the reasoning surface.
        maxOutput: prev?.maxOutput,
        pricing: prev?.pricing,
        reasoning: prev?.reasoning,
      };
    });
    await db.providerKey.update({
      where: { id: row.id },
      data: { models: JSON.stringify(config) },
    });
    await audit(
      user.id,
      "provider_key_models_update",
      `provider=${parsed.data} count=${config.length}`,
      getClientIp(req),
    );
    return ok({ ok: true, models: config });
  },
);

// Expose the parsed models on GET so the frontend can read per-model config
// without a second round-trip.
export const GET = withErrorHandler(
  async (_req: NextRequest, { params }: { params: Promise<{ provider: string }> }) => {
    const user = await requireUser();
    const { provider } = await params;
    const parsed = providerIdSchema.safeParse(provider);
    if (!parsed.success) {
      return apiError("Invalid provider id.", 400);
    }
    const row = await db.providerKey.findUnique({
      where: { userId_provider: { userId: user.id, provider: parsed.data } },
    });
    if (!row) {
      if (isKeylessProvider(parsed.data)) {
        return ok({ provider: parsed.data, models: [] });
      }
      return notFound("Provider key not found");
    }
    const models = parseProviderModelsColumn(row.models);
    return ok({ provider: parsed.data, models });
  },
);

export const DELETE = withErrorHandler(
  async (req: NextRequest, { params }: { params: Promise<{ provider: string }> }) => {
    const user = await requireUser();
    const limited = await withRateLimit(req, `provider-keys:${user.id}`, { capacity: 10, refillPerSec: 10 / 60 });
    if (limited) return limited;
    const { provider } = await params;
    const parsed = providerIdSchema.safeParse(provider);
    if (!parsed.success) {
      return apiError("Invalid provider id.", 400);
    }
    const res = await db.providerKey.deleteMany({
      where: { userId: user.id, provider: parsed.data },
    });
    if (res.count === 0) return notFound("Provider key not found");
    await audit(
      user.id,
      "provider_key_delete",
      `provider=${parsed.data}`,
      getClientIp(req),
    );
    return ok({ ok: true });
  },
);
