import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createSession,
  updateSession,
  deleteSession,
  internalGet,
} from "@/lib/ai/subagent-session";
import type { SubagentSession } from "@/lib/ai/subagent-session";
import {
  deferSubagentDelivery,
  clearConversationDelivery,
  hasPendingWakeGrant,
  isSubagentReportDelivered,
} from "@/lib/ai/subagent-delivery";
import { markSubagentReportDelivered, unmarkSubagentReportDelivered } from "@/lib/ai/subagent-queue";
import { reviveSubagent } from "@/lib/ai/subagent-executor";
import { db } from "@/lib/db";

vi.mock("@/lib/db", () => ({
  db: {
    providerKey: { findUnique: vi.fn(async () => null) },
    message: { create: vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: "m-1", ...args.data })) },
  },
}));

const messageCreate = vi.mocked(db.message.create);

const USER = "delivery-user";
const CONV = "delivery-conv";
const createdSessions: string[] = [];

function makeSession(name = "Agent"): SubagentSession {
  const session = createSession(USER, CONV, {
    name,
    task: "task",
    systemPrompt: "prompt",
    allowedTools: [],
    provider: "openai",
    model: "gpt-4o",
  });
  createdSessions.push(session.id);
  return session;
}

beforeEach(() => {
  clearConversationDelivery(USER, CONV);
  messageCreate.mockClear();
});

afterEach(() => {
  for (const id of createdSessions) {
    deleteSession(USER, id);
  }
  createdSessions.length = 0;
  clearConversationDelivery(USER, CONV);
});

describe("subagent report delivery after the main turn ended", () => {
  it("delivers the report + wake when a deferred subagent completes", async () => {
    const s = makeSession("Researcher");
    deferSubagentDelivery(USER, CONV, [s.id]);

    updateSession(s.id, {
      status: "completed",
      report: {
        summary: "Found the bug",
        findings: [{ file: "src/a.ts", action: "read_file", evidence: "line 40" }],
        conclusion: "The fix is X.",
      },
      completedAt: Date.now(),
    });

    await vi.waitFor(() => {
      expect(messageCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ role: "user", conversationId: CONV }),
        }),
      );
    });
    const row = messageCreate.mock.calls[0][0] as { data: Record<string, string> };
    expect(row.data.content).toContain("## Summary");
    expect(row.data.content).toContain("Found the bug");
    await vi.waitFor(() => expect(hasPendingWakeGrant(USER, CONV)).toBe(true));
  });

  it("posts a failed report for a deferred subagent that failed", async () => {
    const s = makeSession("Broken");
    deferSubagentDelivery(USER, CONV, [s.id]);

    updateSession(s.id, {
      status: "failed",
      error: "Provider timeout",
      completedAt: Date.now(),
    });

    await vi.waitFor(() => {
      expect(messageCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ role: "user", conversationId: CONV }),
        }),
      );
    });
    const row = messageCreate.mock.calls[0][0] as { data: Record<string, string> };
    expect(row.data.content).toContain("Provider timeout");
    await vi.waitFor(() => expect(hasPendingWakeGrant(USER, CONV)).toBe(true));
  });

  it("delivers the revived subagent's SECOND report after the first was delivered", async () => {
    // First completion: report delivered + marked.
    const s = makeSession("Analyst");
    updateSession(s.id, {
      status: "completed",
      report: { summary: "first", findings: [], conclusion: "first" },
      completedAt: Date.now(),
    });
    markSubagentReportDelivered(USER, CONV, s.id);
    expect(isSubagentReportDelivered(USER, CONV, s.id)).toBe(true);

    // Main agent ends its turn while the subagent is (re)running → defer.
    const revived = reviveSubagent(USER, s.id, "continue please");
    expect(revived.ok).toBe(true);
    expect(isSubagentReportDelivered(USER, CONV, s.id)).toBe(false);
    deferSubagentDelivery(USER, CONV, [s.id]);

    // Revived worker fails fast (mocked db → no provider) → failed report.
    await vi.waitFor(() => expect(internalGet(s.id)?.status).toBe("failed"));

    await vi.waitFor(() => {
      expect(messageCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ role: "user", conversationId: CONV }),
        }),
      );
    });
    await vi.waitFor(() => expect(hasPendingWakeGrant(USER, CONV)).toBe(true));
    expect(isSubagentReportDelivered(USER, CONV, s.id)).toBe(true);
  });

  it("does not double-deliver: a report already posted by the watcher is not re-enqueued", async () => {
    const s = makeSession("OneShot");
    // Simulate the report being delivered while a run was active (drained).
    markSubagentReportDelivered(USER, CONV, s.id);
    updateSession(s.id, {
      status: "completed",
      report: { summary: "done", findings: [], conclusion: "done" },
      completedAt: Date.now(),
    });

    deferSubagentDelivery(USER, CONV, [s.id]);

    // Nothing is pending (the report was already delivered), so no second
    // post and nothing to wake for — the drainedAfterAnswer path grants the
    // wake directly in the real flow.
    await new Promise((r) => setTimeout(r, 50));
    expect(messageCreate).not.toHaveBeenCalled();
  });

  it("re-pends a revived subagent whose report a previous cycle already delivered", async () => {
    const s = makeSession("Revived");
    const other = makeSession("LongRunner");
    // Cycle 1: both deferred (running); A delivers writes, B stays pending →
    // the entry survives with A in its entry-local `delivered` set.
    deferSubagentDelivery(USER, CONV, [s.id, other.id]);
    updateSession(s.id, {
      status: "completed",
      report: { summary: "first", findings: [], conclusion: "first" },
      completedAt: Date.now(),
    });
    await vi.waitFor(() => expect(isSubagentReportDelivered(USER, CONV, s.id)).toBe(true));
    expect(messageCreate).toHaveBeenCalledTimes(1);

    // Main agent revives A → global delivered-marker cleared, session reset.
    unmarkSubagentReportDelivered(USER, CONV, s.id);
    updateSession(s.id, { status: "pending", report: undefined, error: undefined, completedAt: undefined });

    // A new main turn ends and re-defers the SAME subagents.
    deferSubagentDelivery(USER, CONV, [s.id, other.id]);

    // A re-completes → its SECOND report must be posted.
    updateSession(s.id, {
      status: "completed",
      report: { summary: "second", findings: [], conclusion: "second" },
      completedAt: Date.now(),
    });

    await vi.waitFor(() => {
      const posts = messageCreate.mock.calls
        .map((c) => (c[0] as { data: Record<string, string> }).data.content)
        .filter((c) => c.includes("second"));
      expect(posts).toHaveLength(1);
    });

    // B completes too → every pending report delivered → wake fires.
    updateSession(other.id, {
      status: "completed",
      report: { summary: "b-done", findings: [], conclusion: "b-done" },
      completedAt: Date.now(),
    });
    await vi.waitFor(() => expect(hasPendingWakeGrant(USER, CONV)).toBe(true));
  });
});

describe("transcript rollback — rolled-back subagents are never reported", () => {
  it("posts no report and fires no wake for a rolled-back worker", async () => {
    const s = makeSession("RolledBack");
    deferSubagentDelivery(USER, CONV, [s.id]);

    // The user undoes past this worker: its transcript is discarded.
    updateSession(s.id, { rolledBack: true });
    updateSession(s.id, {
      status: "completed",
      report: { summary: "discarded", findings: [], conclusion: "discarded" },
      completedAt: Date.now(),
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(messageCreate).not.toHaveBeenCalled();
    expect(hasPendingWakeGrant(USER, CONV)).toBe(false);
  });

  it("still delivers the workers the rollback kept", async () => {
    const discarded = makeSession("Discarded");
    const kept = makeSession("Kept");
    deferSubagentDelivery(USER, CONV, [discarded.id, kept.id]);

    updateSession(discarded.id, { rolledBack: true });
    updateSession(discarded.id, { status: "completed", completedAt: Date.now() });
    updateSession(kept.id, {
      status: "completed",
      report: { summary: "kept work", findings: [], conclusion: "kept work" },
      completedAt: Date.now(),
    });

    await vi.waitFor(() => {
      expect(messageCreate).toHaveBeenCalledTimes(1);
    });
    const row = messageCreate.mock.calls[0][0] as { data: Record<string, string> };
    expect(row.data.content).toContain("kept work");
    await vi.waitFor(() => expect(hasPendingWakeGrant(USER, CONV)).toBe(true));
  });
});
