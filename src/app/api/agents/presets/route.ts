import { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { createPresetSchema } from "@/lib/validation";
import { withRateLimit } from "@/lib/rate-limit";
import { db } from "@/lib/db";
import { DEFAULT_PROVIDER, DEFAULT_MODEL } from "@/lib/ai/providers";
import { seedIfNeeded } from "@/lib/seed";
import {
  withErrorHandler,
  parseJson,
  toPresetDTO,
  ok,
  apiError,
} from "@/app/api/_lib/helpers";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(async () => {
  const user = await requireUser();
  await seedIfNeeded();
  const rows = await db.agentPreset.findMany({
    where: {
      OR: [{ isBuiltin: true }, { userId: user.id }],
    },
    orderBy: [{ isBuiltin: "desc" }, { createdAt: "asc" }],
  });
  return ok({ presets: rows.map(toPresetDTO) });
});

export const POST = withErrorHandler(async (req: NextRequest) => {
  const user = await requireUser();
  const limited = await withRateLimit(req, `presets:${user.id}`, { capacity: 30, refillPerSec: 30 / 60 });
  if (limited) return limited;
  const body = await parseJson<unknown>(req);
  if (!body) return apiError("Invalid JSON body.", 400);
  const parsed = createPresetSchema.safeParse(body);
  if (!parsed.success) {
    return apiError("Invalid preset payload.", 400, {
      details: parsed.error.flatten(),
    });
  }
  const { name, description, systemPrompt, provider, model, tools, temperature, icon } =
    parsed.data;
  // Upsert by (userId, name) — the user-scoped uniqueness constraint. Distinct
  // users can still create presets with the same name (different userId).
  const upserted = await db.agentPreset.upsert({
    where: { userId_name: { userId: user.id, name } },
    update: {
      description: description ?? null,
      systemPrompt,
      provider: provider ?? DEFAULT_PROVIDER,
      model: model ?? DEFAULT_MODEL,
      tools: tools ? JSON.stringify(tools) : null,
      temperature: temperature ?? 0.7,
      icon: icon ?? null,
    },
    create: {
      userId: user.id,
      name,
      description: description ?? null,
      systemPrompt,
      provider: provider ?? DEFAULT_PROVIDER,
      model: model ?? DEFAULT_MODEL,
      tools: tools ? JSON.stringify(tools) : null,
      temperature: temperature ?? 0.7,
      icon: icon ?? null,
      isBuiltin: false,
    },
  });
  return ok({ preset: toPresetDTO(upserted) });
});
