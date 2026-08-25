import { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { withRateLimit } from "@/lib/rate-limit";
import {
  withErrorHandler,
  parseJson,
  ok,
  apiError,
  unauthorized,
} from "@/app/api/_lib/helpers";
import { browserScroll } from "@/lib/browser";
import { z } from "zod";

export const dynamic = "force-dynamic";

// See open/route.ts — sized to cover live polling without 429 starvation.
const BROWSER_RATE = { capacity: 40, refillPerSec: 8 };

const scrollSchema = z.object({
  direction: z.enum(["up", "down", "left", "right"]),
  px: z.number().int().min(1).max(10000).optional(),
});

export const POST = withErrorHandler(async (req: NextRequest) => {
  let user;
  try {
    user = await requireUser();
  } catch {
    return unauthorized();
  }
  const limited = await withRateLimit(req, `browser:${user.id}`, BROWSER_RATE);
  if (limited) return limited;

  const body = await parseJson<unknown>(req);
  if (!body) return apiError("Invalid JSON body.", 400);
  const parsed = scrollSchema.safeParse(body);
  if (!parsed.success) {
    return apiError("Invalid scroll payload.", 400, { details: parsed.error.flatten() });
  }

  const r = await browserScroll(parsed.data.direction, parsed.data.px, user.id);
  if (!r.ok) return ok({ ok: false, error: r.error });
  return ok({ ok: true, snapshot: r.snapshot });
});
