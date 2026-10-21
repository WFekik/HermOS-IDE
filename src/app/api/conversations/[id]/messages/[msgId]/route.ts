import { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { z } from "zod";
import { withRateLimit, getClientIp } from "@/lib/rate-limit";
import { db } from "@/lib/db";
import {
  parseJson,
  apiError,
  unauthorized,
  ok,
  audit,
  enforceLoopbackRequest,
} from "@/app/api/_lib/helpers";
import { abortAgentStream } from "@/lib/agent-abort";
import { cancelPendingForConversation } from "@/lib/permissions-prompt";
import { cancelPendingQuestionsForConversation } from "@/lib/question-prompt";
import { clearSubagentsRolledBack } from "@/lib/ai/subagent-session";
import { dropQueuedReports } from "@/lib/ai/subagent-queue";
import { clearAllWakeGrants, pauseConversationDelivery } from "@/lib/ai/subagent-delivery";
import { pauseConversationToolExecution } from "@/lib/ai/subagent-executor";
import { clearConversationCache } from "@/lib/ai/executor";
import { stopRunningCommand, clearCompletedCommand } from "@/lib/workspace";
import {
  restoreCheckpointsSinceTimestamp,
  buildUndoPreview,
  hashFileOnDisk,
  tryAcquireUndoLock,
  releaseUndoLock,
  type UndoPreview,
} from "@/lib/checkpoints";
import type { UserDTO } from "@/lib/types";

/** Resolve the conversation's current workspace root for undo containment. */
async function resolveUndoWorkspaceRoot(
  conversationId: string,
  userId: string,
): Promise<string | undefined> {
  try {
    const conv = await db.conversation.findUnique({
      where: { id: conversationId },
      select: { workspaceId: true },
    });
    if (!conv?.workspaceId) return undefined;
    const ws = await db.workspace.findUnique({
      where: { id: conv.workspaceId },
      select: { rootDir: true, userId: true },
    });
    if (!ws || ws.userId !== userId || !ws.rootDir) return undefined;
    return ws.rootDir;
  } catch {
    return undefined;
  }
}

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  content: z.string().min(1).max(8000),
});

async function resolveMessage(
  req: NextRequest,
  params: Promise<{ id: string; msgId: string }>,
  rateLimitKey: string,
): Promise<{ user: UserDTO; conversationId: string; msgId: string; msg: Awaited<ReturnType<typeof db.message.findUnique>>; res: Response | null }> {
  const blocked = enforceLoopbackRequest(req);
  if (blocked) return { user: null as unknown as UserDTO, conversationId: "", msgId: "", msg: null, res: blocked };
  let user: UserDTO;
  try {
    user = await requireUser();
  } catch {
    return { user: null as unknown as UserDTO, conversationId: "", msgId: "", msg: null, res: unauthorized() };
  }


  const limited = await withRateLimit(req, `${rateLimitKey}:${user.id}`, {
    capacity: 30,
    refillPerSec: 30 / 60,
  });
  if (limited) return { user, conversationId: "", msgId: "", msg: null, res: limited };

  const { id: conversationId, msgId } = await params;

  const conv = await db.conversation.findUnique({
    where: { id: conversationId },
  });
  if (!conv || conv.userId !== user.id) {
    return { user, conversationId, msgId, msg: null, res: apiError("Conversation not found", 404) };
  }

  const msg = await db.message.findUnique({
    where: { id: msgId },
  });
  if (!msg || msg.conversationId !== conversationId) {
    return { user, conversationId, msgId, msg: null, res: apiError("Message not found", 404) };
  }

  return { user, conversationId, msgId, msg, res: null };
}

/**
 * PATCH /api/conversations/[id]/messages/[msgId]
 *
 * Edits a message's content. For user messages, deletes all messages
 * after it (assistant responses, tool messages) and their tool executions
 * so the conversation can be regenerated from the edited message.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; msgId: string }> },
): Promise<Response> {
  const resolved = await resolveMessage(req, params, "msg-edit");
  if (resolved.res) return resolved.res;
  const { user, conversationId, msgId } = resolved;
  const msg = resolved.msg!;

  const body = await parseJson<unknown>(req);
  if (!body) return apiError("Invalid JSON body.", 400);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return apiError("Invalid payload.", 400, {
      details: parsed.error.flatten(),
    });
  }

  if (msg.role === "user") {
    await db.$transaction([
      db.message.update({
        where: { id: msgId },
        data: { content: parsed.data.content },
      }),
      db.message.deleteMany({
        where: {
          conversationId,
          createdAt: { gt: msg.createdAt },
        },
      }),
      db.toolExecution.deleteMany({
        where: {
          conversationId,
          createdAt: { gt: msg.createdAt },
        },
      }),
    ]);
    // Clean up in-memory state since we deleted messages after the edited one.
    cleanupConversationState(user.id, conversationId, msg.createdAt.getTime());
  } else {
    await db.message.update({
      where: { id: msgId },
      data: { content: parsed.data.content },
    });
  }

  await audit(
    user.id,
    "message_edit",
    JSON.stringify({ conversationId, msgId, role: msg.role }),
    getClientIp(req),
  );

  return ok({ ok: true });
}

const undoConfirmSchema = z.object({
  /** Echo of the preview's expected hashes — verified before executing. */
  expected: z
    .array(z.object({ path: z.string().min(1).max(4096), hash: z.string().max(128).nullable() }))
    .max(2000)
    .optional(),
  /** False = transcript-only undo (delete messages, leave files alone). */
  revertFiles: z.boolean().optional(),
});

/**
 * POST /api/conversations/[id]/messages/[msgId]
 *
 * Builds the undo plan for the Confirm Undo dialog WITHOUT changing
 * anything: per-file inverted line stats plus the expected on-disk hashes
 * the DELETE step must re-verify (server-side confirmation).
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; msgId: string }> },
): Promise<Response> {
  const resolved = await resolveMessage(req, params, "msg-undo-preview");
  if (resolved.res) return resolved.res;
  const { user, conversationId } = resolved;
  const msg = resolved.msg!;

  const workspaceRoot = await resolveUndoWorkspaceRoot(conversationId, user.id);
  const preview: UndoPreview = await buildUndoPreview(
    user.id,
    conversationId,
    msg.createdAt.getTime(),
    workspaceRoot ? { workspaceRoot } : {},
  );
  return ok({ ok: true, preview });
}

/**
 * DELETE /api/conversations/[id]/messages/[msgId]
 *
 * Deletes a user message and all messages after it, along with tool
 * executions and restores all checkpoints created since that message timestamp.
 * Used by the undo action in the UI (after the Confirm Undo dialog).
 *
 * Truth-propagating: a failed file restore returns 500 and the transcript
 * rows are NOT deleted — undo never reports success while files diverge.
 * When `expected` hashes are supplied, current on-disk state is re-verified
 * first; divergence returns 409 with a fresh preview (files changed since
 * the dialog was opened).
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; msgId: string }> },
): Promise<Response> {
  const resolved = await resolveMessage(req, params, "msg-delete");
  if (resolved.res) return resolved.res;
  const { user, conversationId, msgId } = resolved;
  const msg = resolved.msg!;

  let revertFiles = true;
  let expected: { path: string; hash: string | null }[] | undefined;
  const body = await parseJson<unknown>(req);
  if (body) {
    const parsed = undoConfirmSchema.safeParse(body);
    if (!parsed.success) {
      return apiError("Invalid undo confirmation payload.", 400, {
        details: parsed.error.flatten(),
      });
    }
    expected = parsed.data.expected;
    if (parsed.data.revertFiles === false) revertFiles = false;
  }

  const workspaceRoot = await resolveUndoWorkspaceRoot(conversationId, user.id);
  const restoreOpts = workspaceRoot ? { workspaceRoot } : {};
  // Fail-closed containment needs the CURRENT root; without it the gate is
  // blind (stale absolute paths would be trusted). Degrade to
  // transcript-only rather than writing to unverified locations — the client
  // surfaces the skip loudly instead of a false success.
  let filesSkipped = false;
  if (!workspaceRoot && revertFiles) {
    const probe = await buildUndoPreview(user.id, conversationId, msg.createdAt.getTime(), {});
    if (probe.attempted > 0) {
      revertFiles = false;
      filesSkipped = true;
    }
  }

  // Serialize verify → restore → transcript delete per conversation: a
  // second concurrent undo (or a racing tool write that got past its own
  // pre-write check) landing inside this window would otherwise clobber the
  // restore silently. 429 tells the caller to retry instead.
  if (!tryAcquireUndoLock(conversationId)) {
    return apiError("Another undo is already running for this conversation — retry in a moment.", 429);
  }
  try {
    return await executeUndoDelete();
  } finally {
    releaseUndoLock(conversationId);
  }

  async function executeUndoDelete(): Promise<Response> {

  // Server-side confirmation: re-verify the preview's expected hashes.
  // Anything that moved under us (user edit, background agent write since
  // the dialog opened) aborts with a fresh plan instead of a stale apply.
  if (revertFiles && expected && expected.length > 0) {
    const mismatched: string[] = [];
    for (const entry of expected) {
      const actual = await hashFileOnDisk(entry.path);
      if (actual !== entry.hash) mismatched.push(entry.path);
    }
    if (mismatched.length > 0) {
      const preview: UndoPreview = await buildUndoPreview(
        user.id,
        conversationId,
        msg.createdAt.getTime(),
        restoreOpts,
      );
      // NOTE: extra fields must nest under `details` — apiError spreads
      // top-level, but the client reads e.details.* (see ApiRequestError).
      return apiError("Files changed since the undo preview — review the fresh plan.", 409, {
        details: { mismatch: mismatched, preview },
      });
    }
  }

  const resumeDelivery = pauseConversationDelivery(conversationId);
  const releaseTools = pauseConversationToolExecution(conversationId);
  let restoredFiles: string[] = [];
  let failed: { id: string; error: string }[] = [];
  let attempted = 0;
  try {
    // Order matters: stop any in-flight command FIRST so a background process
    // cannot write to a file the rollback is about to restore over.
    cleanupConversationState(user.id, conversationId, msg.createdAt.getTime());

    // Restore all checkpoints created at or after this message's timestamp in reverse chronological order
    if (revertFiles) {
      const cpRes = await restoreCheckpointsSinceTimestamp(
        user.id,
        conversationId,
        msg.createdAt.getTime(),
        restoreOpts,
      );
      restoredFiles = cpRes.restoredFiles;
      failed = cpRes.failed;
      attempted = cpRes.attempted;
      if (!cpRes.ok) {
        // Do NOT delete transcript rows on a failed restore — disk and DB
        // must never diverge behind a success response.
        await audit(
          user.id,
          "message_delete_failed",
          JSON.stringify({ conversationId, msgId, failed: cpRes.failed }),
          getClientIp(req),
        );
        // Same `details`-nesting contract as the 409 above (client reads
        // e.details.failed — top-level extras never reach it).
        return apiError("Undo partially failed — files were left untouched and the transcript was kept.", 500, {
          details: {
            restoredFiles,
            failed: cpRes.failed,
            attempted: cpRes.attempted,
          },
        });
      }
    }

    // Fetch all message IDs in deterministic order to avoid timestamp-collision
    // over-deletion when two messages share the same createdAt.
    const msgsInOrder = await db.message.findMany({
      where: { conversationId },
      select: { id: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    const targetIdx = msgsInOrder.findIndex((m) => m.id === msgId);
    if (targetIdx === -1) {
      // Vanished between resolve and the post-restore fetch (concurrent
      // deleter). slice(-1) would delete the LAST row — the wrong message.
      return apiError("Message not found — it may already have been deleted.", 404);
    }
    const idsToDelete = msgsInOrder.slice(targetIdx).map((m) => m.id);

    await db.$transaction([
      db.message.deleteMany({
        where: { id: { in: idsToDelete } },
      }),
      db.toolExecution.deleteMany({
        where: {
          conversationId,
          createdAt: { gte: msg.createdAt },
        },
      }),
    ]);
  } finally {
    releaseTools();
    resumeDelivery();
  }

  await audit(
    user.id,
    "message_delete",
    JSON.stringify({ conversationId, msgId, role: msg.role, restoredFilesCount: restoredFiles.length, filesSkipped }),
    getClientIp(req),
  );

    return ok({ ok: true, restoredFiles, failed, attempted, filesSkipped });
  }
}

/**
 * Clean up in-memory server state associated with a conversation.
 * Called after undo (message DELETE) or message edit that deletes subsequent
 * messages, ensuring subagents, running commands, pending permissions, and
 * agent caches don't leak across conversation rollbacks.
 *
 * `cutoffMs` is the rollback point (the undone message's timestamp): only the
 * background work that belongs to the discarded tail is torn down — the
 * subagents that ran before it keep their sessions, approvals and reports.
 */
function cleanupConversationState(
  userId: string,
  conversationId: string,
  cutoffMs: number,
): void {
  abortAgentStream(conversationId);
  cancelPendingQuestionsForConversation(conversationId);
  clearConversationCache(conversationId);
  stopRunningCommand(userId, conversationId);
  clearCompletedCommand(userId, conversationId);

  // Roll back the background work of the discarded tail. The surviving
  // workers keep their pending approvals — only the rolled-back ones are
  // cancelled.
  const { rolledBack, surviving } = clearSubagentsRolledBack(
    userId,
    conversationId,
    cutoffMs,
  );
  cancelPendingForConversation(conversationId, new Set(surviving));
  if (rolledBack.length > 0) {
    // Their reports must never reach the agent again: a stale report would
    // make the next run redo the work the user just discarded.
    dropQueuedReports(userId, conversationId, rolledBack);
  }

  // A pending synthesis belongs to the rolled-back state — the autoWake
  // sentinel would restart the agent on a transcript the user just rewound.
  clearAllWakeGrants(userId, conversationId);
}
