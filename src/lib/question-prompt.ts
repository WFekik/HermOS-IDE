/**
 * In-memory registry of pending user questions for interactive agent prompts.
 * Supports single and multi-question prompts with O(1) indexed lookups.
 */

import { randomBytes } from "crypto";

export interface QuestionPromptItem {
  id?: string;
  question: string;
  options?: string[];
  isMultiSelect?: boolean;
}

export interface QuestionAnswerItem {
  questionIndex?: number;
  question?: string;
  selectedOptions?: string[];
  text?: string;
}

export interface QuestionAnswerPayload {
  answers?: QuestionAnswerItem[];
  selectedOptions?: string[];
  text?: string;
  timedOut?: boolean;
  cancelled?: boolean;
}

export interface PendingQuestion {
  id: string;
  userId: string;
  conversationId: string;
  toolCallId: string;
  questions: QuestionPromptItem[];
  createdAt: number;
  resolve: (answer: QuestionAnswerPayload) => void;
  timeout: NodeJS.Timeout;
}

export interface PendingQuestionDTO {
  id: string;
  userId: string;
  conversationId: string;
  toolCallId: string;
  questions: QuestionPromptItem[];
  createdAt: number;
}

export interface CreatePendingQuestionInput {
  userId: string;
  conversationId: string;
  toolCallId: string;
  questions: QuestionPromptItem[];
  ttlMs?: number;
}

/** Default TTL before auto-resolving: 5 minutes (300,000ms). */
export const DEFAULT_QUESTION_TTL_MS = 300_000;

const pendingById = new Map<string, PendingQuestion>();
const pendingByUser = new Map<string, Set<string>>();
const pendingByConversation = new Map<string, Set<string>>();

function newId(): string {
  return `q_${randomBytes(8).toString("hex")}`;
}

function toDTO(q: PendingQuestion): PendingQuestionDTO {
  return {
    id: q.id,
    userId: q.userId,
    conversationId: q.conversationId,
    toolCallId: q.toolCallId,
    questions: q.questions,
    createdAt: q.createdAt,
  };
}

function removeIndexes(entry: PendingQuestion): void {
  pendingById.delete(entry.id);

  const userSet = pendingByUser.get(entry.userId);
  if (userSet) {
    userSet.delete(entry.id);
    if (userSet.size === 0) pendingByUser.delete(entry.userId);
  }

  const convSet = pendingByConversation.get(entry.conversationId);
  if (convSet) {
    convSet.delete(entry.id);
    if (convSet.size === 0) pendingByConversation.delete(entry.conversationId);
  }
}

function expireEntry(entry: PendingQuestion): void {
  removeIndexes(entry);
  clearTimeout(entry.timeout);
  try {
    entry.resolve({
      text: "User did not answer within timeout. Proceed using best judgment.",
      timedOut: true,
      answers: entry.questions.map((q, idx) => ({
        questionIndex: idx,
        question: q.question,
        text: "Timed out",
      })),
    });
  } catch {
    /* ignore — promise may already be settled */
  }
}

function purgeExpired(now: number): void {
  for (const entry of pendingById.values()) {
    if (now - entry.createdAt > DEFAULT_QUESTION_TTL_MS) {
      expireEntry(entry);
    }
  }
}

/** Register a pending question; returns unique id and promise resolved on answer/timeout. */
export function createPendingQuestion(input: CreatePendingQuestionInput): {
  id: string;
  promise: Promise<QuestionAnswerPayload>;
} {
  const now = Date.now();
  purgeExpired(now);

  const id = newId();
  const ttl = input.ttlMs ?? DEFAULT_QUESTION_TTL_MS;

  let resolver!: (answer: QuestionAnswerPayload) => void;
  const promise = new Promise<QuestionAnswerPayload>((res) => {
    resolver = res;
  });

  const timer = setTimeout(() => {
    const entry = pendingById.get(id);
    if (entry) expireEntry(entry);
  }, ttl);

  if (typeof timer === "object" && typeof timer.unref === "function") {
    timer.unref();
  }

  const entry: PendingQuestion = {
    id,
    userId: input.userId,
    conversationId: input.conversationId,
    toolCallId: input.toolCallId,
    questions: input.questions,
    createdAt: now,
    resolve: resolver,
    timeout: timer,
  };

  pendingById.set(id, entry);

  let userSet = pendingByUser.get(input.userId);
  if (!userSet) {
    userSet = new Set<string>();
    pendingByUser.set(input.userId, userSet);
  }
  userSet.add(id);

  let convSet = pendingByConversation.get(input.conversationId);
  if (!convSet) {
    convSet = new Set<string>();
    pendingByConversation.set(input.conversationId, convSet);
  }
  convSet.add(id);

  return { id, promise };
}

/** Peek a pending question by id. */
export function peekPendingQuestion(id: string): PendingQuestionDTO | null {
  const entry = pendingById.get(id);
  return entry ? toDTO(entry) : null;
}

/** List all active pending questions for a user in O(k) time. */
export function getPendingQuestionsForUser(userId: string): PendingQuestionDTO[] {
  const userSet = pendingByUser.get(userId);
  if (!userSet || userSet.size === 0) return [];

  const list: PendingQuestionDTO[] = [];
  for (const id of userSet) {
    const entry = pendingById.get(id);
    if (entry) {
      list.push(toDTO(entry));
    }
  }
  return list;
}

/** Resolve a pending question with user-provided answer. Returns true if resolved, false if not found / unauthorized. */
export function resolvePendingQuestion(
  id: string,
  userId: string,
  payload: {
    answers?: QuestionAnswerItem[];
    selectedOptions?: string[];
    text?: string;
  },
): boolean {
  const entry = pendingById.get(id);
  if (!entry) return false;
  if (entry.userId !== userId) return false;

  removeIndexes(entry);
  clearTimeout(entry.timeout);
  try {
    entry.resolve({
      answers: payload.answers,
      selectedOptions: payload.selectedOptions,
      text: payload.text,
    });
  } catch {
    /* ignore */
  }

  return true;
}

/** Cancel all pending questions for a conversation in O(k) time. */
export function cancelPendingQuestionsForConversation(conversationId: string): void {
  const convSet = pendingByConversation.get(conversationId);
  if (!convSet || convSet.size === 0) return;

  const entriesToCancel: PendingQuestion[] = [];
  for (const id of convSet) {
    const entry = pendingById.get(id);
    if (entry) entriesToCancel.push(entry);
  }

  for (const entry of entriesToCancel) {
    removeIndexes(entry);
    clearTimeout(entry.timeout);
    try {
      entry.resolve({
        text: "Agent execution was stopped or cancelled by user.",
        cancelled: true,
        answers: entry.questions.map((q, idx) => ({
          questionIndex: idx,
          question: q.question,
          text: "Cancelled",
        })),
      });
    } catch {
      /* ignore */
    }
  }
}

/** Reset pending questions map — for test suites only. */
export function resetPendingQuestionsForTesting(): void {
  for (const entry of pendingById.values()) {
    clearTimeout(entry.timeout);
  }
  pendingById.clear();
  pendingByUser.clear();
  pendingByConversation.clear();
}

/** Race a promise against an AbortSignal. */
export function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(new Error("ABORTED"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(new Error("ABORTED"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise
      .then((val) => {
        signal.removeEventListener("abort", onAbort);
        resolve(val);
      })
      .catch((err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      });
  });
}
