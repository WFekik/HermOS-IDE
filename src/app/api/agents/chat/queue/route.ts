import { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { withRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { db } from "@/lib/db";
import { queueMessageSchema } from "@/lib/validation";
import { enqueueUserTurn } from "@/lib/ai/user-queue";
import { parseMentions } from "@/lib/mentions";
import {
  buildMentionContext,
  extractAttachmentPreview,
  resolveAttachments,
} from "@/lib/ai/executor";
import { withErrorHandler, parseJson, ok, apiError } from "@/app/api/_lib/helpers";

export const dynamic = "force-dynamic";

/**
 * POST /api/agents/chat/queue
 *
 * Queue a user message into an ALREADY-RUNNING agent loop WITHOUT interrupting
 * it. The row is persisted first (durable + visible in the transcript with the
 * client's own message id, so a local append + server refresh dedupe cleanly);
 * then the turn id is recorded in the in-memory queue. The running executor
 * drains that queue at its next iteration top and keeps iterating to answer
 * it. If no run is active (the turn missed the teardown, or the queue POST
 * landed on a different instance than the executor), the row simply sits
 * unanswered and the client's fallback auto-sends it on the next stop
 * transition.
 */
export const POST = withErrorHandler(async (req: NextRequest) => {
  const user = await requireUser();

  const body = await parseJson<unknown>(req);
  if (!body || typeof body !== "object") return apiError("Invalid JSON body.", 400);

  const limited = await withRateLimit(req, `chat:${user.id}`, RATE_LIMITS.chat);
  if (limited) return limited;

  const parsed = queueMessageSchema.safeParse(body);
  if (!parsed.success) {
    return apiError("Invalid queue request.", 400, { details: parsed.error.flatten() });
  }
  const { conversationId, message, messageId, attachmentIds } = parsed.data;

  // Verify conversation ownership
  const conversation = await db.conversation.findUnique({
    where: { id: conversationId },
    select: { userId: true },
  });
  if (!conversation || conversation.userId !== user.id) {
    return apiError("Conversation not found.", 404);
  }

  // Resolve attachments (ownership-scoped) and expand @mentions exactly like
  // the chat route's executeChat, so the stored row reflects what the model
  // will actually see: @file:<path> context inlined, attachment previews
  // appended. The @agent systemPromptOverride cannot apply — the running run
  // already built its system prompt.
  const resolvedAtts = await resolveAttachments(attachmentIds ?? [], user.id, conversationId);
  const mentions = parseMentions(message);
  let augmentedMessage = message;
  if (mentions.length > 0) {
    const { contextBlock } = await buildMentionContext(user.id, mentions);
    if (contextBlock) {
      augmentedMessage = contextBlock + "\n\n" + message;
    }
  }
  if (resolvedAtts.length > 0) {
    const previews = resolvedAtts.map((a) => extractAttachmentPreview(a));
    augmentedMessage += "\n\n## Attached files\n" + previews.join("\n\n");
  }
  const attachmentsJson = resolvedAtts.length > 0
    ? JSON.stringify(resolvedAtts.map((a) => ({ id: a.id, name: a.name, type: a.type, size: a.size })))
    : null;

  // Persist the user turn as a real row so the running loop's delta history
  // fetch sees it next iteration and the transcript reflects it immediately.
  let inserted = false;
  try {
    await db.message.create({
      data: {
        id: messageId,
        conversationId,
        role: "user",
        content: augmentedMessage,
        attachments: attachmentsJson,
      },
    });
    inserted = true;
  } catch (err) {
    // The client's end-of-run fallback re-send (chat route, SAME messageId)
    // may have landed first — the row is already durable, which is all this
    // route provides. Idempotent success; do NOT enqueue a marker: the run
    // that created the row already has the turn in its history.
    if ((err as { code?: string })?.code !== "P2002") throw err;
    // Defend in depth: the pre-existing row must belong to THIS conversation
    // (a foreign messageId — e.g. a stale client retry — must not leak a
    // marker or a row into a conversation it was never queued for).
    const existing = await db.message.findUnique({
      where: { id: messageId },
      select: { conversationId: true },
    });
    if (!existing || existing.conversationId !== conversationId) {
      return apiError("Message id already exists in another conversation.", 409);
    }
  }

  if (inserted) {
    // Record the id so the executor refuses to terminate on a final answer
    // while this turn is still unprocessed (and drains it into history).
    enqueueUserTurn(user.id, conversationId, messageId);
  }

  return ok({ queued: true, messageId });
});