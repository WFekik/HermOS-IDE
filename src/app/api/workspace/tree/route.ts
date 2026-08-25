import { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { withRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { getActiveWorkspace, ensureDefaultWorkspace, readTree } from "@/lib/workspace";
import {
  withErrorHandler,
  apiError, unauthorized, ok } from "@/app/api/_lib/helpers";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(async (req: NextRequest) => {
  let user;
  try {
    user = await requireUser();
  } catch {
    return unauthorized();
  }
  const limited = await withRateLimit(req, `ws-files:${user.id}`, RATE_LIMITS.terminal);
  if (limited) return limited;

  let ws = await getActiveWorkspace(user.id);
  if (!ws) ws = await ensureDefaultWorkspace(user.id);
  const tree = await readTree(user.id, ws.name, 6, ws.rootDir);
  return ok({ workspace: { id: ws.id, name: ws.name }, tree });
});
