import { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/session";
import { withRateLimit } from "@/lib/rate-limit";
import {
  withErrorHandler,
  parseJson,
  ok,
  apiError,
  notFound,
  unauthorized,
  audit,
} from "@/app/api/_lib/helpers";
import {
  getPendingQuestionsForUser,
  peekPendingQuestion,
  resolvePendingQuestion,
} from "@/lib/question-prompt";

export const dynamic = "force-dynamic";

const PENDING_RATE = { capacity: 60, refillPerSec: 60 / 60 };

const answerItemSchema = z.object({
  questionIndex: z.number().int().nonnegative().optional(),
  question: z.string().trim().max(5000).optional(),
  selectedOptions: z.array(z.string().trim().max(1000)).max(50).optional(),
  text: z.string().trim().max(10_000).optional(),
});

const answerSchema = z.object({
  id: z.string().trim().min(1).max(128),
  answers: z.array(answerItemSchema).max(20).optional(),
  selectedOptions: z.array(z.string().trim().max(1000)).max(50).optional(),
  text: z.string().trim().max(10_000).optional(),
});

export const GET = withErrorHandler(async (req: NextRequest) => {
  let user;
  try {
    user = await requireUser();
  } catch {
    return unauthorized();
  }
  const limited = await withRateLimit(req, `questions-pending:${user.id}`, PENDING_RATE);
  if (limited) return limited;

  const pending = getPendingQuestionsForUser(user.id);
  return ok({ pending });
});

export const POST = withErrorHandler(async (req: NextRequest) => {
  let user;
  try {
    user = await requireUser();
  } catch {
    return unauthorized();
  }
  const limited = await withRateLimit(req, `questions-answer:${user.id}`, PENDING_RATE);
  if (limited) return limited;

  const body = await parseJson<unknown>(req);
  const parsed = answerSchema.safeParse(body);
  if (!parsed.success) {
    return apiError("Invalid payload.", 400, { details: parsed.error.flatten() });
  }

  const { id, answers, selectedOptions, text } = parsed.data;
  const existing = peekPendingQuestion(id);
  if (!existing) {
    return notFound("Question prompt not found or already answered.");
  }
  if (existing.userId !== user.id) {
    return unauthorized();
  }

  const resolved = resolvePendingQuestion(id, user.id, {
    answers,
    selectedOptions,
    text,
  });

  if (!resolved) {
    return notFound("Failed to resolve question prompt.");
  }

  try {
    await audit(
      user.id,
      "question_answered",
      JSON.stringify({
        questionId: id,
        conversationId: existing.conversationId,
        answersCount: answers?.length ?? (selectedOptions || text ? 1 : 0),
        selectedOptions,
        hasText: Boolean(text),
      }),
    );
  } catch {
    /* ignore audit errors */
  }

  return ok({ ok: true, id });
});
