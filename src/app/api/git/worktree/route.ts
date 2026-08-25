import { NextRequest } from "next/server";
import path from "path";
import { requireUser } from "@/lib/session";
import { withRateLimit, getClientIp } from "@/lib/rate-limit";
import { z } from "zod";
import { getActiveWorkspace, ensureDefaultWorkspace } from "@/lib/workspace";
import {
  gitWorktreeList,
  gitWorktreeAdd,
  gitWorktreeRemove,
  gitIsRepo,
} from "@/lib/git";
import {
  parseJson,
  apiError,
  unauthorized,
  ok,
  audit,
  enforceLoopbackRequest,
} from "@/app/api/_lib/helpers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const addSchema = z.object({
  branch: z.string().trim().min(1).max(200),
  path: z.string().trim().min(1).max(1000),
});

/**
 * /api/git/worktree — manage git worktrees for the user's active workspace.
 *
 * GET — list worktrees:
 *   Returns `{ isRepo: boolean, worktrees: GitWorktree[] }` where
 *     GitWorktree = { path, branch, head, bare }
 *   The first entry is always the main worktree.
 *
 * POST — create a worktree:
 *   body: { branch: string, path: string }
 *   The `path` MUST resolve strictly under `<workspaceRoot>/.worktrees/` —
 *   this is enforced by `gitWorktreeAdd` (path confinement). We treat
 *   `path` as either an absolute path or a path relative to the workspace
 *   root; both are normalised via `path.resolve` and then confined.
 *
 *   To make it convenient for the frontend, if `path` is relative we treat
 *   it as relative to `<workspaceRoot>/.worktrees/`. So a POST with
 *   `{ branch: "feature", path: "feature" }` creates a worktree at
 *   `<workspaceRoot>/.worktrees/feature`.
 *
 *   Returns `{ ok, path }` on success, or `{ ok: false, error: "..." }` on
 *   failure (path escape, branch invalid, git error).
 *   Rate-limited at 10/min/user (worktree creation is a destructive-ish
 *   operation that touches the filesystem).
 *   Audit-logged as `git_worktree_add`.
 *
 * DELETE — remove a worktree:
 *   ?path=<path>&force=true
 *   Same path-confinement gate as POST. `force=true` bypasses git's "dirty
 *   worktree" check (use sparingly).
 *   Returns `{ ok }`.
 *   Rate-limited at 10/min/user.
 *   Audit-logged as `git_worktree_remove`.
 *
 * If the workspace is not a git repo, all three methods return
 * `{ isRepo: false, ... }` gracefully (with empty arrays for GET, ok:false
 * for POST/DELETE).
 */
export async function GET(req: NextRequest): Promise<Response> {
  const blocked = enforceLoopbackRequest(req);
  if (blocked) return blocked;
  let user;
  try {
    user = await requireUser();
  } catch {
    return unauthorized();
  }
  const limited = await withRateLimit(req, `git-worktree:${user.id}`, {
    capacity: 30,
    refillPerSec: 30 / 60,
  });
  if (limited) return limited;

  let ws = await getActiveWorkspace(user.id);
  if (!ws) ws = await ensureDefaultWorkspace(user.id);

  const isRepo = await gitIsRepo(ws.rootDir);
  if (!isRepo) {
    return ok({ isRepo: false, worktrees: [] });
  }

  const worktrees = await gitWorktreeList(ws.rootDir);
  return ok({ isRepo: true, worktrees });
}

export async function POST(req: NextRequest): Promise<Response> {
  const blocked = enforceLoopbackRequest(req);
  if (blocked) return blocked;
  let user;
  try {
    user = await requireUser();
  } catch {
    return unauthorized();
  }
  const limited = await withRateLimit(req, `git-worktree-add:${user.id}`, {
    capacity: 10,
    refillPerSec: 10 / 60,
  });
  if (limited) return limited;

  let ws = await getActiveWorkspace(user.id);
  if (!ws) ws = await ensureDefaultWorkspace(user.id);

  const isRepo = await gitIsRepo(ws.rootDir);
  if (!isRepo) {
    return apiError("Active workspace is not a git repository.", 400, {
      isRepo: false,
    });
  }

  const body = await parseJson<unknown>(req);
  const parsed = addSchema.safeParse(body);
  if (!parsed.success) {
    return apiError("Invalid payload.", 400, { details: parsed.error.flatten() });
  }

  const { branch, path: rawPath } = parsed.data;

  // Normalise the path. If the caller gave an absolute path that's already
  // under `.worktrees/`, use it as-is. If they gave a relative path (or any
  // path not under `.worktrees/`), prepend `<workspaceRoot>/.worktrees/`
  // so e.g. `"feature"` becomes `<workspaceRoot>/.worktrees/feature`.
  // The confine check inside `gitWorktreeAdd` then validates the final
  // resolved path is under `<workspaceRoot>/.worktrees/`.
  const normalizedPath = normalizeWorktreePath(ws.rootDir, rawPath);

  const result = await gitWorktreeAdd(ws.rootDir, branch, normalizedPath);
  await audit(
    user.id,
    "git_worktree_add",
    JSON.stringify({
      branch,
      path: result.path,
      ok: result.ok,
      workspace: ws.name,
    }),
    getClientIp(req),
  );

  if (!result.ok) {
    return apiError(
      "Failed to create worktree — branch may not exist, or the path is invalid/already exists.",
      400,
      { ok: false, path: result.path },
    );
  }
  return ok({ ok: true, path: result.path });
}

export async function DELETE(req: NextRequest): Promise<Response> {
  const blocked = enforceLoopbackRequest(req);
  if (blocked) return blocked;
  let user;
  try {
    user = await requireUser();
  } catch {
    return unauthorized();
  }
  const limited = await withRateLimit(req, `git-worktree-rm:${user.id}`, {
    capacity: 10,
    refillPerSec: 10 / 60,
  });
  if (limited) return limited;

  let ws = await getActiveWorkspace(user.id);
  if (!ws) ws = await ensureDefaultWorkspace(user.id);

  const isRepo = await gitIsRepo(ws.rootDir);
  if (!isRepo) {
    return apiError("Active workspace is not a git repository.", 400, {
      isRepo: false,
    });
  }

  const url = new URL(req.url);
  const rawPath = url.searchParams.get("path");
  if (!rawPath) {
    return apiError("Missing 'path' query parameter.", 400);
  }
  const force = url.searchParams.get("force") === "1" || url.searchParams.get("force") === "true";

  const normalizedPath = normalizeWorktreePath(ws.rootDir, rawPath);
  const result = await gitWorktreeRemove(ws.rootDir, normalizedPath, force);
  await audit(
    user.id,
    "git_worktree_remove",
    JSON.stringify({
      path: normalizedPath,
      force,
      ok: result.ok,
      workspace: ws.name,
    }),
    getClientIp(req),
  );

  if (!result.ok) {
    return apiError(
      "Failed to remove worktree — it may have uncommitted changes (use ?force=1) or already be gone.",
      400,
      { ok: false },
    );
  }
  return ok({ ok: true });
}

/**
 * Normalise a user-supplied worktree path. If `raw` is already an absolute
 * path under `<rootDir>/.worktrees/`, return it unchanged. Otherwise treat
 * `raw` as relative to `<rootDir>/.worktrees/` and join it.
 *
 * The confinement check is performed by `gitWorktreeAdd` / `gitWorktreeRemove`
 * — this function only decides WHERE to anchor relative paths. If the user
 * passes a path that resolves OUTSIDE `.worktrees/` after this normalisation,
 * the confinement check will reject it.
 */
function normalizeWorktreePath(rootDir: string, raw: string): string {
  if (path.isAbsolute(raw)) {
    return raw;
  }
  return path.join(rootDir, ".worktrees", raw);
}
