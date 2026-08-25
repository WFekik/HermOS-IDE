import { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { withRateLimit, getClientIp } from "@/lib/rate-limit";
import { z } from "zod";
import { getActiveWorkspace, ensureDefaultWorkspace } from "@/lib/workspace";
import { gitCheckout, gitIsRepo } from "@/lib/git";
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

const checkoutSchema = z.object({
  branch: z.string().trim().min(1).max(200),
});

/**
 * POST /api/git/checkout — check out a branch in the user's active workspace.
 *
 * body: { branch: string }
 * Returns `{ ok: true, branch }` on success.
 *
 * Error surfaces:
 *   400 — workspace is not a git repo, or invalid payload.
 *   404 — branch does not exist in the repo.
 *   409 — local changes would be overwritten (dirty tree / conflict).
 *   500 — other git failures (stderr surfaced via `details`).
 *
 * Rate-limited at 10/min/user (state-changing operation).
 * Audit-logged as `git_checkout`.
 */
export async function POST(req: NextRequest): Promise<Response> {
  const blocked = enforceLoopbackRequest(req);
  if (blocked) return blocked;
  let user;
  try {
    user = await requireUser();
  } catch {
    return unauthorized();
  }
  const limited = await withRateLimit(req, `git-checkout:${user.id}`, {
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
  const parsed = checkoutSchema.safeParse(body);
  if (!parsed.success) {
    return apiError("Invalid payload.", 400, { details: parsed.error.flatten() });
  }

  const { branch } = parsed.data;
  const result = await gitCheckout(ws.rootDir, branch);
  await audit(
    user.id,
    "git_checkout",
    JSON.stringify({
      branch,
      ok: result.ok,
      reason: result.reason ?? null,
      workspace: ws.name,
    }),
    getClientIp(req),
  );

  if (!result.ok) {
    switch (result.reason) {
      case "unknown_branch":
        return apiError(`Branch "${branch}" does not exist.`, 404, {
          reason: result.reason,
        });
      case "conflict":
        return apiError(
          "Cannot check out — uncommitted changes would be overwritten. Commit or stash them first.",
          409,
          { reason: result.reason },
        );
      case "invalid_ref":
        return apiError(result.stderr || "Invalid branch name.", 400, {
          reason: result.reason,
        });
      default:
        return apiError(
          `Failed to check out branch "${branch}".`,
          500,
          { reason: result.reason ?? "error", stderr: result.stderr?.slice(0, 500) },
        );
    }
  }
  return ok({ ok: true, branch });
}
