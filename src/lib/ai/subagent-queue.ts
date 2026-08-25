/**
 * Single delivery pipeline for subagent reports (sa→main) and the mailbox
 * for main→subagent instructions. Owns the per-conversation delivered-set
 * (moved here from subagent-delivery.ts) and the active-run gate.
 */
import {
  getSessions,
  internalGet,
  onSubagentEvicted as registerSessionEviction,
  onSubagentDeleted as registerSessionDeletion,
} from "@/lib/ai/subagent-session";

export interface QueuedReport {
  id: string;
  subagentId: string;
  content: string;
}

const MAX_QUEUED_REPORTS = 50;
const MAX_MAILBOX_SIZE = 20;
const MAX_DELIVERED_REPORTS_KEY = 200;

interface SubagentQueueState {
  reportQueues: Map<string, QueuedReport[]>;
  deliveredReports: Map<string, Set<string>>;
  mailboxes: Map<string, string[]>;
  mailboxOwners: Map<string, string>;
  activeRuns: Set<string>;
}

// globalThis so HMR reloads and warm restarts don't wipe pending queues,
// matching subagent-session.ts's registry.
const g = globalThis as typeof globalThis & {
  __subagentQueue?: SubagentQueueState;
};
if (!g.__subagentQueue) {
  g.__subagentQueue = {
    reportQueues: new Map(),
    deliveredReports: new Map(),
    mailboxes: new Map(),
    mailboxOwners: new Map(),
    activeRuns: new Set(),
  };
}
const state = g.__subagentQueue;

function queueKey(userId: string, conversationId: string): string {
  return `${userId}:${conversationId}`;
}

export function enqueueSubagentReport(
  userId: string,
  conversationId: string,
  subagentId: string,
): void {
  if (isSubagentReportDelivered(userId, conversationId, subagentId)) return;
  const key = queueKey(userId, conversationId);
  let queue = state.reportQueues.get(key);
  if (!queue) {
    queue = [];
    state.reportQueues.set(key, queue);
  }
  queue.push({
    id: `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    subagentId,
    content: buildSubagentReportContent(userId, conversationId, subagentId),
  });
  if (queue.length > MAX_QUEUED_REPORTS) {
    queue.pop();
    console.warn(
      `[subagent-queue] dropped newest queued report for ${key} (cap ${MAX_QUEUED_REPORTS})`,
    );
  }
}

export function drainSubagentReports(
  userId: string,
  conversationId: string,
): QueuedReport[] {
  const key = queueKey(userId, conversationId);
  const queue = state.reportQueues.get(key);
  if (!queue) return [];
  state.reportQueues.delete(key);
  return queue;
}

export function isSubagentReportDelivered(
  userId: string,
  conversationId: string,
  subagentId: string,
): boolean {
  return state.deliveredReports.get(queueKey(userId, conversationId))?.has(subagentId) ?? false;
}

/**
 * Report ids are bucketed per-conversation; LRU eviction drops whole buckets
 * so a delivered id is never removed mid-conversation — only a retired
 * conversation's bucket ages out.
 */
export function markSubagentReportDelivered(
  userId: string,
  conversationId: string,
  subagentId: string,
): void {
  const key = queueKey(userId, conversationId);
  let bucket = state.deliveredReports.get(key);
  if (!bucket) {
    if (state.deliveredReports.size >= MAX_DELIVERED_REPORTS_KEY) {
      const oldestKey = state.deliveredReports.keys().next().value;
      if (oldestKey !== undefined) state.deliveredReports.delete(oldestKey);
    }
    bucket = new Set();
    state.deliveredReports.set(key, bucket);
  }
  bucket.add(subagentId);
}

export function unmarkSubagentReportDelivered(
  userId: string,
  conversationId: string,
  subagentId: string,
): void {
  state.deliveredReports.get(queueKey(userId, conversationId))?.delete(subagentId);
}

export function enqueueSubagentMessage(subagentId: string, content: string): void {
  let box = state.mailboxes.get(subagentId);
  if (!box) {
    box = [];
    state.mailboxes.set(subagentId, box);
    const s = internalGet(subagentId);
    if (s) state.mailboxOwners.set(subagentId, queueKey(s.userId, s.parentConversationId));
  }
  box.push(content);
  if (box.length > MAX_MAILBOX_SIZE) {
    box.shift();
    console.warn(
      `[subagent-queue] dropped oldest message for subagent ${subagentId} (cap ${MAX_MAILBOX_SIZE})`,
    );
  }
}

export function drainSubagentMailbox(subagentId: string): string[] {
  const box = state.mailboxes.get(subagentId);
  if (!box) return [];
  state.mailboxes.delete(subagentId);
  state.mailboxOwners.delete(subagentId);
  return box;
}

export function registerActiveRun(userId: string, conversationId: string): void {
  state.activeRuns.add(queueKey(userId, conversationId));
}

export function unregisterActiveRun(userId: string, conversationId: string): void {
  state.activeRuns.delete(queueKey(userId, conversationId));
}

export function isRunActive(userId: string, conversationId: string): boolean {
  return state.activeRuns.has(queueKey(userId, conversationId));
}

export function clearConversationQueue(userId: string, conversationId: string): void {
  const key = queueKey(userId, conversationId);
  state.reportQueues.delete(key);
  state.deliveredReports.delete(key);
  for (const s of getSessions(userId, conversationId)) {
    state.mailboxes.delete(s.id);
    state.mailboxOwners.delete(s.id);
  }
  for (const [subagentId, owner] of state.mailboxOwners) {
    if (owner === key) {
      state.mailboxes.delete(subagentId);
      state.mailboxOwners.delete(subagentId);
    }
  }
}

export function formatSubagentReportText(report: {
  summary: string;
  findings: Array<{ file?: string; action: string; evidence: string }>;
  conclusion: string;
}): string {
  const parts: string[] = [];
  parts.push(`## Summary\n${report.summary}`);
  if (report.findings.length > 0) {
    parts.push("## Findings");
    for (const f of report.findings) {
      const filePart = f.file ? `\`${f.file}\`` : null;
      parts.push(`- ${[filePart, f.action, `(${f.evidence})`].filter(Boolean).join(" — ")}`);
    }
  } else {
    parts.push("## Findings\n(no tool-verified findings — this subagent produced no evidence-backed claims)");
  }
  parts.push(`## Conclusion\n${report.conclusion}`);
  return parts.join("\n\n");
}

export function buildSubagentReportContent(
  userId: string,
  conversationId: string,
  subagentId: string,
): string {
  void userId;
  void conversationId;
  try {
    const session = internalGet(subagentId);
    const name = session?.name ? escapeName(session.name) : "Subagent";
    if (!session) {
      return `<subagent_report name="${name}" status="failed">\nSubagent was removed before completing.\n</subagent_report>`;
    }
    if (session.status === "failed") {
      return `<subagent_report name="${name}" status="failed">\n${session.error ?? "Subagent failed without an error message."}\n</subagent_report>`;
    }
    if (session.status === "completed" && session.report && session.report.summary) {
      return `<subagent_report name="${name}">\n${formatSubagentReportText(session.report)}\n</subagent_report>`;
    }
    if (session.status === "completed") {
      return `<subagent_report name="${name}">\n(subagent did not produce a final answer${session.error ? ` — ${session.error}` : ""})\n</subagent_report>`;
    }
    return `<subagent_report name="${name}" status="failed">\n${session.error ?? "Subagent failed without an error message."}\n</subagent_report>`;
  } catch {
    return '<subagent_report name="Subagent" status="failed">\nSubagent failed without an error message.\n</subagent_report>';
  }
}

function escapeName(name: string): string {
  return name.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Sweep a deleted session's mailbox so per-session state can't leak for the
// process lifetime (the worker that would have drained it is gone).
registerSessionDeletion((session) => {
  state.mailboxes.delete(session.id);
  state.mailboxOwners.delete(session.id);
});

registerSessionEviction((session) => {
  if (session.status === "failed" && session.error?.startsWith("Evicted")) {
    try {
      enqueueSubagentReport(session.userId, session.parentConversationId, session.id);
    } catch {
      /* never let listener failures propagate */
    }
  }
});