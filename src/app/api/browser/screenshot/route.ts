import { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { withRateLimit } from "@/lib/rate-limit";
import { withErrorHandler, ok, unauthorized } from "@/app/api/_lib/helpers";
import { browserScreenshot } from "@/lib/browser";

export const dynamic = "force-dynamic";

// See open/route.ts — sized to cover live polling without 429 starvation.
const BROWSER_RATE = { capacity: 40, refillPerSec: 8 };

export const GET = withErrorHandler(async (req: NextRequest) => {
  let user;
  try {
    user = await requireUser();
  } catch {
    return unauthorized();
  }
  const limited = await withRateLimit(req, `browser:${user.id}`, BROWSER_RATE);
  if (limited) return limited;

  const r = await browserScreenshot(user.id);
  if (!r.ok) return ok({ ok: false, error: r.error });
  return ok({ dataUrl: r.dataUrl });
});
