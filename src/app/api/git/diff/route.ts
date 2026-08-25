import { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { withRateLimit } from "@/lib/rate-limit";
import { getActiveWorkspace, ensureDefaultWorkspace, safePath } from "@/lib/workspace";
import { gitDiff, gitDiffBranches, gitIsRepo } from "@/lib/git";
import {
  withErrorHandler,
  apiError, unauthorized, ok } from "@/app/api/_lib/helpers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/git/diff?staged=true&path=<rel>&base=<branch>&compare=<branch>
 *
 * Returns the git diff of the user's active workspace.
 *
 * Modes:
 *   1. Branch comparison — `?base=main&compare=feature`:
 *      Returns `gitDiffBranches(base, compare)` — the diff between the two
 *      refs (what's on `compare` that's not on `base`).
 *   2. Staged diff — `?staged=true`:
 *      Returns `gitDiff({ staged: true })` — the diff of changes staged in
 *      the index vs. HEAD.
 *   3. Unstaged diff — (default):
 *      Returns `gitDiff()` — the diff of worktree changes vs. the index.
 *   4. Path filter — `?path=<workspace-relative-path>`:
 *      Limits either of (2) or (3) to a single file. The path is validated
 *      via `safePath` to ensure it doesn't escape the workspace.
 *
 * Shape: `{ isRepo: boolean, diff: GitDiffResult }` where
 *   GitDiffResult = { files: GitDiffFile[], totalAdditions, totalDeletions }
 *
 * If the workspace is not a git repo, returns `{ isRepo: false, diff: <empty> }`.
 *
 * Rate-limited at 30/min/user.
 *
 * Security:
 *   - `path` is validated with `safePath` (rejects `..`, confines to
 *     workspace root). We pass the workspace-relative form to git, never
 *     an absolute path.
 *   - `base` and `compare` are passed as separate args to git (no shell),
 *     and git itself validates them as ref names. We do a minimal sanity
 *     check in `gitDiffBranches` (length ≤ 200, no whitespace, no leading
 *     `-`) to reject obviously-bad input before invoking git.
 */
export const GET = withErrorHandler(async (req: NextRequest) => {
  let user;
  try {
    user = await requireUser();
  } catch {
    return unauthorized();
  }
  const limited = await withRateLimit(req, `git-diff:${user.id}`, {
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
      diff: { files: [], totalAdditions: 0, totalDeletions: 0 },
    });
  }

  const url = new URL(req.url);
  const base = url.searchParams.get("base");
  const compare = url.searchParams.get("compare");
  const staged = url.searchParams.get("staged") === "1" || url.searchParams.get("staged") === "true";
  const pathParam = url.searchParams.get("path");

  // Branch comparison mode — takes precedence over staged/path.
  if (base && compare) {
    const diff = await gitDiffBranches(ws.rootDir, base, compare);
    return ok({ isRepo: true, diff });
  }

  // Validate the path filter (if any) against the workspace root. `safePath`
  // returns null for traversal escapes (e.g. `../../etc/passwd`) — we 400 in
  // that case rather than silently ignoring it, so the caller knows their
  // path was rejected.
  let relPath: string | undefined;
  if (pathParam !== null) {
    const safe = safePath(user.id, ws.name, pathParam, ws.rootDir);
    if (!safe) {
      return apiError("Invalid path — must be inside the workspace.", 400);
    }
    // Convert the validated absolute path back to a workspace-relative posix
    // path for git. `safePath` returns an absolute path; we need the relative
    // form because git diffs are rooted at the repo root.
    const rootAbs = safePath(user.id, ws.name, ".", ws.rootDir);
    if (!rootAbs) {
      return apiError("Workspace root could not be resolved.", 500);
    }
    const relative = (() => {
      const r = safe.slice(rootAbs.length);
      return r.replace(/^[/\\]+/, "").split(/[\\/]/).join("/");
    })();
    relPath = relative || undefined;
  }

  const diff = await gitDiff(ws.rootDir, { staged, path: relPath });
  return ok({ isRepo: true, diff });
});
