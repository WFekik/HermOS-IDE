import { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { withRateLimit, getClientIp } from "@/lib/rate-limit";
import { withErrorHandler, ok, unauthorized, audit } from "@/app/api/_lib/helpers";
import { browserClose } from "@/lib/browser";

export const dynamic = "force-dynamic";

// See open/route.ts — sized to cover live polling without 429 starvation.
const BROWSER_RATE = { capacity: 40, refillPerSec: 8 };

export const POST = withErrorHandler(async (req: NextRequest) => {
  let user;
  try {
    user = await requireUser();
  } catch {
    return unauthorized();
  }
  const limited = await withRateLimit(req, `browser:${user.id}`, BROWSER_RATE);
  if (limited) return limited;

  await browserClose(user.id);
  await audit(user.id, "browser_close", undefined, getClientIp(req));
  return ok({ ok: true });
});
