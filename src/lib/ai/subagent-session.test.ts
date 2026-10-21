import { describe, it, expect, afterEach } from "vitest";
import {
  createSession,
  getSession,
  updateSession,
  deleteSession,
  appendProgress,
  appendMessage,
  internalGet,
  subscribeSubagentPermissions,
  subscribeUserSubagentPermissions,
  getPendingPermissionSessions,
  clearSubagentsRolledBack,
  publishSubagentPermission,
} from "./subagent-session";
import type { SubagentSession } from "./subagent-session";
import { pruneOldToolOutputs, TOOL_OUTPUT_CLEARED } from "./context";
import { formatZodError, runTool } from "./tools";

describe("Subagent Session", () => {
  const userId = "user-1";
  const conversationId = "conv-1";

  // Track sessions created during a test for cleanup
  const createdSessions: string[] = [];
  afterEach(() => {
    for (const id of createdSessions) {
      deleteSession(userId, id);
    }
    createdSessions.length = 0;
  });

  function createTrackedSession(opts: {
    name: string;
    task: string;
    systemPrompt: string;
    allowedTools: string[];
    provider: string;
    model: string;
    checkpointId?: string;
  }): SubagentSession {
    const session = createSession(userId, conversationId, opts);
    createdSessions.push(session.id);
    return session;
  }

  describe("createSession", () => {
    it("should create a session with generated id", () => {
      const session = createTrackedSession({
        name: "test-agent",
        task: "refactor the code",
        systemPrompt: "You are a refactoring assistant.",
        allowedTools: ["read_file", "write_file", "edit_file"],
        provider: "openai",
        model: "gpt-4",
      });

      expect(session.id).toBeDefined();
      expect(session.id).toMatch(/^sa-/);
      expect(session.parentConversationId).toBe(conversationId);
      expect(session.userId).toBe(userId);
      expect(session.name).toBe("test-agent");
      expect(session.task).toBe("refactor the code");
      expect(session.allowedTools).toEqual(["read_file", "write_file", "edit_file"]);
      expect(session.status).toBe("pending");
      expect(session.messages).toEqual([]);
      expect(session.progressLog).toEqual([]);
      expect(session.createdAt).toBeGreaterThan(0);
    });

    it("should enforce name max length of 120", () => {
      const session = createTrackedSession({
        name: "x".repeat(200),
        task: "task",
        systemPrompt: "prompt",
        allowedTools: [],
        provider: "openai",
        model: "gpt-4",
      });
      expect(session.name.length).toBe(120);
    });

    it("should enforce task max length of 32000", () => {
      const session = createTrackedSession({
        name: "agent",
        task: "x".repeat(40000),
        systemPrompt: "prompt",
        allowedTools: [],
        provider: "openai",
        model: "gpt-4",
      });
      expect(session.task.length).toBe(32000);
    });

    it("should enforce systemPrompt max length of 16000", () => {
      const session = createTrackedSession({
        name: "agent",
        task: "task",
        systemPrompt: "x".repeat(20000),
        allowedTools: [],
        provider: "openai",
        model: "gpt-4",
      });
      expect(session.systemPrompt.length).toBe(16000);
    });
  });

  describe("getSession / internalGet", () => {
    it("should retrieve a session by id", () => {
      const session = createTrackedSession({
        name: "finder",
        task: "find things",
        systemPrompt: "find",
        allowedTools: ["grep"],
        provider: "openai",
        model: "gpt-4",
      });

      const found = getSession(userId, session.id);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(session.id);
    });

    it("should return null for non-existent session", () => {
      expect(getSession(userId, "non-existent")).toBeNull();
    });

    it("should enforce ACL — return null for wrong userId", () => {
      const session = createTrackedSession({
        name: "acl-test",
        task: "test",
        systemPrompt: "be helpful",
        allowedTools: [],
        provider: "openai",
        model: "gpt-4",
      });

      const wrongUser = getSession("other-user", session.id);
      expect(wrongUser).toBeNull();
    });

    it("should bypass ACL with internalGet", () => {
      const session = createTrackedSession({
        name: "internal-test",
        task: "test",
        systemPrompt: "be helpful",
        allowedTools: [],
        provider: "openai",
        model: "gpt-4",
      });

      const found = internalGet(session.id);
      expect(found).not.toBeNull();
      expect(found!.userId).toBe(userId);
    });
  });

  describe("updateSession", () => {
    it("should update session fields", () => {
      const session = createTrackedSession({
        name: "updater",
        task: "update test",
        systemPrompt: "be flexible",
        allowedTools: [],
        provider: "openai",
        model: "gpt-4",
      });

      updateSession(session.id, {
        status: "running",
        name: "renamed",
      });

      const updated = getSession(userId, session.id);
      expect(updated!.status).toBe("running");
      expect(updated!.name).toBe("renamed");
    });

    it("should not clobber id when passed in patch", () => {
      const session = createTrackedSession({
        name: "no-clobber",
        task: "test",
        systemPrompt: "be careful",
        allowedTools: [],
        provider: "openai",
        model: "gpt-4",
      });

      const originalId = session.id;
      updateSession(session.id, { id: "new-id", name: "new-name" } as any);

      const updated = getSession(userId, session.id);
      expect(updated!.id).toBe(originalId);
      expect(updated!.name).toBe("new-name");
    });

    it("should silently do nothing for non-existent session", () => {
      expect(() => updateSession("no-such-id", { status: "completed" })).not.toThrow();
    });
  });

  describe("appendProgress / appendMessage", () => {
    it("should append progress log entries", () => {
      const session = createTrackedSession({
        name: "progress-test",
        task: "track progress",
        systemPrompt: "be thorough",
        allowedTools: [],
        provider: "openai",
        model: "gpt-4",
      });

      appendProgress(session.id, "Starting task");
      appendProgress(session.id, "Reading file");
      appendProgress(session.id, "Done");

      const s = getSession(userId, session.id);
      expect(s!.progressLog).toHaveLength(3);
      expect(s!.progressLog[0]).toBe("Starting task");
      expect(s!.progressLog[2]).toBe("Done");
    });

    it("should append messages", () => {
      const session = createTrackedSession({
        name: "msg-test",
        task: "test messages",
        systemPrompt: "be responsive",
        allowedTools: [],
        provider: "openai",
        model: "gpt-4",
      });

      appendMessage(session.id, { role: "user", content: "hello" });
      appendMessage(session.id, { role: "assistant", content: "hi there", thinking: "thinking..." });

      const s = getSession(userId, session.id);
      expect(s!.messages).toHaveLength(2);
      expect(s!.messages[0].content).toBe("hello");
      expect(s!.messages[1].role).toBe("assistant");
      expect(s!.messages[1].thinking).toBe("thinking...");
    });

    it("should silently do nothing for non-existent session on append", () => {
      expect(() => appendProgress("no-id", "test")).not.toThrow();
      expect(() => appendMessage("no-id", { role: "user", content: "test" })).not.toThrow();
    });
  });

  describe("deleteSession", () => {
    it("should delete an existing session", () => {
      const session = createTrackedSession({
        name: "delete-test",
        task: "will be deleted",
        systemPrompt: "be gone",
        allowedTools: [],
        provider: "openai",
        model: "gpt-4",
      });

      const deleted = deleteSession(userId, session.id);
      expect(deleted).toBe(true);
      expect(getSession(userId, session.id)).toBeNull();
    });

    it("should return false for non-existent session", () => {
      expect(deleteSession(userId, "no-such-id")).toBe(false);
    });

    it("should enforce ACL — cannot delete another user's session", () => {
      const session = createTrackedSession({
        name: "acl-delete",
        task: "test",
        systemPrompt: "be secure",
        allowedTools: [],
        provider: "openai",
        model: "gpt-4",
      });

      const result = deleteSession("other-user", session.id);
      expect(result).toBe(false);
      // Session should still exist for the original user
      expect(getSession(userId, session.id)).not.toBeNull();
    });
  });

  describe("session lifecycle (integration)", () => {
    it("should complete full lifecycle: create -> update -> read -> delete", () => {
      // Create
      const session = createTrackedSession({
        name: "lifecycle",
        task: "full lifecycle test",
        systemPrompt: "be alive",
        allowedTools: ["read_file", "grep"],
        provider: "anthropic",
        model: "claude-3",
      });

      expect(session.status).toBe("pending");

      // Update to running
      updateSession(session.id, { status: "running" });
      expect(getSession(userId, session.id)!.status).toBe("running");

      // Append progress
      appendProgress(session.id, "started");
      appendMessage(session.id, { role: "user", content: "do work" });
      appendMessage(session.id, { role: "assistant", content: "working...", toolCalls: [{ id: "tc1", name: "read_file", arguments: "{}" }] });

      // Complete
      updateSession(session.id, {
        status: "completed",
        completedAt: Date.now(),
      });

      const final = getSession(userId, session.id);
      expect(final!.status).toBe("completed");
      expect(final!.completedAt).toBeGreaterThan(0);
      expect(final!.progressLog).toHaveLength(1);
      expect(final!.messages).toHaveLength(2);

      // Delete
      expect(deleteSession(userId, session.id)).toBe(true);
      expect(getSession(userId, session.id)).toBeNull();
    });
  });

  describe("permission channel", () => {
    it("carries no model-chosen permission policy", () => {
      const session = createTrackedSession({
        name: "perm-default",
        task: "test",
        systemPrompt: "be safe",
        allowedTools: [],
        provider: "openai",
        model: "gpt-4",
      });
      // The worker is judged by the user's settings — the spawn carries no
      // permission knob.
      expect("permissionMode" in session).toBe(false);
    });

    it("defaults agentMode to agent and stores the parent mode at spawn", () => {
      const session = createTrackedSession({
        name: "mode-default",
        task: "test",
        systemPrompt: "be safe",
        allowedTools: [],
        provider: "openai",
        model: "gpt-4",
      });
      expect(session.agentMode).toBe("agent");

      const architect = createSession(userId, conversationId, {
        name: "mode-architect",
        task: "test",
        systemPrompt: "be safe",
        allowedTools: ["read_file"],
        provider: "openai",
        model: "gpt-4",
        agentMode: "architect",
      });
      createdSessions.push(architect.id);
      expect(architect.agentMode).toBe("architect");
    });

    it("delivers permission publishes to the user-scoped channel of every conversation", () => {
      const session = createTrackedSession({
        name: "perm-user-scoped",
        task: "test",
        systemPrompt: "be safe",
        allowedTools: [],
        provider: "openai",
        model: "gpt-4",
      });

      const seen: Array<{ sessionId: string; conversationId: string }> = [];
      const unsubscribe = subscribeUserSubagentPermissions(userId, (sessionId, conversationId) => {
        seen.push({ sessionId, conversationId });
      });

      publishSubagentPermission(userId, "background-conv", session.id);
      expect(seen).toEqual([{ sessionId: session.id, conversationId: "background-conv" }]);

      unsubscribe();
      publishSubagentPermission(userId, "background-conv", session.id);
      expect(seen).toHaveLength(1);
    });

    it("supports awaiting_permission status with a pending permission payload", () => {
      const session = createTrackedSession({
        name: "perm-await",
        task: "test",
        systemPrompt: "be safe",
        allowedTools: [],
        provider: "openai",
        model: "gpt-4",
      });

      updateSession(session.id, {
        status: "awaiting_permission",
        pendingPermission: {
          approvalId: "pa_test",
          toolCallId: "tc1",
          toolName: "run_command",
          action: "command.run",
          target: "run `npm test`",
          createdAt: Date.now(),
        },
      });

      const updated = getSession(userId, session.id);
      expect(updated!.status).toBe("awaiting_permission");
      expect(updated!.pendingPermission?.approvalId).toBe("pa_test");
      expect(updated!.pendingPermission?.toolName).toBe("run_command");
    });

    it("does not leak permission publishes across users", () => {
      const seen: string[] = [];
      const unsubscribe = subscribeUserSubagentPermissions("other-user", (sessionId) => {
        seen.push(sessionId);
      });

      publishSubagentPermission(userId, conversationId, "sa-other");
      expect(seen).toEqual([]);

      unsubscribe();
    });

    it("lists the sessions of a user that are blocked on a permission", () => {
      const blocked = createTrackedSession({
        name: "perm-blocked",
        task: "test",
        systemPrompt: "be safe",
        allowedTools: [],
        provider: "openai",
        model: "gpt-4",
      });
      createTrackedSession({
        name: "perm-running",
        task: "test",
        systemPrompt: "be safe",
        allowedTools: [],
        provider: "openai",
        model: "gpt-4",
      });

      updateSession(blocked.id, {
        status: "awaiting_permission",
        pendingPermission: {
          approvalId: "pa_blocked",
          toolCallId: "tc1",
          toolName: "run_command",
          action: "command.run",
          target: "run `npm test`",
          createdAt: Date.now(),
        },
      });

      const pending = getPendingPermissionSessions(userId);
      expect(pending.map((s) => s.id)).toEqual([blocked.id]);
      expect(getPendingPermissionSessions("other-user")).toEqual([]);
    });

    it("rolls back only the workers a transcript rollback discarded", () => {
      const kept = createTrackedSession({
        name: "kept",
        task: "test",
        systemPrompt: "sp",
        allowedTools: [],
        provider: "openai",
        model: "gpt-4",
      });
      const discarded = createTrackedSession({
        name: "discarded",
        task: "test",
        systemPrompt: "sp",
        allowedTools: [],
        provider: "openai",
        model: "gpt-4",
      });

      // The rollback point sits between the two workers.
      const cutoff = kept.createdAt + 1;
      updateSession(discarded.id, { createdAt: cutoff + 10 });

      const { rolledBack, surviving } = clearSubagentsRolledBack(
        userId,
        conversationId,
        cutoff,
      );

      expect(rolledBack).toEqual([discarded.id]);
      expect(surviving).toEqual([kept.id]);
      expect(getSession(userId, discarded.id)?.rolledBack).toBe(true);
      expect(getSession(userId, kept.id)?.rolledBack).toBeUndefined();
    });

    it("rolls back a worker whose report the rollback deleted", () => {
      const worker = createTrackedSession({
        name: "late-report",
        task: "test",
        systemPrompt: "sp",
        allowedTools: [],
        provider: "openai",
        model: "gpt-4",
      });
      // Started before the rollback, but its report landed after it — the
      // report row was deleted, so the worker belongs to the discarded state.
      updateSession(worker.id, { completedAt: worker.createdAt + 5_000 });

      const cutoff = worker.createdAt + 1_000;
      const { rolledBack, surviving } = clearSubagentsRolledBack(
        userId,
        conversationId,
        cutoff,
      );

      expect(rolledBack).toEqual([worker.id]);
      expect(surviving).toEqual([]);
    });

    it("rolls back a worker revived after the cutoff even if originally created before it", () => {
      const worker = createTrackedSession({
        name: "revived-worker",
        task: "test",
        systemPrompt: "sp",
        allowedTools: [],
        provider: "openai",
        model: "gpt-4",
      });
      updateSession(worker.id, { createdAt: 1000, completedAt: 1500 });
      const cutoff = 2000;
      updateSession(worker.id, { completedAt: undefined, lastRunStartedAt: 2500 });

      const { rolledBack, surviving } = clearSubagentsRolledBack(
        userId,
        conversationId,
        cutoff,
      );

      expect(rolledBack).toEqual([worker.id]);
      expect(surviving).toEqual([]);
      expect(getSession(userId, worker.id)?.rolledBack).toBe(true);
    });
  });

  describe("Subagent Stage 1 Pruning & Tool Standardization", () => {
    it("prunes old subagent tool outputs before truncation", () => {
      const msgs = [
        { role: "user", content: "Research prompt" },
        { role: "assistant", content: "Reading file...", toolCalls: [{ id: "t1", name: "read_file", arguments: "{}" }] },
        { role: "tool", content: "LARGE TOOL RESULT ".repeat(100), toolCallId: "t1" },
        { role: "assistant", content: "Reading another file...", toolCalls: [{ id: "t2", name: "read_file", arguments: "{}" }] },
        { role: "tool", content: "LARGE TOOL RESULT ".repeat(100), toolCallId: "t2" },
        { role: "assistant", content: "Recent thought" },
        { role: "tool", content: "recent tool result", toolCallId: "t3" },
      ];

      const pruned = pruneOldToolOutputs(msgs, { pruneProtectTokens: 50 });
      expect(pruned.messages[2].content).toBe(TOOL_OUTPUT_CLEARED);
      expect(pruned.messages[6].content).toBe("recent tool result");
      expect(pruned.tokensFreed).toBeGreaterThan(0);
    });

    it("formatZodError produces clean human-readable error strings", async () => {
      const res = await runTool("read_file", {});
      expect(res.ok).toBe(false);
      const resultObj = res.result as { error: string };
      expect(typeof resultObj.error).toBe("string");
      expect(resultObj.error).toContain("Invalid arguments");
      expect(resultObj.error).toContain("path");
    });
  });
});
