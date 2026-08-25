export type SubagentStatus =
  | "pending"
  | "running"
  | "thinking"
  | "tool_exec"
  | "completing"
  | "completed"
  | "failed";

export interface SubagentSessionMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  thinking?: string;
  toolCallId?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
}

/** Live token-streamed partial turn before durable commit via `appendMessage`. */
export interface SubagentPartial {
  content: string;
  thinking?: string;
}

export interface SubagentSession {
  id: string;
  parentConversationId: string;
  userId: string;
  name: string;
  task: string;
  systemPrompt: string;
  allowedTools: string[];
  status: SubagentStatus;
  messages: SubagentSessionMessage[];
  progressLog: string[];
  report?: SubagentReport;
  error?: string;
  revives: number;
  partial?: SubagentPartial;
  createdAt: number;
  completedAt?: number;
  provider: string;
  model: string;
  checkpointId?: string;
  thinkingLevel?: string;
  formattedResultCache?: { messageCount: number; text: string | undefined };
}

export interface SubagentReport {
  summary: string;
  findings: Array<{ file?: string; action: string; evidence: string }>;
  conclusion: string;
}

// Persist registry on globalThis across Next.js HMR reloads and warm restarts.
const g = globalThis as typeof globalThis & {
  __subagentRegistry?: Map<string, SubagentSession>;
  __subagentEvictionCbs?: Set<(session: SubagentSession) => void>;
  __subagentDeletionCbs?: Set<(session: SubagentSession) => void>;
};
if (!g.__subagentRegistry) g.__subagentRegistry = new Map<string, SubagentSession>();
const registry = g.__subagentRegistry;
const MAX_PER_CONVERSATION = 10;
const SESSION_TTL_MS = 3_600_000;

function genId(): string {
  return `sa-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Listener sets live on globalThis too: an HMR reload of a dependent module
// (e.g. subagent-queue.ts) must not double-register against a surviving set.
if (!g.__subagentEvictionCbs) g.__subagentEvictionCbs = new Set();
if (!g.__subagentDeletionCbs) g.__subagentDeletionCbs = new Set();
const evictedCbs = g.__subagentEvictionCbs;
const deletedCbs = g.__subagentDeletionCbs;

export function onSubagentEvicted(listener: (session: SubagentSession) => void): () => void {
  evictedCbs.add(listener);
  return () => {
    evictedCbs.delete(listener);
  };
}

export function onSubagentDeleted(listener: (session: SubagentSession) => void): () => void {
  deletedCbs.add(listener);
  return () => {
    deletedCbs.delete(listener);
  };
}

function notifyEvicted(session: SubagentSession): void {
  for (const fn of evictedCbs) {
    try { fn(session); } catch { /* ignore listener errors */ }
  }
}

function notifyDeleted(session: SubagentSession): void {
  for (const fn of deletedCbs) {
    try { fn(session); } catch { /* ignore listener errors */ }
  }
}

export function createSession(
  userId: string,
  conversationId: string,
  opts: {
    name: string;
    task: string;
    systemPrompt: string;
    allowedTools: string[];
    provider: string;
    model: string;
    checkpointId?: string;
    thinkingLevel?: string;
  },
): SubagentSession {
  const existing = listSessionsByConversation(conversationId);
  if (existing.length >= MAX_PER_CONVERSATION) {
    // Sort terminal sessions (completed/failed) first, then by createdAt ascending (oldest first)
    existing.sort((a, b) => {
      const isTerminalA = a.status === "completed" || a.status === "failed";
      const isTerminalB = b.status === "completed" || b.status === "failed";
      if (isTerminalA !== isTerminalB) return isTerminalA ? -1 : 1;
      return a.createdAt - b.createdAt;
    });
    for (let i = 0; i < existing.length - MAX_PER_CONVERSATION + 1; i++) {
      const evicted = existing[i];
      // Mark as failed BEFORE deleting so any awaitSubagents() polling this session
      // sees a terminal state and resolves its promise instead of hanging forever.
      if (evicted.status !== "completed" && evicted.status !== "failed") {
        evicted.status = "failed";
        evicted.error = "Evicted: session cap reached";
      }
      notifyEvicted(evicted);
      publish(evicted.id, evicted.userId, conversationId);
      registry.delete(evicted.id);
    }
  }

  const now = Date.now();
  const session: SubagentSession = {
    id: genId(),
    parentConversationId: conversationId,
    userId,
    name: opts.name.slice(0, 120),
    task: opts.task.slice(0, 32_000),
    systemPrompt: opts.systemPrompt.slice(0, 16_000),
    allowedTools: opts.allowedTools,
    status: "pending",
    messages: [],
    progressLog: [],
    revives: 0,
    createdAt: now,
    provider: opts.provider,
    model: opts.model,
    checkpointId: opts.checkpointId,
    thinkingLevel: opts.thinkingLevel,
  };
  registry.set(session.id, session);
  return session;
}

/**
 * Public, ACL-checked lookup. Returns null if the session doesn't
 * exist or doesn't belong to `userId`.
 */
export function getSession(userId: string, id: string): SubagentSession | null {
  const s = registry.get(id);
  if (!s || s.userId !== userId) return null;
  return s;
}

/**
 * Internal lookup that bypasses the per-user ACL check. Used by the
 * subagent worker (which is operating on a session it created and
 * already knows the userId of) and by `awaitSubagents` which also
 * already filters by userId after retrieval.
 */
export function internalGet(id: string): SubagentSession | null {
  return registry.get(id) ?? null;
}

export function getSessions(
  userId: string,
  conversationId: string,
): SubagentSession[] {
  return listSessionsByConversation(conversationId)
    .filter((s) => s.userId === userId)
    .sort((a, b) => b.createdAt - a.createdAt);
}

type SubagentSubscriber = (sessionId: string) => void;
const subs = new Map<string, Set<SubagentSubscriber>>(); // key: `userId:conversationId`

function subKey(userId: string, conversationId: string): string {
  return `${userId}:${conversationId}`;
}

/** Subscribe to subagent updates for a conversation. Returns an unsubscribe function. */
export function subscribeSubagentUpdates(
  userId: string,
  conversationId: string,
  listener: SubagentSubscriber,
): () => void {
  const key = subKey(userId, conversationId);
  if (!subs.has(key)) subs.set(key, new Set());
  subs.get(key)!.add(listener);
  return () => {
    const set = subs.get(key);
    if (set) {
      set.delete(listener);
      if (set.size === 0) subs.delete(key);
    }
  };
}

function publish(sessionId: string, userId: string, conversationId: string): void {
  const key = subKey(userId, conversationId);
  const set = subs.get(key);
  if (set) {
    for (const fn of set) {
      try { fn(sessionId); } catch { /* ignore subscriber errors */ }
    }
  }
}

export function updateSession(id: string, patch: Partial<SubagentSession>): void {
  const s = registry.get(id);
  if (!s) return;
  // Strip id to prevent accidental clobber.
  const { id: _ignored, ...rest } = patch as Partial<SubagentSession> & { id?: string };
  void _ignored;
  Object.assign(s, rest);
  publish(id, s.userId, s.parentConversationId);
}

export function appendProgress(id: string, entry: string): void {
  const s = registry.get(id);
  if (!s) return;
  s.progressLog.push(entry);
  publish(id, s.userId, s.parentConversationId);
}

export function appendMessage(id: string, msg: SubagentSessionMessage): void {
  const s = registry.get(id);
  if (!s) return;
  s.messages.push(msg);
  publish(id, s.userId, s.parentConversationId);
}

/**
 * Dedicated subscriber channel for token-level partial updates. Kept separate
 * from the full-snapshot `subscribeSubagentUpdates` so the executor can push
 * a partial every content chunk WITHOUT forcing the SSE endpoint to re-serialize
 * the entire subagent history each tick.
 */
type PartialSubscriber = (sessionId: string) => void;
const partialSubs = new Map<string, Set<PartialSubscriber>>();

/** Subscribe to live partial-stream updates for a conversation. */
export function subscribeSubagentPartials(
  userId: string,
  conversationId: string,
  listener: PartialSubscriber,
): () => void {
  const key = subKey(userId, conversationId);
  if (!partialSubs.has(key)) partialSubs.set(key, new Set());
  partialSubs.get(key)!.add(listener);
  return () => {
    const set = partialSubs.get(key);
    if (set) {
      set.delete(listener);
      if (set.size === 0) partialSubs.delete(key);
    }
  };
}

function publishPartial(sessionId: string, userId: string, conversationId: string): void {
  const key = subKey(userId, conversationId);
  const set = partialSubs.get(key);
  if (set) {
    for (const fn of set) {
      try { fn(sessionId); } catch { /* ignore subscriber errors */ }
    }
  }
}

/**
 * Publish the evolving draft of the subagent's current turn. Content is passed
 * cleaned (tool-call blocks already stripped) so the panel shows flowing prose
 * instead of raw DSML artifacts mid-generation.
 */
export function streamSubagentPartial(id: string, content: string, thinking?: string): void {
  const s = registry.get(id);
  if (!s) return;
  s.partial = { content, thinking: thinking?.trim() ? thinking : undefined };
  publishPartial(id, s.userId, s.parentConversationId);
}

/**
 * Dedicated subscriber channel for the "wake" event: emitted once every deferred
 * subagent for a conversation has been delivered to the main conversation. The
 * frontend listens on the subagents SSE route and responds by launching the
 * sentinel `autoWake` chat run that synthesizes the final answer.
 */
type WakeSubscriber = () => void;
const wakeSubs = new Map<string, Set<WakeSubscriber>>();

/** Subscribe to wake events for a conversation (e.g. the SSE route). */
export function subscribeSubagentWake(
  userId: string,
  conversationId: string,
  listener: WakeSubscriber,
): () => void {
  const key = subKey(userId, conversationId);
  if (!wakeSubs.has(key)) wakeSubs.set(key, new Set());
  wakeSubs.get(key)!.add(listener);
  return () => {
    const set = wakeSubs.get(key);
    if (set) {
      set.delete(listener);
      if (set.size === 0) wakeSubs.delete(key);
    }
  };
}

export function publishSubagentWake(userId: string, conversationId: string): void {
  const key = subKey(userId, conversationId);
  const set = wakeSubs.get(key);
  if (set) {
    for (const fn of set) {
      try { fn(); } catch { /* ignore subscriber errors */ }
    }
  }
}

/** Drop the live draft when the turn is committed to `messages`. */
export function clearSubagentPartial(id: string): void {
  const s = registry.get(id);
  if (!s || !s.partial) return;
  s.partial = undefined;
  publish(id, s.userId, s.parentConversationId);
}

export function deleteSession(userId: string, id: string): boolean {
  const s = registry.get(id);
  if (!s || s.userId !== userId) return false;
  const deleted = registry.delete(id);
  if (deleted) {
    abortSession(id);
    notifyDeleted(s);
    publish(id, userId, s.parentConversationId);
  }
  return deleted;
}

/**
 * Abort controllers for in-flight subagent workers. Kept OUTSIDE the session
 * object so sessions stay plain-serializable (the registry is served to the
 * frontend). Aborting lets long tool waits (e.g. a blocking `run_command`)
 * resolve immediately when the session is deleted instead of stalling until
 * their full timeout window elapses.
 */
const sessionAborts = new Map<string, AbortController>();

export function registerSessionAbort(id: string, controller: AbortController): void {
  sessionAborts.set(id, controller);
}

export function unregisterSessionAbort(id: string, controller: AbortController): void {
  // Only unregister OUR controller — a revive may have registered a newer
  // worker's controller under the same id; deleting it blindly would orphan
  // that worker's abort (deletion could never cancel its tool waits).
  if (sessionAborts.get(id) === controller) sessionAborts.delete(id);
}

export function abortSession(id: string): void {
  const c = sessionAborts.get(id);
  if (c) c.abort();
  sessionAborts.delete(id);
}

/** Remove all subagent sessions and SSE subscribers for a conversation. */
export function clearConversationSubagents(userId: string, conversationId: string): void {
  const key = subKey(userId, conversationId);
  subs.delete(key);
  for (const [id, s] of registry) {
    if (s.parentConversationId === conversationId && s.userId === userId) {
      abortSession(id);
      registry.delete(id);
    }
  }
}

function listSessionsByConversation(conversationId: string): SubagentSession[] {
  const out: SubagentSession[] = [];
  for (const s of registry.values()) {
    if (s.parentConversationId === conversationId) out.push(s);
  }
  return out;
}

setInterval(() => {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, s] of registry) {
    if (s.completedAt && s.completedAt < cutoff) {
      notifyDeleted(s);
      registry.delete(id);
    }
  }
}, 300_000).unref();
