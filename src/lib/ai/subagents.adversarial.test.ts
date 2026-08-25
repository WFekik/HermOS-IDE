import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createSession,
  getSession,
  internalGet,
  subscribeSubagentUpdates,
  updateSession,
  appendProgress,
  appendMessage,
  deleteSession,
  clearConversationSubagents,
  SubagentSession,
} from "./subagent-session";
import { awaitSubagents } from "./subagent-executor";

describe("Subagent Orchestration — M3 Adversarial Tests", () => {
  const userId = "usr-test-123";
  const conversationId = "conv-sub-456";

  beforeEach(() => {
    clearConversationSubagents(userId, conversationId);
  });

  /* ------------------------------------------------------------------ *
   *  TS3.1: Running Session Eviction under Load
   * ------------------------------------------------------------------ */
  describe("TS3.1: Session Eviction under Load (10+ Subagents)", () => {
    it("evicts oldest terminal sessions when exceeding MAX_PER_CONVERSATION (10)", () => {
      const created: SubagentSession[] = [];
      for (let i = 0; i < 12; i++) {
        const s = createSession(userId, conversationId, {
          name: `Subagent ${i}`,
          task: `Task ${i}`,
          systemPrompt: "System",
          allowedTools: ["read_file"],
          provider: "openai",
          model: "gpt-4o",
        });
        if (i < 5) {
          updateSession(s.id, { status: "completed" });
        } else {
          updateSession(s.id, { status: "running" });
        }
        created.push(s);
      }

      // We created 12 subagents. MAX_PER_CONVERSATION is 10.
      // Subagents 0 and 1 (completed ones) should have been evicted first.
      expect(internalGet(created[0].id)).toBeNull();
      expect(internalGet(created[1].id)).toBeNull();

      // Subagent 2..11 should still exist in registry
      for (let i = 2; i < 12; i++) {
        expect(internalGet(created[i].id)).not.toBeNull();
      }
    });

    it("handles worker lookup returning null gracefully after session eviction", () => {
      const s = createSession(userId, conversationId, {
        name: "Evict Me",
        task: "Task",
        systemPrompt: "Prompt",
        allowedTools: [],
        provider: "openai",
        model: "gpt-4o",
      });

      // Manually delete session as if evicted mid-run
      deleteSession(userId, s.id);

      // internalGet returns null cleanly
      expect(internalGet(s.id)).toBeNull();
      // updateSession on non-existent session is a no-op and does not throw
      expect(() => updateSession(s.id, { status: "running" })).not.toThrow();
      expect(() => appendProgress(s.id, "step 1")).not.toThrow();
      expect(() => appendMessage(s.id, { role: "user", content: "hi" })).not.toThrow();
    });
  });

  /* ------------------------------------------------------------------ *
   *  TS3.2: awaitSubagents Timeout, Abort & Pre-Completed Resolution
   * ------------------------------------------------------------------ */
  describe("TS3.2: awaitSubagents Timeout & Resolution", () => {
    it("resolves immediately for subagents already in completed or failed state", async () => {
      const s1 = createSession(userId, conversationId, {
        name: "Fast Completed",
        task: "Task 1",
        systemPrompt: "Prompt",
        allowedTools: [],
        provider: "openai",
        model: "gpt-4o",
      });
      updateSession(s1.id, { status: "completed", report: { summary: "Done", findings: [], conclusion: "Success" } });

      const s2 = createSession(userId, conversationId, {
        name: "Fast Failed",
        task: "Task 2",
        systemPrompt: "Prompt",
        allowedTools: [],
        provider: "openai",
        model: "gpt-4o",
      });
      updateSession(s2.id, { status: "failed", error: "Quick error" });

      const start = performance.now();
      const results = await awaitSubagents(userId, [s1.id, s2.id], 5000);
      const elapsed = performance.now() - start;

      // Must return immediately without waiting for timeout
      expect(elapsed).toBeLessThan(100);
      expect(results).toHaveLength(2);
      expect(results[0]).toEqual({
        id: s1.id,
        name: "Fast Completed",
        status: "completed",
        report: { summary: "Done", findings: [], conclusion: "Success" },
        error: null,
      });
      expect(results[1]).toEqual({
        id: s2.id,
        name: "Fast Failed",
        status: "failed",
        report: null,
        error: "Quick error",
      });
    });

    it("times out and marks pending subagents as failed when timeout expires", async () => {
      const s = createSession(userId, conversationId, {
        name: "Slow Subagent",
        task: "Never finishes",
        systemPrompt: "Prompt",
        allowedTools: [],
        provider: "openai",
        model: "gpt-4o",
      });
      updateSession(s.id, { status: "running" });

      // Call awaitSubagents with a 50ms short timeout
      const results = await awaitSubagents(userId, [s.id], 50);

      expect(results).toHaveLength(1);
      expect(results[0].status).toBe("failed");
      expect(results[0].error).toBe("Timeout or aborted");
    });

    it("aborts when AbortSignal is triggered", async () => {
      const s = createSession(userId, conversationId, {
        name: "Aborted Subagent",
        task: "Task",
        systemPrompt: "Prompt",
        allowedTools: [],
        provider: "openai",
        model: "gpt-4o",
      });
      updateSession(s.id, { status: "running" });

      const controller = new AbortController();
      const awaitPromise = awaitSubagents(userId, [s.id], 10000, controller.signal);

      // Abort after 20ms
      setTimeout(() => controller.abort(), 20);

      const results = await awaitPromise;
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe("failed");
      expect(results[0].error).toBe("Timeout or aborted");
    });
  });

  /* ------------------------------------------------------------------ *
   *  TS3.3: Worker Error Isolation
   * ------------------------------------------------------------------ */
  describe("TS3.3: Worker Error Isolation", () => {
    it("updates subagent status to failed when error occurs during execution", () => {
      const s = createSession(userId, conversationId, {
        name: "Error Subagent",
        task: "Task",
        systemPrompt: "Prompt",
        allowedTools: [],
        provider: "openai",
        model: "gpt-4o",
      });

      // Simulate worker catching synthetic failure
      updateSession(s.id, { status: "failed", error: "Synthetic API 500 Error" });

      const updated = getSession(userId, s.id);
      expect(updated?.status).toBe("failed");
      expect(updated?.error).toBe("Synthetic API 500 Error");
    });
  });

  /* ------------------------------------------------------------------ *
   *  TS3.4: Pub/Sub Update Listener Integrity
   * ------------------------------------------------------------------ */
  describe("TS3.4: Pub/Sub Listener Integrity", () => {
    it("delivers notifications to multiple subscribers and unsubscribes cleanly", () => {
      const received1: string[] = [];
      const received2: string[] = [];

      const unsub1 = subscribeSubagentUpdates(userId, conversationId, (id) => received1.push(id));
      const unsub2 = subscribeSubagentUpdates(userId, conversationId, (id) => received2.push(id));

      const s = createSession(userId, conversationId, {
        name: "PubSub Test",
        task: "Task",
        systemPrompt: "Prompt",
        allowedTools: [],
        provider: "openai",
        model: "gpt-4o",
      });

      updateSession(s.id, { status: "running" });
      appendProgress(s.id, "Step 1");

      expect(received1.length).toBeGreaterThan(0);
      expect(received2.length).toBeGreaterThan(0);
      expect(received1).toEqual(received2);

      // Unsubscribe listener 1
      unsub1();

      const prevCount = received1.length;
      updateSession(s.id, { status: "completed" });

      // listener 1 received no further updates; listener 2 did
      expect(received1.length).toBe(prevCount);
      expect(received2.length).toBeGreaterThan(prevCount);

      unsub2();
    });

    it("isolates subscriber exceptions so other listeners still receive updates", () => {
      const throwingListener = vi.fn().mockImplementation(() => {
        throw new Error("Subscriber crash");
      });
      const healthyListener = vi.fn();

      const unsub1 = subscribeSubagentUpdates(userId, conversationId, throwingListener);
      const unsub2 = subscribeSubagentUpdates(userId, conversationId, healthyListener);

      const s = createSession(userId, conversationId, {
        name: "Fault Tolerant PubSub",
        task: "Task",
        systemPrompt: "Prompt",
        allowedTools: [],
        provider: "openai",
        model: "gpt-4o",
      });

      // Updating session triggers publish; throwing listener should not break healthy listener
      expect(() => updateSession(s.id, { status: "running" })).not.toThrow();

      expect(throwingListener).toHaveBeenCalled();
      expect(healthyListener).toHaveBeenCalled();

      unsub1();
      unsub2();
    });
  });
});
