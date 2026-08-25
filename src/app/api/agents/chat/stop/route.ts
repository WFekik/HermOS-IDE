import { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { abortAgentStream } from "@/lib/agent-abort";
import { cancelPendingForConversation } from "@/lib/permissions-prompt";
import { cancelPendingQuestionsForConversation } from "@/lib/question-prompt";
import { stopRunningCommand } from "@/lib/workspace";
import {
  withErrorHandler,
  parseJson, unauthorized, ok, apiError } from "@/app/api/_lib/helpers";
import { z } from "zod";

export const dynamic = "force-dynamic";

const schema = z.object({
  conversationId: z.string().trim().min(1).max(64),
});

/**
 * POST /api/agents/chat/stop
 *
 * Immediately aborts the running agent executor for the given conversation.
 * This is the reliable way to stop the agent — it calls abort() on the
 * AbortController registered by the chat route, which propagates to all
 * signal checks in the executor and any running tool calls.
 *
 * NOT rate limited — this is a safety mechanism. If an agent runs too long
 * or misbehaves, the user MUST be able to stop it, even if they hit the
 * button multiple times rapidly.
 */
export const POST = withErrorHandler(async (req: NextRequest) => {
  let user;
  try {
    user = await requireUser();
  } catch {
    return unauthorized();
  }

  const body = await parseJson<unknown>(req);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return apiError("Invalid payload.", 400, { details: parsed.error.flatten() });

  const { conversationId } = parsed.data;

  const aborted = abortAgentStream(conversationId);

  // Also cancel any pending permission prompts and question prompts so they don't dangle
  cancelPendingForConversation(conversationId);
  cancelPendingQuestionsForConversation(conversationId);

  stopRunningCommand(user.id, conversationId);

  return ok({ aborted });
});
