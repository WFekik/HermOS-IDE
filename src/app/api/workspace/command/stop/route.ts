import { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { withRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { stopRunningCommand } from "@/lib/workspace";
import { parseJson, apiError, unauthorized, ok, enforceLoopbackRequest } from "@/app/api/_lib/helpers";
import { z } from "zod";

export const dynamic = "force-dynamic";

const schema = z.object({
  conversationId: z.string().trim().min(1).max(64),
});

/** POST /api/workspace/command/stop — kill the conversation's running command. */
export async function POST(req: NextRequest): Promise<Response> {
  const blocked = enforceLoopbackRequest(req);
  if (blocked) return blocked;
  let user;
  try {
    user = await requireUser();
  } catch {
    return unauthorized();
  }
  const limited = await withRateLimit(req, `ws-cmd:${user.id}`, RATE_LIMITS.terminal);
  if (limited) return limited;

  const body = await parseJson<unknown>(req);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return apiError("Invalid payload.", 400, { details: parsed.error.flatten() });

  const stopped = stopRunningCommand(user.id, parsed.data.conversationId);
  return ok({ stopped });
}
