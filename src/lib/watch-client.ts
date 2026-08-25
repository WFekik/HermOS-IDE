"use client";

// Multiplexed singleton client for the `/api/workspace/watch` SSE endpoint.
//
// Browsers cap concurrent EventSource connections per host (~6 over
// HTTP/1.1). Historically every open file tab (and the workspace panel)
// opened its own EventSource, so a handful of tabs silently starved that
// pool and watching broke. This module owns exactly ONE EventSource per
// distinct watch URL and fans frames out to every subscriber:
//
//   - `subscribeWatch(url, onEvent, onStatus?)` registers a listener and
//     bumps a refcount. Identical URLs share a single connection.
//   - When the last subscriber unsubscribes, the connection and its
//     timers are torn down.
//   - An 8-second open watchdog guards every connection attempt: if
//     `onopen` hasn't fired within 8s, assume the endpoint 404'd or the
//     connection is hung on a slow network. The source is closed,
//     subscribers are marked disconnected, and a reconnect is scheduled
//     with exponential backoff (reset on success), so transient drops
//     recover automatically for ALL subscribers.
//
// Listeners receive the raw `MessageEvent`; each consumer parses frames
// itself, exactly as it did when it owned its private EventSource.

export type WatchEventHandler = (evt: MessageEvent<string>) => void;
export type WatchStatusHandler = (connected: boolean) => void;

/** If `onopen` hasn't fired within 8s of connecting, treat the endpoint as unavailable. */
const OPEN_WATCHDOG_MS = 8000;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

interface WatchEntry {
  source: EventSource | null;
  listeners: Set<WatchEventHandler>;
  statusListeners: Set<WatchStatusHandler>;
  /** Per-handler subscription count so duplicate handler refs refcount safely. */
  handlerCounts: Map<WatchEventHandler, number>;
  refCount: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  watchdogTimer: ReturnType<typeof setTimeout> | null;
  /** Next reconnect delay; doubles on each failure, resets on open. */
  backoffMs: number;
}

const watches = new Map<string, WatchEntry>();

function notifyStatus(entry: WatchEntry, connected: boolean) {
  for (const cb of [...entry.statusListeners]) {
    try {
      cb(connected);
    } catch {}
  }
}

function clearTimers(entry: WatchEntry) {
  if (entry.reconnectTimer) {
    clearTimeout(entry.reconnectTimer);
    entry.reconnectTimer = null;
  }
  if (entry.watchdogTimer) {
    clearTimeout(entry.watchdogTimer);
    entry.watchdogTimer = null;
  }
}

function closeSource(entry: WatchEntry) {
  if (!entry.source) return;
  try {
    entry.source.close();
  } catch {}
  entry.source = null;
}

function scheduleReconnect(url: string, entry: WatchEntry) {
  if (entry.reconnectTimer || entry.refCount <= 0) return;
  const delay = entry.backoffMs;
  entry.backoffMs = Math.min(entry.backoffMs * 2, RECONNECT_MAX_MS);
  entry.reconnectTimer = setTimeout(() => {
    entry.reconnectTimer = null;
    if (entry.refCount > 0 && !entry.source) connect(url, entry);
  }, delay);
}

function connect(url: string, entry: WatchEntry) {
  if (typeof window === "undefined" || typeof EventSource === "undefined") {
    return;
  }
  closeSource(entry);
  let source: EventSource;
  try {
    source = new EventSource(url);
  } catch {
    notifyStatus(entry, false);
    scheduleReconnect(url, entry);
    return;
  }
  entry.source = source;

  // If onopen doesn't fire within 8s, assume the endpoint 404'd or the
  // connection is hung on a slow network. Close the EventSource so we
  // don't leave a dead socket in the browser's per-host pool and retry
  // later with backoff instead of hot-looping.
  entry.watchdogTimer = setTimeout(() => {
    entry.watchdogTimer = null;
    if (entry.source && entry.source.readyState !== EventSource.OPEN) {
      closeSource(entry);
      notifyStatus(entry, false);
      scheduleReconnect(url, entry);
    }
  }, OPEN_WATCHDOG_MS);

  source.onopen = () => {
    entry.backoffMs = RECONNECT_BASE_MS;
    if (entry.watchdogTimer) {
      clearTimeout(entry.watchdogTimer);
      entry.watchdogTimer = null;
    }
    notifyStatus(entry, true);
  };

  source.onmessage = (ev) => {
    for (const listener of [...entry.listeners]) {
      try {
        listener(ev);
      } catch {}
    }
  };

  source.onerror = () => {
    // Transient errors leave the source CONNECTING and the browser keeps
    // auto-reconnecting on its own — leave subscriber status as-is (the
    // next onopen flips it back). Only once the source reaches CLOSED has
    // the browser given up: tear down and reconnect ourselves with backoff.
    if (entry.source && entry.source.readyState === EventSource.CLOSED) {
      closeSource(entry);
      notifyStatus(entry, false);
      scheduleReconnect(url, entry);
    }
  };
}

/**
 * Subscribe to the SSE stream at `url`. Opens (or reuses) a single shared
 * EventSource per distinct URL and delivers every message frame to all
 * subscribers. `onStatus`, when provided, is invoked as the connection
 * opens/drops so consumers can reflect availability (it fires immediately
 * when joining an already-open connection).
 *
 * Returns an unsubscribe function; the underlying connection closes when
 * the last subscriber for that URL goes away.
 */
export function subscribeWatch(
  url: string,
  onEvent: WatchEventHandler,
  onStatus?: WatchStatusHandler,
): () => void {
  let entry = watches.get(url);
  if (!entry) {
    entry = {
      source: null,
      listeners: new Set(),
      statusListeners: new Set(),
      handlerCounts: new Map(),
      refCount: 0,
      reconnectTimer: null,
      watchdogTimer: null,
      backoffMs: RECONNECT_BASE_MS,
    };
    watches.set(url, entry);
  }
  const joined = entry;
  joined.refCount += 1;
  joined.handlerCounts.set(onEvent, (joined.handlerCounts.get(onEvent) ?? 0) + 1);
  joined.listeners.add(onEvent);
  if (onStatus) joined.statusListeners.add(onStatus);

  if (!joined.source && !joined.reconnectTimer) {
    connect(url, joined);
  } else if (joined.source && joined.source.readyState === EventSource.OPEN) {
    // Late subscriber joining an already-open connection: report the
    // current status immediately (`onopen` won't fire again).
    onStatus?.(true);
  }

  return () => {
    const current = watches.get(url);
    if (!current) return;
    const refs = current.handlerCounts.get(onEvent);
    if (!refs) return;
    if (refs === 1) {
      current.handlerCounts.delete(onEvent);
      current.listeners.delete(onEvent);
      if (onStatus) current.statusListeners.delete(onStatus);
    } else {
      current.handlerCounts.set(onEvent, refs - 1);
    }
    current.refCount -= 1;
    if (current.refCount <= 0) {
      clearTimers(current);
      closeSource(current);
      watches.delete(url);
    }
  };
}
