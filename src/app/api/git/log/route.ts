// TODO(experimental/unwired): Kept intentionally — git log endpoint is
// implemented and uses the shared git helper but the git panel currently
// surfaces only status/diff. Retained for future commit-history UI.
import { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { withRateLimit } from "@/lib/rate-limit";
import { getActiveWorkspace, ensureDefaultWorkspace } from "@/lib/workspace";
import { gitLog, gitIsRepo } from "@/lib/git";
import {
  withErrorHandler,
  unauthorized, ok } from "@/app/api/_lib/helpers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/git/log?limit=20
 *
 * Returns the recent commit log of the user's active workspace.
 *
 * Shape: `{ isRepo: boolean, log: GitLogEntry[] }` where
 *   GitLogEntry = { hash, author, date, message }
 *
 * `limit` is clamped to [1, 50] (default 20).
 *
 * If the workspace is not a git repo, returns `{ isRepo: false, log: [] }`.
 *
 * Rate-limited at 30/min/user.
 */
export const GET = withErrorHandler(async (req: NextRequest) => {
  let user;
  try {
    user = await requireUser();
  } catch {
    return unauthorized();
  }
  const limited = await withRateLimit(req, `git-log:${user.id}`, {
    capacity: 30,
    refillPerSec: 30 / 60,
  });
  if (limited) return limited;

  let ws = await getActiveWorkspace(user.id);
  if (!ws) ws = await ensureDefaultWorkspace(user.id);

  const isRepo = await gitIsRepo(ws.rootDir);
  if (!isRepo) {
    return ok({ isRepo: false, log: [] });
  }

  const url = new URL(req.url);
  const limitRaw = url.searchParams.get("limit");
  let limit = 20;
  if (limitRaw !== null) {
    const n = Number.parseInt(limitRaw, 10);
    if (Number.isFinite(n)) {
      limit = Math.max(1, Math.min(50, n));
    }
  }

  const log = await gitLog(ws.rootDir, limit);
  return ok({ isRepo: true, log });
});
