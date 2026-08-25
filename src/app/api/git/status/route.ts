import { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { withRateLimit } from "@/lib/rate-limit";
import { getActiveWorkspace, ensureDefaultWorkspace } from "@/lib/workspace";
import { gitStatus, gitIsRepo } from "@/lib/git";
import {
  withErrorHandler,
  unauthorized, ok } from "@/app/api/_lib/helpers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs"; // required for child_process.execFile

/**
 * GET /api/git/status
 *
 * Returns the git status of the user's active workspace.
 *
 * Shape:
 *   {
 *     isRepo: boolean,
 *     status: GitStatus    // { branch, ahead, behind, staged[], modified[],
 *                          //   untracked[], clean }
 *   }
 *
 * If the workspace is not a git repo, returns `{ isRepo: false, status: <empty> }`
 * — the frontend uses this to render a "Not a git repository" empty state
 * instead of erroring.
 *
 * Rate-limited at 30/min/user. The status panel polls on focus + manual
 * refresh; 30/min is plenty for either.
 */
export const GET = withErrorHandler(async (req: NextRequest) => {
  let user;
  try {
    user = await requireUser();
  } catch {
    return unauthorized();
  }
  const limited = await withRateLimit(req, `git-status:${user.id}`, {
    capacity: 30,
    refillPerSec: 30 / 60,
  });
  if (limited) return limited;

  let ws = await getActiveWorkspace(user.id);
  if (!ws) ws = await ensureDefaultWorkspace(user.id);

  const isRepo = await gitIsRepo(ws.rootDir);
  if (!isRepo) {
    return ok({
      isRepo: false,
      status: {
        branch: "",
        ahead: 0,
        behind: 0,
        staged: [],
        modified: [],
        untracked: [],
        clean: true,
      },
    });
  }

  const status = await gitStatus(ws.rootDir);
  return ok({ isRepo: true, status });
});
