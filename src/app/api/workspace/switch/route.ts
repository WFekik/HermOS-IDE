import { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { withRateLimit, getClientIp } from "@/lib/rate-limit";
import { z } from "zod";
import { switchWorkspace } from "@/lib/workspace";
import { parseJson, apiError, unauthorized, notFound, ok, audit, enforceLoopbackRequest } from "@/app/api/_lib/helpers";

export const dynamic = "force-dynamic";

const switchSchema = z.object({
  workspaceId: z.string().trim().min(1).max(64),
});

/**
 * POST /api/workspace/switch
 * body: { workspaceId: string }
 *
 * Switches the user's active workspace to the given `workspaceId`.
 *
 * 1. requireUser (401 on no session).
 * 2. Validate body with zod (1–64 char id).
 * 3. Call `switchWorkspace(userId, workspaceId)` — which atomically:
 *    - verifies the workspace exists AND belongs to the user (no IDOR),
 *    - marks the target workspace `isActive = true` and all the user's other
 *      workspaces `isActive = false` in a single transaction,
 *    - mirrors the workspace name onto `User.workspaceName`,
 *    - bumps `updatedAt` so the workspace sorts first in the switcher.
 * 4. Audit log the switch (action: `workspace_switch`).
 * 5. Return `{ ok: true, workspace: { id, name, isActive } }`.
 *
 * Errors:
 *   401 — no session.
 *   400 — invalid payload.
 *   404 — workspace not found OR does not belong to the user.
 *   429 — rate limit exceeded.
 *
 * Rate limit: 30/min/user. Switching workspaces is a deliberate user action,
 * 30/min is far more than any human would do but blocks trivial abuse.
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
  const limited = await withRateLimit(req, `ws-switch:${user.id}`, {
    capacity: 30,
    refillPerSec: 30 / 60,
  });
  if (limited) return limited;

  const body = await parseJson<unknown>(req);
  const parsed = switchSchema.safeParse(body);
  if (!parsed.success) {
    return apiError("Invalid payload.", 400, { details: parsed.error.flatten() });
  }

  const ws = await switchWorkspace(user.id, parsed.data.workspaceId);
  if (!ws) {
    // Don't leak whether the workspace exists vs. belongs to someone else —
    // same 404 either way.
    return notFound("Workspace not found.");
  }

  await audit(
    user.id,
    "workspace_switch",
    JSON.stringify({ workspaceId: ws.id, name: ws.name }),
    getClientIp(req),
  );

  return ok({
    ok: true,
    workspace: { id: ws.id, name: ws.name, isActive: true, rootDir: ws.rootDir },
  });
}
