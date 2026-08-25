import { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/session";
import { withRateLimit } from "@/lib/rate-limit";
import {
  createCheckpoint,
  listCheckpoints,
} from "@/lib/checkpoints";
import {
  withErrorHandler,
  parseJson, apiError, unauthorized, ok, audit } from "@/app/api/_lib/helpers";

/**
 * Checkpoints API — workspace snapshots so users can "keep" or "undo" agent
 * changes.
 *
 * - GET  /api/checkpoints?conversationId=<id>  → { checkpoints: CheckpointInfo[] }
 * - POST /api/checkpoints  body { conversationId, label? } → { checkpoint }
 *
 * Rate limits (per spec):
 *   - create (POST): 10/min/user
 *   - list (GET):    60/min/user
 *
 * Auth + conversation ownership enforced inside the checkpoints lib
 * (verifyConversationOwnership) — every entry point re-checks before touching
 * disk. The lib also enforces path confinement (CHECKPOINTS_DIR/<userId>/
 * .checkpoints/<convId>/<id>/) and caps at 20 checkpoints per conversation.
 */

export const dynamic = "force-dynamic";

const createSchema = z.object({
  conversationId: z.string().trim().min(1).max(64),
  label: z.string().trim().min(1).max(200).optional(),
});

export const GET = withErrorHandler(async (req: NextRequest) => {
  let user;
  try {
    user = await requireUser();
  } catch {
    return unauthorized();
  }
  const limited = await withRateLimit(req, `cp-list:${user.id}`, {
    capacity: 60,
    refillPerSec: 60 / 60,
  });
  if (limited) return limited;

  const url = new URL(req.url);
  const conversationId = url.searchParams.get("conversationId") || "";
  if (!conversationId) return apiError("Missing conversationId query.", 400);

  try {
    const checkpoints = await listCheckpoints(user.id, conversationId);
    return ok({ checkpoints });
  } catch (e) {
    // listCheckpoints throws "Conversation not found" on ownership failure.
    const msg = e instanceof Error ? e.message : "Failed to list checkpoints.";
    const status = msg === "Conversation not found" ? 404 : 400;
    return apiError(msg, status);
  }
});

export const POST = withErrorHandler(async (req: NextRequest) => {
  let user;
  try {
    user = await requireUser();
  } catch {
    return unauthorized();
  }
  const limited = await withRateLimit(req, `cp-create:${user.id}`, {
    capacity: 10,
    refillPerSec: 10 / 60,
  });
  if (limited) return limited;

  const body = await parseJson<unknown>(req);
  if (!body) return apiError("Invalid JSON body.", 400);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return apiError("Invalid payload.", 400, { details: parsed.error.flatten() });
  }

  try {
    const checkpoint = await createCheckpoint(
      user.id,
      parsed.data.conversationId,
      parsed.data.label,
    );
    try {
      await audit(
        user.id,
        "checkpoint_create",
        JSON.stringify({
          conversationId: parsed.data.conversationId,
          id: checkpoint.id,
          fileCount: checkpoint.fileCount,
        }),
      );
    } catch {
      /* ignore */
    }
    return ok({ checkpoint });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to create checkpoint.";
    const status = msg === "Conversation not found" ? 404 : 400;
    return apiError(msg, status);
  }
});
