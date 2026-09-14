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

const stringOrArray = z.union([
  z.string().trim().min(1).max(1000).transform((s) => [s]),
  z
    .array(z.string().trim().max(1000))
    .max(50)
    .transform((arr) => arr.map((s) => s.trim()).filter((s) => s.length > 0)),
]);

const answerItemObjectSchema = z
  .object({
    questionIndex: z.number().int().nonnegative().optional(),
    question: z.string().trim().max(5000).optional(),
    selectedOptions: stringOrArray.optional(),
    selected: stringOrArray.optional(),
    value: z.string().trim().max(1000).optional(),
    answer: z.string().trim().max(10_000).optional(),
    text: z.string().trim().max(10_000).optional(),
  })
  .transform((data) => {
    let selected = data.selectedOptions ?? data.selected;
    // [] is truthy: an empty array plus a value must still pick up the value.
    if ((!selected || selected.length === 0) && data.value) {
      selected = [data.value];
    }
    // Normalize whitespace-only arrays to undefined so ["   "] does not flow
    // through as a selections-present answer.
    if (selected) {
      const cleaned = selected.map((s) => s.trim()).filter((s) => s.length > 0);
      selected = cleaned.length > 0 ? cleaned : undefined;
    }
    const rawText = (data.text ?? data.answer)?.trim();
    const text = rawText ? rawText : undefined;
    return {
      questionIndex: data.questionIndex,
      question: data.question,
      selectedOptions: selected,
      text,
    };
  });

const answerItemSchema = z.union([
  // Bare string: trim like the object text field and cap to the same limit
  // to prevent unbounded payloads.
  z.string().trim().min(1).max(10_000).transform((str) => ({ text: str })),
  answerItemObjectSchema,
]);

const answerSchema = z.object({
  id: z.string().trim().min(1).max(128),
  answers: z.array(answerItemSchema).max(20).optional(),
  selectedOptions: stringOrArray.optional(),
  selected: stringOrArray.optional(),
  selectedOption: z.string().trim().max(1000).optional(),
  value: z.string().trim().max(1000).optional(),
  answer: z.string().trim().max(10_000).optional(),
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

  const { id, answers, selectedOptions, selected, selectedOption, value, answer, text } = parsed.data;
  const nonEmpty = (arr: string[] | undefined): string[] | undefined => {
    if (!arr) return undefined;
    const cleaned = arr.map((s) => s.trim()).filter((s) => s.length > 0);
    return cleaned.length > 0 ? cleaned : undefined;
  };
  let effectiveSelected = nonEmpty(selectedOptions ?? selected);
  const singleOpt = (selectedOption ?? value)?.trim();
  if (!effectiveSelected && singleOpt) {
    effectiveSelected = [singleOpt];
  }
  const rawText = (text ?? answer)?.trim();
  const effectiveText = rawText ? rawText : undefined;
  const existing = peekPendingQuestion(id);
  if (!existing) {
    return notFound("Question prompt not found or already answered.");
  }
  if (existing.userId !== user.id) {
    return unauthorized();
  }

  const nonEmptyAnswers =
    answers && answers.length > 0
      ? answers.filter((a: { selectedOptions?: unknown; text?: unknown }) => {
          const sel = Array.isArray(a.selectedOptions)
            ? (a.selectedOptions as unknown[])
                .map((s: unknown) => String(s ?? "").trim())
                .filter((s: string) => s.length > 0)
            : undefined;
          const txt = typeof a.text === "string" ? a.text.trim() : "";
          return (sel && sel.length > 0) || txt.length > 0;
        })
      : undefined;

  const effectiveAnswers =
    nonEmptyAnswers && nonEmptyAnswers.length > 0
      ? nonEmptyAnswers
      : effectiveSelected || effectiveText
        ? (() => {
            // Top-level fields are only unambiguous for single-question prompts.
            // For multi-question prompts, require the structured answers[] array so
            // questions 1..n are not silently left unresolved.
            const questionCount = existing.questions?.length ?? 1;
            if (questionCount > 1) {
              return null; // signal: reject below
            }
            return [{ questionIndex: 0, selectedOptions: effectiveSelected, text: effectiveText }];
          })()
        : undefined;

  if (effectiveAnswers === null) {
    return apiError(
      "Use answers[] for multi-question prompts. Top-level selected/text fields only work for single-question prompts.",
      400,
    );
  }

  // Empty payload (no answers[], no selected, no text) would otherwise call
  // resolvePendingQuestion with all-undefined and hang or empty-resolve.
  // Reject explicitly so clients get a clear 400.
  if (!effectiveAnswers && !effectiveSelected && !effectiveText) {
    return apiError(
      "Empty answer payload. Provide answers[], selectedOptions/selected, or text.",
      400,
    );
  }

  const resolved = resolvePendingQuestion(id, user.id, {
    answers: effectiveAnswers,
    selectedOptions: effectiveSelected,
    text: effectiveText,
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
        answersCount: effectiveAnswers?.length ?? (effectiveSelected || effectiveText ? 1 : 0),
        selectedOptions: effectiveSelected,
        hasText: Boolean(effectiveText),
      }),
    );
  } catch {
    /* ignore audit errors */
  }

  return ok({ ok: true, id });
});
