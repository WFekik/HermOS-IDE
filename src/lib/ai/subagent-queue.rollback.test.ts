import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createSession,
  updateSession,
  deleteSession,
} from "@/lib/ai/subagent-session";
import {
  enqueueSubagentReport,
  drainSubagentReports,
  dropQueuedReports,
} from "@/lib/ai/subagent-queue";

const USER = "queue-user";
const CONV = "queue-conv";

describe("subagent report queue — rolled-back workers", () => {
  const created: string[] = [];

  afterEach(() => {
    for (const id of created) deleteSession(USER, id);
    created.length = 0;
    drainSubagentReports(USER, CONV);
  });

  function makeSession(name: string) {
    const session = createSession(USER, CONV, {
      name,
      task: "task",
      systemPrompt: "prompt",
      allowedTools: [],
      provider: "openai",
      model: "gpt-4o",
    });
    created.push(session.id);
    return session;
  }

  beforeEach(() => {
    drainSubagentReports(USER, CONV);
  });

  it("never queues a report for a rolled-back worker", () => {
    const s = makeSession("RolledBack");
    updateSession(s.id, { rolledBack: true });

    enqueueSubagentReport(USER, CONV, s.id);

    expect(drainSubagentReports(USER, CONV)).toEqual([]);
  });

  it("drops queued reports of rolled-back workers", () => {
    const kept = makeSession("Kept");
    const dropped = makeSession("Dropped");
    enqueueSubagentReport(USER, CONV, kept.id);
    enqueueSubagentReport(USER, CONV, dropped.id);

    dropQueuedReports(USER, CONV, [dropped.id]);

    const queued = drainSubagentReports(USER, CONV);
    expect(queued.map((q) => q.subagentId)).toEqual([kept.id]);
  });

  it("still queues reports for workers that survived", () => {
    const kept = makeSession("Kept");
    enqueueSubagentReport(USER, CONV, kept.id);

    expect(drainSubagentReports(USER, CONV).map((q) => q.subagentId)).toEqual([kept.id]);
  });
});
