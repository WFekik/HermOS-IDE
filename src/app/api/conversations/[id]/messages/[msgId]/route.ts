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
import { clearConversationSubagents } from "@/lib/ai/subagent-session";
import { clearConversationCache } from "@/lib/ai/executor";
import { stopRunningCommand, clearCompletedCommand } from "@/lib/workspace";
import { restoreCheckpointsSinceTimestamp } from "@/lib/checkpoints";
import type { UserDTO } from "@/lib/types";

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
    cleanupConversationState(user.id, conversationId);
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

/**
 * DELETE /api/conversations/[id]/messages/[msgId]
 *
 * Deletes a user message and all messages after it, along with tool
 * executions and restores all checkpoints created since that message timestamp.
 * Used by the undo action in the UI.
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; msgId: string }> },
): Promise<Response> {
  const resolved = await resolveMessage(req, params, "msg-delete");
  if (resolved.res) return resolved.res;
  const { user, conversationId, msgId } = resolved;
  const msg = resolved.msg!;

  // Order matters: stop any in-flight command FIRST so a background process
  // cannot write to a file the rollback is about to restore over.
  cleanupConversationState(user.id, conversationId);

  // Restore all checkpoints created at or after this message's timestamp in reverse chronological order
  let restoredFiles: string[] = [];
  try {
    const cpRes = await restoreCheckpointsSinceTimestamp(user.id, conversationId, msg.createdAt.getTime());
    restoredFiles = cpRes.restoredFiles;
  } catch (e) {
    console.warn(`[msg-delete] Warning restoring checkpoints for message ${msgId}:`, e);
  }

  // Fetch all message IDs in deterministic order to avoid timestamp-collision
  // over-deletion when two messages share the same createdAt.
  const msgsInOrder = await db.message.findMany({
    where: { conversationId },
    select: { id: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const targetIdx = msgsInOrder.findIndex((m) => m.id === msgId);
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

  await audit(
    user.id,
    "message_delete",
    JSON.stringify({ conversationId, msgId, role: msg.role, restoredFilesCount: restoredFiles.length }),
    getClientIp(req),
  );

  return ok({ ok: true, restoredFiles });
}

/**
 * Clean up in-memory server state associated with a conversation.
 * Called after undo (message DELETE) or message edit that deletes subsequent
 * messages, ensuring subagents, running commands, pending permissions, and
 * agent caches don't leak across conversation rollbacks.
 */
function cleanupConversationState(userId: string, conversationId: string): void {
  abortAgentStream(conversationId);
  cancelPendingForConversation(conversationId);
  cancelPendingQuestionsForConversation(conversationId);
  clearConversationSubagents(userId, conversationId);
  clearConversationCache(conversationId);
  stopRunningCommand(userId, conversationId);
  clearCompletedCommand(userId, conversationId);
}
