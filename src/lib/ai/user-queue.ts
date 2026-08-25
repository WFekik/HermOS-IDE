/** In-memory globalThis registry of mid-loop queued user message IDs per conversation. */

interface UserQueueEntry {
  ids: string[];
  /** Last write time — swept after QUEUE_TTL_MS to avoid leaks on idle/deleted conversations. */
  ts: number;
}

interface UserQueueState {
  /** conversationKey -> ordered list of queued user-message ids. */
  queued: Map<string, UserQueueEntry>;
}

const MAX_QUEUED_USER_TURNS = 20;
const QUEUE_TTL_MS = 10 * 60 * 1000;

const g = globalThis as typeof globalThis & {
  __userQueue?: UserQueueState;
};
if (!g.__userQueue) {
  g.__userQueue = { queued: new Map() };
}
const state = g.__userQueue;

function queueKey(userId: string, conversationId: string): string {
  return `${userId}:${conversationId}`;
}

function sweepExpired(now: number): void {
  for (const [key, entry] of state.queued) {
    if (now - entry.ts > QUEUE_TTL_MS) state.queued.delete(key);
  }
}

/** Record a queued user turn after DB commit for mid-loop ingestion. */
export function enqueueUserTurn(userId: string, conversationId: string, messageId: string): void {
  sweepExpired(Date.now());
  const key = queueKey(userId, conversationId);
  const entry = state.queued.get(key);
  const list = entry ? [...entry.ids, messageId] : [messageId];
  if (list.length > MAX_QUEUED_USER_TURNS) {
    list.shift();
  }
  state.queued.set(key, { ids: list, ts: Date.now() });
}

/**
 * Drain and return every currently-queued user turn id for a conversation.
 * Empty when nothing is pending.
 */
export function takeQueuedUserTurns(userId: string, conversationId: string): string[] {
  sweepExpired(Date.now());
  const key = queueKey(userId, conversationId);
  const entry = state.queued.get(key);
  if (!entry || entry.ids.length === 0) return [];
  state.queued.delete(key);
  return entry.ids;
}

/** Drop queue bookkeeping for a conversation (delete/reset/run teardown). */
export function clearQueuedUserTurns(userId: string, conversationId: string): void {
  state.queued.delete(queueKey(userId, conversationId));
}