/**
 * Non-blocking background subagent report delivery:
 * Watches subagent sessions, writes terminal reports to DB, and fires auto-wake events upon completion.
 */
import { db } from "@/lib/db";
import {
  subscribeSubagentUpdates,
  publishSubagentWake,
  internalGet,
} from "@/lib/ai/subagent-session";
import {
  isSubagentReportDelivered,
  markSubagentReportDelivered,
  unmarkSubagentReportDelivered,
  buildSubagentReportContent,
  isRunActive,
  clearConversationQueue,
} from "@/lib/ai/subagent-queue";

// Re-export so callers compile unchanged. `clearConversationQueue` is not
// re-exported — routes keep calling `clearConversationDelivery`, which delegates.
export { isSubagentReportDelivered, markSubagentReportDelivered } from "./subagent-queue";

interface DeliveryEntry {
  userId: string;
  conversationId: string;
  /** Subagent ids still awaiting terminal status. */
  pending: Set<string>;
  /** Subagent ids whose report has already been posted to the DB. */
  delivered: Set<string>;
  /** Unsubscribe fn for the conversation's update subscription. */
  unsub?: () => void;
}

const g = globalThis as typeof globalThis & {
  __subagentDeferredDelivery?: Map<string, DeliveryEntry>;
  /** Ephemeral server-side grant that authorizes ONE autoWake chat run for a
   *  conversation (idempotent rate-limit bypass; consumed by the chat route). */
  __subagentWakeGrants?: Map<string, number>;
};
if (!g.__subagentDeferredDelivery) g.__subagentDeferredDelivery = new Map();
const registry = g.__subagentDeferredDelivery;
if (!g.__subagentWakeGrants) g.__subagentWakeGrants = new Map();
const wakeGrants = g.__subagentWakeGrants;

/** Bounded registry size — prevents unbounded memory growth across many conversations. */
const MAX_DELIVERY_CONVERSATIONS = 200;
/** How long a delivered wake remains authorized for auto-synthesize. */
const WAKE_GRANT_TTL_MS = 10 * 60_000;

function keyFor(userId: string, conversationId: string): string {
  return `${userId}:${conversationId}`;
}

/**
 * Hand off pending subagents to the background delivery watcher. Fire and
 * forget — never blocks the caller (the main executor loop). Subagents
 * already delivered in a previous cycle are skipped, so re-deferring a
 * conversation is idempotent.
 */
export function deferSubagentDelivery(
  userId: string,
  conversationId: string,
  subagentIds: string[],
): void {
  const key = keyFor(userId, conversationId);
  let entry = registry.get(key);
  if (!entry) {
    if (registry.size >= MAX_DELIVERY_CONVERSATIONS) {
      // Evict the oldest entry that has nothing left to deliver (or any
      // entry as a last resort) to keep memory bounded.
      for (const [k, e] of registry) {
        if (e.pending.size === 0) {
          e.unsub?.();
          registry.delete(k);
          break;
        }
      }
      if (registry.size >= MAX_DELIVERY_CONVERSATIONS) {
        const oldestKey = registry.keys().next().value;
        if (oldestKey !== undefined) {
          const oldest = registry.get(oldestKey);
          oldest?.unsub?.();
          registry.delete(oldestKey);
        }
      }
    }
    entry = {
      userId,
      conversationId,
      pending: new Set(),
      delivered: new Set(),
    };
    entry.unsub = subscribeSubagentUpdates(userId, conversationId, () => {
      maybeDeliver(entry!);
    });
    registry.set(key, entry);
  }

  for (const id of subagentIds) {
    // Entry-local `delivered` bookkeeping can go stale when a subagent is
    // revived: the revive path clears the GLOBAL delivered-marker so its NEXT
    // report can be enqueued again, but this entry may still hold the id in
    // its `delivered` set from a previous cycle — leaving it out of `pending`
    // strands that second report (never posted by the watcher, no wake).
    // Re-pend whenever the global marker is unset.
    if (isSubagentReportDelivered(entry.userId, entry.conversationId, id)) {
      entry.delivered.add(id);
      entry.pending.delete(id);
    } else {
      entry.delivered.delete(id);
      entry.pending.add(id);
    }
  }

  // Subagents may already be terminal when deferred — deliver immediately.
  maybeDeliver(entry);
}

/**
 * Post reports for any deferred subagent that has reached a terminal
 * status. When the last one is delivered, publish the wake event and
 * release the subscription.
 */
function maybeDeliver(entry: DeliveryEntry): void {
  if (entry.pending.size === 0) return;

  const terminal: string[] = [];
  for (const id of entry.pending) {
    const session = internalGet(id);
    if (!session) {
      // Session was evicted/removed before finishing — deliver a failure
      // note so the pending set always drains and the wake still fires.
      terminal.push(id);
      continue;
    }
    if (session.status === "completed" || session.status === "failed") {
      terminal.push(id);
    }
  }
  if (terminal.length === 0) return;

  const writes: Promise<void>[] = [];
  for (const id of terminal) {
    entry.pending.delete(id);
    entry.delivered.add(id);
    // A live executor run owns delivery (its iteration-end/break/finally
    // drains persist + mark every enqueued report), so never post during a
    // run — the drain would create the SAME row a second time. The report
    // was already enqueued by the terminal transition; the run's drains are
    // guaranteed to reach it (break + finally cover every exit path).
    if (isRunActive(entry.userId, entry.conversationId)) continue;
    // A live executor queue drain may have delivered this report first —
    // never double-post; just sync the local bookkeeping.
    if (isSubagentReportDelivered(entry.userId, entry.conversationId, id)) continue;
    writes.push(postReport(entry, id));
  }

  if (entry.pending.size === 0) {
    entry.unsub?.();
    entry.unsub = undefined;
    registry.delete(keyFor(entry.userId, entry.conversationId));
    // Deliver (fire) the wake only after all report writes have committed,
    // so the autoWake run that the wake triggers reads the reports back. The
    // grant that authorizes the sentinel (and replays a missed wake on SSE
    // reconnect) is issued in the same settlement tick, so neither the live
    // event nor a replay can race ahead of the persisted reports.
    void Promise.allSettled(writes).then(() => {
      // A live main-agent loop drains the report queue itself; skip the wake
      // so a concurrent autoWake sentinel can't duplicate the final answer.
      if (isRunActive(entry.userId, entry.conversationId)) return;
      grantAndPublishWake(entry.userId, entry.conversationId);
    });
  }
}

/**
 * Server-side one-time authorization for an internal wake chat run. Returns true
 * the first time it's called for a fresh delivered grant (within TTL) and the
 * grant is discarded; subsequent autoWake requests for the same conversation
 * are rate-limited normally. This closes the "client can set autoWake=true to
 * bypass rate limits" hole.
 */
export function consumeWakeGrant(userId: string, conversationId: string): boolean {
  const key = keyFor(userId, conversationId);
  const expiry = wakeGrants.get(key);
  if (expiry === undefined) return false;
  wakeGrants.delete(key);
  return Date.now() < expiry;
}

/**
 * Non-consuming check — true while a delivered wake is still authorized but not
 * yet consumed. The subagents SSE route re-emits a `wake` event when a client
 * (re)connects, so a missed wake (user switched conversations / tab refreshed)
 * is replayed instead of being dropped permanently.
 */
export function hasPendingWakeGrant(userId: string, conversationId: string): boolean {
  const key = keyFor(userId, conversationId);
  const expiry = wakeGrants.get(key);
  if (expiry === undefined) return false;
  const alive = Date.now() < expiry;
  if (!alive) wakeGrants.delete(key); // sweep expired grants so the map doesn't grow
  return alive;
}

/** Drop any pending wake authorization (conversation delete/reset). */
export function clearAllWakeGrants(userId: string, conversationId: string): void {
  wakeGrants.delete(keyFor(userId, conversationId));
}

/**
 * Issue a fresh wake grant + publish the wake event. Used when the executor
 * drained reports the model never reasoned over (break/finally drains) and by
 * maybeDeliver once every deferred report is posted. The wakeGrants map stays
 * bounded via sweepExpiredWakeGrants.
 */
export function grantAndPublishWake(userId: string, conversationId: string): void {
  // Refresh the grant on EVERY settlement instead of coalescing. Grants are
  // keyed per-conversation (a map `set` can never stack), the chat route
  // consumes exactly one per autoWake run (a second request gets the noop
  // stream), and the client's launchAutoWake single-flight absorbs redundant
  // events (e.g. executor teardown + watcher settlement racing in the same
  // tick). An early return here would strand a SECOND delivery cycle that
  // lands while an unconsumed grant is still alive: no fresh wake event is
  // published AND the grant window is not extended, so a client that
  // reconnects after the old grant expires never synthesizes the newer
  // reports. Refreshing the TTL from the LAST settlement instead keeps the
  // replay window covering every undelivered batch.
  sweepExpiredWakeGrants();
  wakeGrants.set(keyFor(userId, conversationId), Date.now() + WAKE_GRANT_TTL_MS);
  try {
    publishSubagentWake(userId, conversationId);
  } catch {
    /* ignore publisher errors */
  }
}

/**
 * Re-run maybeDeliver for a conversation's deferred entries. The executor
 * calls this after releasing the active-run gate (unregisterActiveRun) so a
 * report that completed mid-run but never made it into the queue (e.g. it
 * fell in the gap between a run's final drain and its unregister) is still
 * posted + waked normally instead of lingering in the entry.
 */
export function recheckDeferredDelivery(userId: string, conversationId: string): void {
  const entry = registry.get(keyFor(userId, conversationId));
  if (entry) maybeDeliver(entry);
}

/**
 * Evict expired wake grants (LRU-ish sweep). Called opportunistically whenever
 * a new grant is issued so the map stays bounded even when a client never
 * consumes/replays a grant (e.g. the tab that triggered delivery was closed).
 */
function sweepExpiredWakeGrants(): void {
  const now = Date.now();
  for (const [key, expiry] of wakeGrants) {
    if (expiry <= now) wakeGrants.delete(key);
  }
}

/** Post a single subagent's report as a user-role message in the conversation. */
async function postReport(entry: DeliveryEntry, subagentId: string): Promise<void> {
  // Claim BEFORE the awaited create — the main-run drain gates its posts on
  // this mark, so claiming first closes the double-post TOCTOU. Unmark on
  // failure so a later drain/watcher pass can retry.
  markSubagentReportDelivered(entry.userId, entry.conversationId, subagentId);
  try {
    const session = internalGet(subagentId);
    await db.message.create({
      data: {
        conversationId: entry.conversationId,
        role: "user",
        content: buildSubagentReportContent(entry.userId, entry.conversationId, subagentId),
        // Anchor to the session's real completion time (fallback: post time)
        // so the report row lands in its chronological place among the user's
        // own turns rather than at whatever moment the watcher posted it.
        ...(session?.completedAt ? { createdAt: new Date(session.completedAt) } : {}),
      },
    });
  } catch {
    unmarkSubagentReportDelivered(entry.userId, entry.conversationId, subagentId);
    /* best-effort — never crash the background watcher */
  }
}

/** Drop delivery tracking + queue bookkeeping for a conversation (delete/reset). */
export function clearConversationDelivery(
  userId: string,
  conversationId: string,
): void {
  const key = keyFor(userId, conversationId);
  const entry = registry.get(key);
  if (entry) {
    entry.unsub?.();
    registry.delete(key);
  }
  clearConversationQueue(userId, conversationId);
  clearAllWakeGrants(userId, conversationId);
}