import { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { withRateLimit, getClientIp } from "@/lib/rate-limit";
import { db } from "@/lib/db";
import { clearConversationCache } from "@/lib/ai/executor";
import { clearConversationDelivery } from "@/lib/ai/subagent-delivery";
import { deleteAttachmentFiles } from "@/lib/provision-db";
import { deleteConversationCheckpoints } from "@/lib/checkpoints";
import {
  withErrorHandler,
  parseJson,
  apiError,
  ok,
  audit,
} from "@/app/api/_lib/helpers";

/**
 * Bulk delete conversations owned by the current user.
 *
 *   POST /api/conversations/bulk  body: { ids: string[] }
 *
 * - ids: 1–50 cuid strings.
 * - Verifies ALL ids belong to the user before deleting; 403 if any don't.
 * - Deletes inside a transaction; cascade removes messages + tool executions.
 * - Audit-logs the bulk delete with `{ count, ids }` (ids truncated to 2000 chars).
 * - Returns `{ ok: true, deleted: <count> }`.
 *
 * Rate limited at 10/min/user (bulk ops are heavier). Auth required.
 */
export const dynamic = "force-dynamic";

const CUID_RE = /^[a-zA-Z0-9_-]{8,64}$/;
const MAX_IDS = 50;

export const POST = withErrorHandler(async (req: NextRequest): Promise<Response> => {
  const user = await requireUser();
  // Heavier op — tighter bucket.
  const limited = await withRateLimit(req, `conv-bulk:${user.id}`, {
    capacity: 10,
    refillPerSec: 10 / 60,
  });
  if (limited) return limited;

  const body = await parseJson<unknown>(req);
  if (!body) return apiError("Invalid JSON body.", 400);

  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body) ||
    !("ids" in body) ||
    !Array.isArray((body as { ids: unknown }).ids)
  ) {
    return apiError("Expected { ids: string[] }.", 400);
  }
  const ids = (body as { ids: unknown[] }).ids;
  if (ids.length < 1 || ids.length > MAX_IDS) {
    return apiError(`ids must contain 1–${MAX_IDS} entries.`, 400);
  }
  for (const id of ids) {
    if (typeof id !== "string" || !CUID_RE.test(id)) {
      return apiError("Each id must be a cuid string.", 400);
    }
  }
  // De-dupe just in case.
  const uniqueIds = Array.from(new Set(ids as string[]));

  // Ownership: count how many of the supplied ids actually belong to this
  // user. If the count is less than the unique count, at least one id is
  // foreign or missing — refuse the whole batch (no partial deletes) so we
  // never leak information via timing or partial state.
  const owned = await db.conversation.count({
    where: { id: { in: uniqueIds }, userId: user.id },
  });
  if (owned !== uniqueIds.length) {
    return apiError(
      "Some conversations were not found or do not belong to you.",
      403,
      { code: "FORBIDDEN" },
    );
  }

  // Fetch attachment file paths BEFORE deleting (rows cascade on delete) so
  // the on-disk files can be cleaned up afterwards.
  const attachmentPaths = (
    await db.attachment.findMany({
      where: { conversationId: { in: uniqueIds }, userId: user.id },
      select: { path: true },
    })
  ).map((a) => a.path);

  // Delete inside a transaction. Cascade rules in the Prisma schema remove
  // the related Message and ToolExecution rows automatically.
  const deleted = await db.$transaction(async (tx) => {
    const result = await tx.conversation.deleteMany({
      where: { id: { in: uniqueIds }, userId: user.id },
    });
    return result.count;
  });

  // Unlink uploaded files (realpath-containment-checked inside uploads root).
  deleteAttachmentFiles(attachmentPaths);

  for (const cid of uniqueIds) {
    clearConversationCache(cid);
    clearConversationDelivery(user.id, cid);
    await deleteConversationCheckpoints(user.id, cid);
  }

  // Audit log. Truncate the ids list so the column doesn't blow up.
  await audit(
    user.id,
    "conversation_bulk_delete",
    JSON.stringify({
      count: deleted,
      ids: uniqueIds.slice(0, 50),
    }).slice(0, 2000),
    getClientIp(req),
  );

  return ok({ ok: true, deleted });
});

// Also support DELETE for clients that use that method.
export const DELETE = POST;
