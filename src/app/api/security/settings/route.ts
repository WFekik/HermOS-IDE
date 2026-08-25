import { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import {
  withErrorHandler,
  ok,
  apiError,
  parseJson,
} from "@/app/api/_lib/helpers";
import {
  getSecuritySettings,
  setSecuritySettings,
} from "@/lib/security-settings";
import { securitySettingsSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

// GET /api/security/settings — resolve the caller's effective security settings.
export const GET = withErrorHandler(async () => {
  const user = await requireUser();
  const settings = await getSecuritySettings(user.id);
  return ok({ settings });
});

// PATCH /api/security/settings — apply a validated partial update.
export const PATCH = withErrorHandler(async (req: NextRequest) => {
  const user = await requireUser();
  const body = await parseJson<unknown>(req);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return apiError("Invalid JSON body.", 400);
  }
  const parsed = securitySettingsSchema.safeParse(body);
  if (!parsed.success) {
    return apiError("Invalid security settings.", 400, {
      details: parsed.error.flatten(),
    });
  }
  const settings = await setSecuritySettings(user.id, parsed.data);
  return ok({ settings });
});