import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createPendingQuestion,
  peekPendingQuestion,
  getPendingQuestionsForUser,
  resolvePendingQuestion,
  cancelPendingQuestionsForConversation,
  resetPendingQuestionsForTesting,
} from "@/lib/question-prompt";
import { askQuestionSchema } from "@/lib/ai/tools";

describe("Question Prompt Registry & Lifecycle (Multi & Single Question)", () => {
  beforeEach(() => {
    resetPendingQuestionsForTesting();
    vi.useFakeTimers();
  });

  afterEach(() => {
    resetPendingQuestionsForTesting();
    vi.useRealTimers();
  });

  it("creates and peeks a multi-question pending question correctly", () => {
    const { id, promise } = createPendingQuestion({
      userId: "u123",
      conversationId: "c123456789012345678901234",
      toolCallId: "tc_1",
      questions: [
        {
          question: "Which database do you prefer?",
          options: ["SQLite", "PostgreSQL"],
          isMultiSelect: false,
        },
        {
          question: "Which features should we enable?",
          options: ["Auth", "MCP", "Telemetry"],
          isMultiSelect: true,
        },
      ],
    });

    expect(id).toMatch(/^q_[a-f0-9]+$/);
    expect(promise).toBeInstanceOf(Promise);

    const dto = peekPendingQuestion(id);
    expect(dto).not.toBeNull();
    expect(dto?.id).toBe(id);
    expect(dto?.userId).toBe("u123");
    expect(dto?.questions).toHaveLength(2);
    expect(dto?.questions[0].question).toBe("Which database do you prefer?");
    expect(dto?.questions[1].isMultiSelect).toBe(true);
  });

  it("resolves multi-question answers with structured responses", async () => {
    const { id, promise } = createPendingQuestion({
      userId: "user_1",
      conversationId: "conv_1",
      toolCallId: "tc_1",
      questions: [
        {
          question: "Select database",
          options: ["SQLite", "Postgres"],
        },
        {
          question: "Choose styling",
          options: ["Tailwind", "CSS Modules"],
        },
      ],
    });

    const resolved = resolvePendingQuestion(id, "user_1", {
      answers: [
        {
          questionIndex: 0,
          question: "Select database",
          selectedOptions: ["Postgres"],
        },
        {
          questionIndex: 1,
          question: "Choose styling",
          selectedOptions: ["Tailwind"],
          text: "Use v4 syntax",
        },
      ],
    });

    expect(resolved).toBe(true);

    const result = await promise;
    expect(result.answers).toHaveLength(2);
    expect(result.answers![0].selectedOptions).toEqual(["Postgres"]);
    expect(result.answers![1].text).toBe("Use v4 syntax");
    expect(peekPendingQuestion(id)).toBeNull();
  });

  it("rejects resolution if userId does not match", async () => {
    const { id } = createPendingQuestion({
      userId: "owner_user",
      conversationId: "conv_1",
      toolCallId: "tc_1",
      questions: [{ question: "Owner question" }],
    });

    const resolved = resolvePendingQuestion(id, "attacker_user", {
      text: "Malicious override",
    });

    expect(resolved).toBe(false);
    expect(peekPendingQuestion(id)).not.toBeNull();
  });

  it("auto-resolves all questions when TTL expires", async () => {
    const { id, promise } = createPendingQuestion({
      userId: "user_1",
      conversationId: "conv_1",
      toolCallId: "tc_1",
      questions: [
        { question: "Q1" },
        { question: "Q2" },
      ],
      ttlMs: 5000,
    });

    vi.advanceTimersByTime(5001);

    const answer = await promise;
    expect(answer.timedOut).toBe(true);
    expect(answer.answers).toHaveLength(2);
    expect(answer.answers![0].text).toBe("Timed out");
    expect(peekPendingQuestion(id)).toBeNull();
  });

  it("cancels pending questions when conversation is stopped/aborted", async () => {
    const { id, promise } = createPendingQuestion({
      userId: "user_1",
      conversationId: "conv_target",
      toolCallId: "tc_1",
      questions: [{ question: "Pending question" }],
    });

    cancelPendingQuestionsForConversation("conv_target");

    const answer = await promise;
    expect(answer.cancelled).toBe(true);
    expect(peekPendingQuestion(id)).toBeNull();
  });
});

describe("ask_question Zod Schema Validation (Multi-Question & Single)", () => {
  it("accepts questions array with multiple questions", () => {
    const result = askQuestionSchema.safeParse({
      questions: [
        {
          question: "Select database",
          options: ["SQLite", "Postgres"],
          is_multi_select: false,
        },
        {
          question: "Choose cloud provider",
          options: ["AWS", "GCP"],
          is_multi_select: false,
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts single question shorthand", () => {
    const result = askQuestionSchema.safeParse({
      question: "What is your target port?",
      options: ["3000", "8080"],
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty questions array and missing single question", () => {
    const result = askQuestionSchema.safeParse({
      questions: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty question string in questions array", () => {
    const result = askQuestionSchema.safeParse({
      questions: [
        { question: "   " },
      ],
    });
    expect(result.success).toBe(false);
  });
});
