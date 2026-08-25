import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createSession,
  internalGet,
  updateSession,
  deleteSession,
} from "@/lib/ai/subagent-session";
import type { SubagentSession } from "@/lib/ai/subagent-session";
import {
  enqueueSubagentReport,
  drainSubagentReports,
  isSubagentReportDelivered,
  markSubagentReportDelivered,
  unmarkSubagentReportDelivered,
  enqueueSubagentMessage,
  drainSubagentMailbox,
  registerActiveRun,
  unregisterActiveRun,
  isRunActive,
  clearConversationQueue,
  formatSubagentReportText,
  buildSubagentReportContent,
} from "@/lib/ai/subagent-queue";
import { reviveSubagent } from "@/lib/ai/subagent-executor";

// The resume path re-runs the subagent worker, which resolves the provider
// from the DB — stub it so the worker fails fast instead of touching SQLite.
vi.mock("@/lib/db", () => ({
  db: { providerKey: { findUnique: vi.fn(async () => null) } },
}));

// Spy on updateSession (passthrough) so the transient "pending" reset that
// reviveSubagent performs can be asserted before the worker flips the status.
vi.mock("@/lib/ai/subagent-session", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/ai/subagent-session")>();
  return { ...mod, updateSession: vi.fn(mod.updateSession) };
});

const USER = "queue-user";
const CONV = "queue-conv";
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
  clearConversationQueue(USER, CONV);
  unregisterActiveRun(USER, CONV);
});

afterEach(() => {
  for (const id of createdSessions) {
    deleteSession(USER, id);
  }
  createdSessions.length = 0;
  clearConversationQueue(USER, CONV);
  unregisterActiveRun(USER, CONV);
});

describe("enqueueSubagentReport / drainSubagentReports", () => {
  it("delivers a queued report exactly once (second drain yields nothing)", () => {
    enqueueSubagentReport(USER, CONV, "sa-1");
    const first = drainSubagentReports(USER, CONV);
    expect(first).toHaveLength(1);
    expect(first[0].subagentId).toBe("sa-1");
    expect(first[0].id).toMatch(/^q-/);
    expect(first[0].content).toBeTruthy();
    expect(drainSubagentReports(USER, CONV)).toEqual([]);
  });

  it("skips re-enqueue of an already-delivered subagent id", () => {
    enqueueSubagentReport(USER, CONV, "sa-1");
    expect(drainSubagentReports(USER, CONV)).toHaveLength(1);
    markSubagentReportDelivered(USER, CONV, "sa-1");
    enqueueSubagentReport(USER, CONV, "sa-1");
    expect(drainSubagentReports(USER, CONV)).toEqual([]);
  });

  it("unmarkSubagentReportDelivered re-enables delivery", () => {
    markSubagentReportDelivered(USER, CONV, "sa-1");
    enqueueSubagentReport(USER, CONV, "sa-1");
    expect(drainSubagentReports(USER, CONV)).toEqual([]);
    unmarkSubagentReportDelivered(USER, CONV, "sa-1");
    enqueueSubagentReport(USER, CONV, "sa-1");
    expect(drainSubagentReports(USER, CONV)).toHaveLength(1);
  });

  it("caps queued reports at 50 per conversation (newest dropped)", () => {
    for (let i = 0; i < 55; i++) {
      enqueueSubagentReport(USER, CONV, `sa-cap-${i}`);
    }
    const drained = drainSubagentReports(USER, CONV);
    expect(drained).toHaveLength(50);
    expect(drained[0].subagentId).toBe("sa-cap-0");
    expect(drained[49].subagentId).toBe("sa-cap-49");
  });

  it("keeps queues isolated per user:conversation", () => {
    enqueueSubagentReport(USER, CONV, "sa-a");
    enqueueSubagentReport(USER, "conv-other", "sa-b");
    enqueueSubagentReport("other-user", CONV, "sa-c");
    expect(drainSubagentReports(USER, CONV).map((q) => q.subagentId)).toEqual(["sa-a"]);
    expect(drainSubagentReports(USER, "conv-other").map((q) => q.subagentId)).toEqual(["sa-b"]);
    expect(drainSubagentReports("other-user", CONV).map((q) => q.subagentId)).toEqual(["sa-c"]);
  });
});

describe("clearConversationQueue", () => {
  it("drops queued reports and the delivered-set for the conversation", () => {
    enqueueSubagentReport(USER, CONV, "sa-1");
    markSubagentReportDelivered(USER, CONV, "sa-2");
    clearConversationQueue(USER, CONV);
    expect(drainSubagentReports(USER, CONV)).toEqual([]);
    enqueueSubagentReport(USER, CONV, "sa-2");
    expect(drainSubagentReports(USER, CONV)).toHaveLength(1);
  });

  it("only drops mailboxes owned by the conversation's sessions", () => {
    const s = makeSession("Mailbox Owner");
    enqueueSubagentMessage(s.id, "ping");
    clearConversationQueue(USER, "unrelated-conv");
    expect(drainSubagentMailbox(s.id)).toEqual(["ping"]);
    clearConversationQueue(USER, CONV);
    expect(drainSubagentMailbox(s.id)).toEqual([]);
  });
});

describe("enqueueSubagentMessage / drainSubagentMailbox", () => {
  it("delivers messages FIFO", () => {
    enqueueSubagentMessage("sa-fifo", "first");
    enqueueSubagentMessage("sa-fifo", "second");
    enqueueSubagentMessage("sa-fifo", "third");
    expect(drainSubagentMailbox("sa-fifo")).toEqual(["first", "second", "third"]);
  });

  it("drains empty for an unknown subagent", () => {
    expect(drainSubagentMailbox("sa-ghost")).toEqual([]);
  });

  it("keeps mailboxes isolated per subagent", () => {
    enqueueSubagentMessage("sa-a", "for-a");
    enqueueSubagentMessage("sa-b", "for-b");
    enqueueSubagentMessage("sa-a", "also-for-a");
    expect(drainSubagentMailbox("sa-a")).toEqual(["for-a", "also-for-a"]);
    expect(drainSubagentMailbox("sa-b")).toEqual(["for-b"]);
    expect(drainSubagentMailbox("sa-a")).toEqual([]);
  });

  it("caps the mailbox at 20 messages (oldest dropped)", () => {
    for (let i = 0; i < 25; i++) {
      enqueueSubagentMessage("sa-big", `msg-${i}`);
    }
    const drained = drainSubagentMailbox("sa-big");
    expect(drained).toHaveLength(20);
    expect(drained[0]).toBe("msg-5");
    expect(drained[19]).toBe("msg-24");
  });
});

describe("registerActiveRun / isRunActive / unregisterActiveRun", () => {
  it("tracks per user:conversation runs and releases them", () => {
    expect(isRunActive(USER, CONV)).toBe(false);
    registerActiveRun(USER, CONV);
    expect(isRunActive(USER, CONV)).toBe(true);
    expect(isRunActive(USER, "conv-other")).toBe(false);
    expect(isRunActive("other-user", CONV)).toBe(false);
    unregisterActiveRun(USER, CONV);
    expect(isRunActive(USER, CONV)).toBe(false);
    unregisterActiveRun(USER, CONV);
    expect(isRunActive(USER, CONV)).toBe(false);
  });
});

describe("formatSubagentReportText", () => {
  const report = {
    summary: "Found the bug",
    findings: [
      { file: "src/a.ts", action: "read_file", evidence: "line 40" },
      { action: "analysis", evidence: "n/a" },
    ],
    conclusion: "The fix is X.",
  };

  it("renders summary, findings and conclusion", () => {
    expect(formatSubagentReportText(report)).toBe(
      "## Summary\nFound the bug\n\n## Findings\n\n- `src/a.ts` — read_file — (line 40)\n\n- analysis — (n/a)\n\n## Conclusion\nThe fix is X.",
    );
  });

  it("emits a marker when there are no findings", () => {
    const out = formatSubagentReportText({ summary: "S", findings: [], conclusion: "C" });
    expect(out).toContain("(no tool-verified findings");
  });

  it("keeps the marker minimal for an empty report", () => {
    expect(
      formatSubagentReportText({ summary: "", findings: [], conclusion: "" }),
    ).toBe(
      "## Summary\n\n\n## Findings\n(no tool-verified findings — this subagent produced no evidence-backed claims)\n\n## Conclusion\n",
    );
  });
});

describe("buildSubagentReportContent", () => {
  it("emits a failed marker when the session is gone", () => {
    expect(buildSubagentReportContent(USER, CONV, "sa-gone")).toBe(
      '<subagent_report name="Subagent" status="failed">\nSubagent was removed before completing.\n</subagent_report>',
    );
  });

  it("escapes the subagent name in the wrapper attribute", () => {
    const s = makeSession('Researcher "R" & <Co>');
    const out = buildSubagentReportContent(USER, CONV, s.id);
    expect(out).toContain('name="Researcher &quot;R&quot; &amp; &lt;Co&gt;"');
  });

  it("emits the error for a failed session", () => {
    const s = makeSession("Broken");
    updateSession(s.id, { status: "failed", error: "Boom" });
    expect(buildSubagentReportContent(USER, CONV, s.id)).toBe(
      '<subagent_report name="Broken" status="failed">\nBoom\n</subagent_report>',
    );
  });

  it("emits the no-final-answer marker for a completed session without a report", () => {
    const s = makeSession("Quiet");
    updateSession(s.id, { status: "completed", error: "Subagent did not produce a final answer." });
    expect(buildSubagentReportContent(USER, CONV, s.id)).toBe(
      '<subagent_report name="Quiet">\n(subagent did not produce a final answer — Subagent did not produce a final answer.)\n</subagent_report>',
    );
  });

  it("does not dump raw messages for a completed session without a report or error", () => {
    const s = makeSession("Silent");
    updateSession(s.id, { status: "completed" });
    expect(buildSubagentReportContent(USER, CONV, s.id)).toBe(
      '<subagent_report name="Silent">\n(subagent did not produce a final answer)\n</subagent_report>',
    );
  });

  it("wraps a completed session with a report in the full structured dump", () => {
    const s = makeSession("Analyst");
    updateSession(s.id, {
      status: "completed",
      report: {
        summary: "Found the bug",
        findings: [{ file: "src/a.ts", action: "read_file", evidence: "line 40" }],
        conclusion: "The fix is X.",
      },
    });
    expect(buildSubagentReportContent(USER, CONV, s.id)).toBe(
      '<subagent_report name="Analyst">\n## Summary\nFound the bug\n\n## Findings\n\n- `src/a.ts` — read_file — (line 40)\n\n## Conclusion\nThe fix is X.\n</subagent_report>',
    );
  });
});

describe("reviveSubagent", () => {
  it("queues a message to a running subagent without touching status or revives", () => {
    const s = makeSession("Running");
    updateSession(s.id, { status: "running" });
    const result = reviveSubagent(USER, s.id, "keep going");
    expect(result.ok).toBe(true);
    expect(result.status).toBe("queued");
    expect(internalGet(s.id)?.status).toBe("running");
    expect(internalGet(s.id)?.revives).toBe(0);
    expect(drainSubagentMailbox(s.id)).toEqual(["keep going"]);
  });

  it("resets a terminal subagent to pending, increments revives and resumes the worker", async () => {
    const s = makeSession("Resumable");
    updateSession(s.id, {
      status: "completed",
      report: { summary: "old", findings: [], conclusion: "old" },
      error: "Subagent did not produce a final answer.",
      completedAt: Date.now(),
    });
    markSubagentReportDelivered(USER, CONV, s.id);
    expect(isSubagentReportDelivered(USER, CONV, s.id)).toBe(true);

    const result = reviveSubagent(USER, s.id, "continue please");
    expect(result.ok).toBe(true);
    expect(result.status).toBe("resumed");

    const session = internalGet(s.id)!;
    expect(session.revives).toBe(1);
    expect(session.report).toBeUndefined();
    expect(session.error).toBeUndefined();
    expect(session.completedAt).toBeUndefined();
    expect(
      session.messages.some((m) => m.role === "user" && m.content.includes("continue please")),
    ).toBe(true);
    expect(isSubagentReportDelivered(USER, CONV, s.id)).toBe(false);
    expect(vi.mocked(updateSession)).toHaveBeenCalledWith(
      s.id,
      expect.objectContaining({ status: "pending", revives: 1 }),
    );

    // The worker re-ran (mocked db → no provider) and finished as failed.
    await vi.waitFor(() => expect(internalGet(s.id)?.status).toBe("failed"));
  });

  it("rejects a 4th revive once the session exhausted its 3 attempts", () => {
    const s = makeSession("Spent");
    updateSession(s.id, { status: "completed", revives: 3 });
    const result = reviveSubagent(USER, s.id, "again");
    expect(result.ok).toBe(false);
    expect(result.status).toBe("queued");
    expect(result.error).toMatch(/exhausted its resume attempts/);
    expect(internalGet(s.id)?.status).toBe("completed");
    expect(internalGet(s.id)?.revives).toBe(3);
    expect(drainSubagentMailbox(s.id)).toEqual([]);
  });

  it("rejects unknown subagents", () => {
    const result = reviveSubagent(USER, "sa-does-not-exist", "hello");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not found/i);
  });

  it("rejects subagents owned by another user", () => {
    const s = makeSession("Mine");
    const result = reviveSubagent("someone-else", s.id, "hello");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not found/i);
  });
});
