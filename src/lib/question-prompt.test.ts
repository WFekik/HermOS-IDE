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

  it("rejects whitespace-only question/title/prompt/text (alias paths)", () => {
    for (const alias of ["question", "title", "prompt"] as const) {
      const r = askQuestionSchema.safeParse({ [alias]: "   " });
      expect(r.success, `alias ${alias} whitespace should fail`).toBe(false);
    }
    const nested = askQuestionSchema.safeParse({
      questions: [{ title: "   ", options: ["a"] }],
    });
    expect(nested.success).toBe(false);
  });

  it("accepts questions with camelCase isMultiSelect and object options", () => {
    const result = askQuestionSchema.safeParse({
      questions: [
        {
          question: "Select database",
          options: [{ label: "SQLite", value: "sqlite" }, { label: "Postgres", value: "postgres" }],
          isMultiSelect: true,
        },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.questions?.[0].isMultiSelect).toBe(true);
      expect(result.data.questions?.[0].options).toEqual(["SQLite", "Postgres"]);
    }
  });

  it("accepts title/prompt aliases and single object questions", () => {
    const result = askQuestionSchema.safeParse({
      questions: {
        title: "Which deployment target?",
        options: [{ text: "Vercel" }, { name: "AWS" }],
        multiSelect: "true",
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.questions?.[0].question).toBe("Which deployment target?");
      expect(result.data.questions?.[0].isMultiSelect).toBe(true);
      expect(result.data.questions?.[0].options).toEqual(["Vercel", "AWS"]);
    }
  });

  describe("answerSchema validation & multi-question safety", () => {
    afterEach(() => {
      // Isolate route tests: resolve/cancel any prompt the test registered so
      // conv_multi_* entries never leak across tests.
      cancelPendingQuestionsForConversation("conv_multi_1");
      cancelPendingQuestionsForConversation("conv_ws_1");
      resetPendingQuestionsForTesting();
    });

    it("cleans whitespace-only selectedOptions to empty (no phantom selection)", async () => {
      const { id } = createPendingQuestion({
        userId: "desktop-user",
        conversationId: "conv_ws_1",
        toolCallId: "tc_ws1",
        questions: [{ question: "Pick one?" }],
      });
      const route = await import("@/app/api/agents/questions/pending/route");
      const req = new Request("http://localhost/api/agents/questions/pending", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, answers: [{ selectedOptions: ["   "] }] }),
      });
      const res = await route.POST(req as any);
      // Whitespace-only selection carries no answer → empty-payload 400,
      // never a phantom selection flowing to resolvePendingQuestion.
      expect(res.status).toBe(400);
    });

    it("caps plain string answers to 10,000 characters and rejects oversized inputs", async () => {
      // Import the schemas directly from the route module
      const route = await import("@/app/api/agents/questions/pending/route");
      // Test via sending a mock POST request with oversized bare-string answer
      const oversized = "a".repeat(10_001);
      const normal = "a".repeat(10_000);

      const makeReq = (ans: unknown) =>
        new Request("http://localhost/api/agents/questions/pending", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: "q_test", answers: [ans] }),
        });

      // Oversized string should fail validation
      const badReq = makeReq(oversized);
      const badRes = await route.POST(badReq as any);
      expect(badRes.status).toBe(400);

      // Normal string <= 10,000 passes schema validation (might 404 on non-existent question ID, not 400)
      const okReq = makeReq(normal);
      const okRes = await route.POST(okReq as any);
      expect(okRes.status).not.toBe(400);
    });

    it("rejects ambiguous top-level fallback when prompt has multiple questions", async () => {
      const route = await import("@/app/api/agents/questions/pending/route");

      // Register a multi-question prompt in registry
      const { id } = createPendingQuestion({
        userId: "desktop-user",
        conversationId: "conv_multi_1",
        toolCallId: "tc_m1",
        questions: [
          { question: "First question?" },
          { question: "Second question?" },
        ],
      });

      // Submit with only top-level text instead of answers array
      const req = new Request("http://localhost/api/agents/questions/pending", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id,
          text: "Only answering one question at top level",
        }),
      });

      const res = await route.POST(req as any);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toMatch(/answers\[\]/);
    });
  });
});
