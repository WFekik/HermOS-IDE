import { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { providerIdSchema, thinkingLevelSchema } from "@/lib/validation";
import { withRateLimit, getClientIp } from "@/lib/rate-limit";
import { encrypt } from "@/lib/encryption";
import { PROVIDERS } from "@/lib/ai/providers";
import { db } from "@/lib/db";
import {
  withErrorHandler,
  parseJson,
  toProviderKeyDTO,
  ok,
  apiError,
  audit,
} from "@/app/api/_lib/helpers";
import {
  parseModelsColumn as parseProviderModelsColumn,
  type ProviderModelConfig,
} from "@/lib/provider-models";
import { z } from "zod";
import type { ProviderId, ProviderKeyDTO } from "@/lib/types";

export const dynamic = "force-dynamic";

// Extended schema: models may be either a string[] (legacy) or an array of
// per-model config objects ({ id, enabled?, thinkingLevel? }).
const modelEntrySchema = z.object({
  id: z.string().trim().min(1).max(200),
  enabled: z.boolean().optional(),
  thinkingLevel: thinkingLevelSchema.optional(),
});

const saveKeySchemaExt = z.object({
  provider: providerIdSchema,
  apiKey: z.string().trim().min(1).max(4096),
  baseUrl: z.string().trim().url().max(2048).optional(),
  models: z
    .union([z.array(z.string().trim().min(1).max(200)).max(500), z.array(modelEntrySchema).max(500)])
    .optional(),
});

type ProviderKeyDTOWithModels = ProviderKeyDTO & {
  modelsConfig?: ProviderModelConfig[];
};

function toProviderKeyDTOWithModels(r: {
  provider: string;
  keyHint: string;
  baseUrl: string | null;
  models: string | null;
  isActive: boolean;
}): ProviderKeyDTOWithModels {
  const base = toProviderKeyDTO(r);
  const cfg = parseProviderModelsColumn(r.models);
  // Overwrite the legacy `models` field with the list of IDs (so existing
  // frontend code keeps working) and add a richer `modelsConfig` field.
  return {
    ...base,
    models: cfg.length ? cfg.map((m) => m.id) : base.models,
    modelsConfig: cfg.length ? cfg : undefined,
  };
}

export const GET = withErrorHandler(async () => {
  const user = await requireUser();
  const rows = await db.providerKey.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "asc" },
  });
  return ok({ keys: rows.map(toProviderKeyDTOWithModels) });
});

export const POST = withErrorHandler(async (req: NextRequest) => {
  const user = await requireUser();
  const limited = await withRateLimit(req, `provider-keys:${user.id}`, { capacity: 10, refillPerSec: 10 / 60 });
  if (limited) return limited;
  const ip = getClientIp(req);
  const body = await parseJson<unknown>(req);
  if (!body) return apiError("Invalid JSON body.", 400);
  const parsed = saveKeySchemaExt.safeParse(body);
  if (!parsed.success) {
    return apiError("Invalid save-key payload.", 400, {
      details: parsed.error.flatten(),
    });
  }
  const { provider, apiKey, baseUrl } = parsed.data;
  const isCustom = provider.startsWith("custom");
  if (!PROVIDERS[provider as ProviderId] && !isCustom) {
    return apiError("Unknown provider.", 400);
  }
  const encryptedKey = encrypt(apiKey);
  // Only show last 4 chars if the key is long enough; otherwise mask entirely.
  const rawHint = apiKey.length >= 8 ? apiKey.slice(-4) : "****";

  // Normalize the incoming `models` field to a ProviderModelConfig[] JSON
  // string for storage in the `models` column.
  let modelsJson: string | null = null;
  if (parsed.data.models) {
    const cfg: ProviderModelConfig[] = parsed.data.models.map((m) => {
      if (typeof m === "string") {
        return { id: m, enabled: true, thinkingLevel: "default" };
      }
      return {
        id: m.id,
        enabled: m.enabled !== false,
        thinkingLevel: m.thinkingLevel ?? "default",
      };
    });
    modelsJson = JSON.stringify(cfg);
  }

  const row = await db.providerKey.upsert({
    where: { userId_provider: { userId: user.id, provider } },
    create: {
      userId: user.id,
      provider,
      encryptedKey,
      keyHint: rawHint,
      baseUrl: baseUrl ?? null,
      models: modelsJson,
      isActive: true,
    },
    update: {
      encryptedKey,
      keyHint: rawHint,
      baseUrl: baseUrl ?? null,
      models: modelsJson,
      isActive: true,
    },
  });
  await audit(user.id, "provider_key_save", `provider=${provider}`, ip);
  return ok({ key: toProviderKeyDTOWithModels(row) });
});

