import { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { withRateLimit } from "@/lib/rate-limit";
import {
  getCheckpointFiles,
  deleteCheckpoint,
} from "@/lib/checkpoints";
import { apiError, unauthorized, ok, audit, enforceLoopbackRequest } from "@/app/api/_lib/helpers";

/**
 * Per-checkpoint GET (list files) and DELETE.
 *
 * - GET    /api/checkpoints/[id]   → { id, conversationId, files, fileCount }
 * - DELETE /api/checkpoints/[id]   → { ok }
 *
 * Rate limits:
 *   - GET:    60/min/user
 *   - DELETE: 10/min/user (same as create — destructive op)
 *
 * Auth + ownership: the checkpoints lib's `locateCheckpoint` walks the
 * user's own `.checkpoints/<convId>/` folders and re-verifies ownership of
 * the conversation before returning any path. So even if a malicious user
 * guesses another user's checkpoint id, the lookup will fail because it's
 * scoped to THIS user's checkpointsRoot.
 */

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const blocked = enforceLoopbackRequest(req);
  if (blocked) return blocked;
  let user;
  try {
    user = await requireUser();
  } catch {
    return unauthorized();
  }
  const limited = await withRateLimit(req, `cp-get:${user.id}`, {
    capacity: 60,
    refillPerSec: 60 / 60,
  });
  if (limited) return limited;

  const { id } = await params;
  try {
    const result = await getCheckpointFiles(user.id, id);
    return ok(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to read checkpoint.";
    const status = msg === "Checkpoint not found" ? 404 : 400;
    return apiError(msg, status);
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const blocked = enforceLoopbackRequest(req);
  if (blocked) return blocked;
  let user;
  try {
    user = await requireUser();
  } catch {
    return unauthorized();
  }
  const limited = await withRateLimit(req, `cp-delete:${user.id}`, {
    capacity: 10,
    refillPerSec: 10 / 60,
  });
  if (limited) return limited;

  const { id } = await params;
  try {
    const result = await deleteCheckpoint(user.id, id);
    try {
      await audit(
        user.id,
        "checkpoint_delete",
        JSON.stringify({ id, conversationId: result.conversationId }),
      );
    } catch {
      /* ignore */
    }
    return ok({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to delete checkpoint.";
    const status = msg === "Checkpoint not found" ? 404 : 400;
    return apiError(msg, status);
  }
}
