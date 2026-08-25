import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/session";
import { withRateLimit } from "@/lib/rate-limit";
import { db } from "@/lib/db";
import { decrypt } from "@/lib/encryption";
import { testProvider } from "@/lib/ai/executor";
import { PROVIDERS } from "@/lib/ai/providers";
import { parseJson, withErrorHandler, apiError, unauthorized, ok } from "@/app/api/_lib/helpers";
import type { ProviderId } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/providers/test
 * body: { provider: ProviderId }
 * Tests the user's saved API key for the given provider by making a minimal
 * API call. Returns { ok, latencyMs?, error? }.
 */
export const POST = withErrorHandler(async (req: NextRequest): Promise<NextResponse> => {
  let user;
  try {
    user = await requireUser();
  } catch {
    return unauthorized();
  }
  const limited = await withRateLimit(req, `provider-test:${user.id}`, { capacity: 30, refillPerSec: 30 / 60 });
  if (limited) return limited;

  const body = await parseJson<unknown>(req);
  if (!body) return apiError("Invalid JSON body.", 400);

  const { provider } = body as { provider: ProviderId };

  const row = await db.providerKey.findUnique({
    where: { userId_provider: { userId: user.id, provider } },
  });

  if (!row || !row.isActive) {
    return ok({ ok: false, error: "No API key saved for this provider." });
  }

  let apiKey: string;
  try {
    apiKey = decrypt(row.encryptedKey);
  } catch {
    return ok({ ok: false, error: "Failed to decrypt API key. Please re-save your key." });
  }

  const info = PROVIDERS[provider];
  const baseUrl = row.baseUrl || info?.baseUrl || "";

  // Pick the first enabled model from the saved key's model list for testing.
  let testModel: string | undefined;
  if (row.models) {
    try {
      const parsed = JSON.parse(row.models);
      if (Array.isArray(parsed)) {
        testModel = parsed.find((m: any) => m.id && m.id !== "auto" && m.enabled !== false)?.id;
      }
    } catch { /* ignore */ }
  }
  // Fall back to the provider catalog's first model.
  if (!testModel && info?.models?.length) {
    testModel = info.models[0]?.id;
  }

  const result = await testProvider(provider, apiKey, baseUrl, testModel);
  return ok(result);
});
