import { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/session";
import { withRateLimit } from "@/lib/rate-limit";
import { executeChat } from "@/lib/ai/executor";
import { registerAgentAbort, unregisterAgentAbort } from "@/lib/agent-abort";
import { cancelPendingForConversation } from "@/lib/permissions-prompt";
import { cancelPendingQuestionsForConversation } from "@/lib/question-prompt";
import { db } from "@/lib/db";
import { thinkingLevelSchema } from "@/lib/validation";
import type {
  ChatRequest,
  ChatStreamEvent,
  ProviderId,
  AgentMode,
} from "@/lib/types";
import {
  parseJson,
  apiError,
  unauthorized,
  notFound,
  enforceLoopbackRequest,
} from "@/app/api/_lib/helpers";

/**
 * Regenerate a conversation turn.
 *
 *   POST /api/conversations/[id]/regenerate
 *   body: { messageId: string }
 *
 * Behaviour:
 *   1. Resolve the target assistant message by `messageId`. It must belong to
 *      this conversation, belong to the calling user, and have role=assistant.
 *   2. Capture the last user message that came BEFORE that assistant message —
 *      that text becomes the "current" user prompt for the new run.
 *   3. Delete, in a transaction:
 *        - the target assistant message
 *        - every message at or after its createdAt (user, assistant, tool, …)
 *        - every tool execution row for the conversation created at or after
 *          the assistant message's createdAt
 *      We ALSO delete the last user message captured in step 2 because
 *      `executeChat` re-persists the user message itself — keeping it would
 *      duplicate it. This effectively rolls the conversation back to just
 *      before that user message, then re-runs from it.
 *   4. Re-invoke `executeChat` with a ChatRequest carrying the captured user
 *      text and the conversation's stored provider/model/mode/systemPrompt.
 *   5. Stream the new response back to the client via SSE using the same
 *      event format as `POST /api/agents/chat`.
 *
 * Requires auth + ownership. Rate limited at 30/min/user.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 3600; // 1 hour — let the agent work as long as needed

const bodySchema = z.object({
  messageId: z.string().trim().min(1).max(64),
  thinkingLevel: thinkingLevelSchema.optional(),
});

export async function POST(
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
  const limited = await withRateLimit(req, `regen:${user.id}`, {
    capacity: 30,
    refillPerSec: 30 / 60,
  });
  if (limited) return limited;

  const { id: conversationId } = await params;

  const body = await parseJson<unknown>(req);
  if (!body) return apiError("Invalid JSON body.", 400);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return apiError("Invalid regenerate request.", 400, {
      details: parsed.error.flatten(),
    });
  }
  const { messageId, thinkingLevel } = parsed.data;

  // Load conversation + verify ownership.
  const conv = await db.conversation.findUnique({
    where: { id: conversationId },
  });
  if (!conv || conv.userId !== user.id) {
    return notFound("Conversation not found");
  }

  // Load the target assistant message.
  const target = await db.message.findUnique({ where: { id: messageId } });
  if (!target || target.conversationId !== conversationId) {
    return notFound("Message not found");
  }
  if (target.role !== "assistant") {
    return apiError(
      "Can only regenerate assistant messages.",
      400,
      { code: "NOT_ASSISTANT" },
    );
  }

  // Find the last user message strictly BEFORE the target assistant message.
  const priorUserMsg = await db.message.findFirst({
    where: {
      conversationId,
      role: "user",
      createdAt: { lt: target.createdAt },
    },
    orderBy: { createdAt: "desc" },
  });
  if (!priorUserMsg) {
    return apiError(
      "No preceding user message to regenerate from.",
      400,
      { code: "NO_PROMPT" },
    );
  }
  const userPromptText = priorUserMsg.content;

  // Atomically roll the conversation back to just before the last user
  // message. We delete:
  //   - every message at or after the target assistant message's createdAt
  //   - the last user message (captured above) — executeChat re-creates it
  //   - every tool execution at or after the target's createdAt
  const targetTs = target.createdAt;
  const userTs = priorUserMsg.createdAt;
  await db.$transaction([
    db.message.deleteMany({
      where: {
        conversationId,
        OR: [{ createdAt: { gte: targetTs } }, { id: priorUserMsg.id }],
      },
    }),
    db.toolExecution.deleteMany({
      where: {
        conversationId,
        createdAt: { gte: targetTs },
      },
    }),
    db.conversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date() },
    }),
  ]);

  // Build a ChatRequest that mirrors the conversation's stored settings.
  // The executor will re-persist the user message and create a fresh
  // assistant message, then run the agent loop.
  const chatReq: ChatRequest = {
    conversationId,
    message: userPromptText,
    provider: conv.provider as ProviderId,
    model: conv.model,
    mode: conv.mode as AgentMode,
    ...(conv.systemPrompt ? { systemPrompt: conv.systemPrompt } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
  };

  // Server-side AbortController for this conversation session.
  // Aborted on explicit user request (POST /api/agents/chat/stop) or when
  // the provider goes silent for 5 consecutive minutes (inactivity timeout).
  // Does NOT abort on client disconnect / browser hard refresh.
  const abortController = new AbortController();

  // Rolling inactivity timeout — mirrors /api/agents/chat.
  let inactivityTimer: ReturnType<typeof setTimeout> | null = null;
  let inactivityAborted = false;
  const resetInactivityTimer = () => {
    if (inactivityTimer) clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
      inactivityAborted = true;
      abortController.abort();
    }, 300_000);
  };
  resetInactivityTimer();

  registerAgentAbort(conversationId, abortController);

  // SSE streaming response — mirrors /api/agents/chat.
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const emit = (event: ChatStreamEvent) => {
        resetInactivityTimer();
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
          );
        } catch {
          closed = true;
        }
      };
      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: keepalive\n\n`));
        } catch {
          closed = true;
        }
      }, 15_000);

      try {
        await executeChat({
          user: { id: user.id },
          req: chatReq,
          emit,
          signal: abortController.signal,
        });
      } catch (e) {
        if (abortController.signal.aborted && inactivityAborted) {
          emit({ type: "error", message: "Provider went silent for 5 minutes. Try again or use a different model.", code: "PROVIDER_TIMEOUT" });
        } else if (abortController.signal.aborted) {
          emit({ type: "error", message: "Turn stopped.", code: "ABORTED" });
        } else {
          const msg = e instanceof Error ? e.message : "Executor crashed.";
          emit({ type: "error", message: msg, code: "EXECUTOR_CRASH" });
        }
      } finally {
        clearInterval(heartbeat);
        if (inactivityTimer) clearTimeout(inactivityTimer);
        unregisterAgentAbort(conversationId, abortController);
        cancelPendingForConversation(conversationId);
        cancelPendingQuestionsForConversation(conversationId);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
        closed = true;
      }
    },
    cancel() {
      /* Client disconnected or refreshed — background execution continues */
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
