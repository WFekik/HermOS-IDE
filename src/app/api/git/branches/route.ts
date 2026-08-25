// TODO(experimental/unwired): Kept intentionally — git branches endpoint is
// implemented but the git panel currently only uses status/diff/checkout.
// Retained for future branch-switcher UI.
import { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { withRateLimit } from "@/lib/rate-limit";
import { getActiveWorkspace, ensureDefaultWorkspace } from "@/lib/workspace";
import { gitBranches, gitIsRepo } from "@/lib/git";
import {
  withErrorHandler,
  unauthorized, ok } from "@/app/api/_lib/helpers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/git/branches
 *
 * Returns the list of branches (local + remote) in the user's active
 * workspace repo.
 *
 * Shape: `{ isRepo: boolean, branches: GitBranch[] }` where
 *   GitBranch = { name, current, remote }
 *
 * If the workspace is not a git repo, returns `{ isRepo: false, branches: [] }`.
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
  const limited = await withRateLimit(req, `git-branches:${user.id}`, {
    capacity: 30,
    refillPerSec: 30 / 60,
  });
  if (limited) return limited;

  let ws = await getActiveWorkspace(user.id);
  if (!ws) ws = await ensureDefaultWorkspace(user.id);

  const isRepo = await gitIsRepo(ws.rootDir);
  if (!isRepo) {
    return ok({ isRepo: false, branches: [] });
  }

  const branches = await gitBranches(ws.rootDir);
  return ok({ isRepo: true, branches });
});
