import { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { withRateLimit, getClientIp } from "@/lib/rate-limit";
import {
  withErrorHandler,
  parseJson,
  ok,
  apiError,
  unauthorized,
  audit,
} from "@/app/api/_lib/helpers";
import { browserOpen } from "@/lib/browser";
import { z } from "zod";

export const dynamic = "force-dynamic";

// Sustained 8 req/s with a 40 burst — must comfortably cover the panel's
// live-polling fallback plus user interactions, or the bucket starves and
// the "realtime" view stalls with 429s exactly while the agent works.
const BROWSER_RATE = { capacity: 40, refillPerSec: 8 };

const openSchema = z.object({
  url: z.string().trim().min(1).max(2000),
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
  const parsed = openSchema.safeParse(body);
  if (!parsed.success) {
    return apiError("Invalid open payload.", 400, { details: parsed.error.flatten() });
  }

  const r = await browserOpen(parsed.data.url, user.id);
  if (!r.ok) {
    return ok({ ok: false, error: r.error });
  }
  await audit(
    user.id,
    "browser_open",
    JSON.stringify({ url: parsed.data.url.slice(0, 200), title: r.title.slice(0, 200) }),
    getClientIp(req),
  );
  return ok({ session: r.session, title: r.title, snapshot: r.snapshot });
});
