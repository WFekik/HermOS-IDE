import { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { withRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { z } from "zod";
import { getActiveWorkspace, ensureDefaultWorkspace, renamePathWs } from "@/lib/workspace";
import { withErrorHandler, parseJson, apiError, ok } from "@/app/api/_lib/helpers";

export const dynamic = "force-dynamic";

const schema = z.object({
  from: z.string().trim().min(1).max(300),
  to: z.string().trim().min(1).max(300),
});

export const POST = withErrorHandler(async (req: NextRequest) => {
  const user = await requireUser();
  const limited = await withRateLimit(req, `ws-files:${user.id}`, RATE_LIMITS.terminal);
  if (limited) return limited;

  const body = await parseJson<unknown>(req);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return apiError("Invalid payload.", 400, { details: parsed.error.flatten() });

  let ws = await getActiveWorkspace(user.id);
  if (!ws) ws = await ensureDefaultWorkspace(user.id);
  try {
    const r = await renamePathWs(user.id, ws.name, parsed.data.from, parsed.data.to, ws.rootDir);
    return ok(r);
  } catch (e) {
    const msg = e instanceof Error ? e.message.replace(/['"].*?['"]/g, "[path]") : "Rename operation failed.";
    return apiError(msg, 400);
  }
});
