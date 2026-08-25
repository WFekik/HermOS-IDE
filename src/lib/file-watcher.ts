import fs from "fs";
import path from "path";

/**
 * Recursive per-user filesystem watcher (`fs.watch`) forwarding debounced (100ms) change events to SSE listeners.
 * Filters out ignored directories (.git, node_modules) and handles cleanup on workspace close/error.
 */

export type FileWatchEventKind = "change" | "delete" | "rename";

export interface FileWatchEvent {
  /** Path relative to the workspace root (posix separators). */
  path: string;
  event: FileWatchEventKind;
  timestamp: number;
}

type Listener = (event: FileWatchEvent) => void;

interface WatcherEntry {
  /** Absolute workspace root this watcher is bound to. */
  rootDir: string;
  /** The underlying Node fs.FSWatcher (null once closed). */
  watcher: fs.FSWatcher | null;
  /** Active SSE listeners for this user. */
  listeners: Set<Listener>;
  /** Batch-debounced: accumulate changed paths, flush on single timer. */
  pendingPaths: Map<string, FileWatchEventKind>;
  /** The single flush timer (null when idle). */
  flushTimer: NodeJS.Timeout | null;
}

// Per-user watcher registry. Active workspace watcher is replaced on workspace switch.
const watchers = new Map<string, WatcherEntry>();

const DEBOUNCE_MS = 150;

// Directories ignored during file change events.
const SKIP_DIRS = new Set(["node_modules", ".git", ".checkpoints", ".next", ".next-build", "dist", "build", ".turbo", ".cache", "coverage", ".eslintcache", ".gemini", "vendor", "out", "target", "tmp", "temp"]);

/** Converts absolute workspace path to posix relative path. Returns null if outside root. */
function toRel(rootDir: string, abs: string): string | null {
  let rel = path.relative(rootDir, abs);
  if (rel === "" || rel === ".") return ".";
  // path.relative uses platform separators; normalize to posix for the wire.
  rel = rel.split(path.sep).join("/");
  if (rel.startsWith("../") || rel === "..") return null; // escaped root
  return rel;
}

/** Checks if a relative path falls within a skipped directory. */
function isSkipped(rel: string): boolean {
  if (rel === ".") return false;
  const segs = rel.split("/");
  for (const seg of segs) {
    if (SKIP_DIRS.has(seg)) return true;
  }
  return false;
}

/** Resolves event kind from raw fs.watch event, probing fs to disambiguate renames/deletions. */
function resolveKind(abs: string, rawType: string): FileWatchEventKind {
  if (rawType === "change") return "change";
  try {
    // Stat to distinguish create/rename from deletion.
    fs.statSync(abs);
    return "rename";
  } catch {
    return "delete";
  }
}

/** Creates and wires an fs.FSWatcher with debouncing, filtering, and error handling. */
function createWatcher(userId: string, entry: WatcherEntry): fs.FSWatcher | null {
  let watcher: fs.FSWatcher;
  try {
    // Recursive watch descriptor across supported platforms.
    watcher = fs.watch(entry.rootDir, { recursive: true });
  } catch (err) {
    // Notify listeners of root deletion on access or permission error.
    const msg = err instanceof Error ? err.message : "watch failed";
    console.error(`[file-watcher] could not watch ${entry.rootDir}:`, msg);
    notifyListeners(entry, {
      path: ".",
      event: "delete",
      timestamp: Date.now(),
    });
    return null;
  }

  watcher.on("change", (eventType, filename) => {
    // filename can be Buffer (when the path contains non-UTF8 bytes) or string.
    if (!filename) return;
    const name = typeof filename === "string" ? filename : filename.toString("utf8");
    if (!name) return;

    const abs = path.join(entry.rootDir, name);
    const rel = toRel(entry.rootDir, abs);
    if (!rel) return; // outside root — ignore
    if (isSkipped(rel)) return;

    // Accumulate changed paths and resolve kind on debounce flush.
    const rawKind: FileWatchEventKind = eventType === "change" ? "change" : "rename";
    entry.pendingPaths.set(rel, rawKind);

    if (entry.flushTimer) clearTimeout(entry.flushTimer);
    entry.flushTimer = setTimeout(() => {
      entry.flushTimer = null;
      const batch = new Map(entry.pendingPaths);
      entry.pendingPaths.clear();
      const now = Date.now();
      for (const [p, rawK] of batch) {
        const absPath = path.join(entry.rootDir, p);
        const kind = resolveKind(absPath, rawK);
        notifyListeners(entry, { path: p, event: kind, timestamp: now });
      }
    }, DEBOUNCE_MS);
  });

  watcher.on("error", (err) => {
    // Handle watcher failure by resetting entry and notifying listeners.
    const msg = err instanceof Error ? err.message : "watcher error";
    console.error(`[file-watcher] watcher error for ${entry.rootDir}:`, msg);
    try {
      watcher.close();
    } catch {
      /* already closed */
    }
    entry.watcher = null;
    notifyListeners(entry, {
      path: ".",
      event: "delete",
      timestamp: Date.now(),
    });
  });

  return watcher;
}

function notifyListeners(entry: WatcherEntry, event: FileWatchEvent): void {
  for (const listener of entry.listeners) {
    try {
      listener(event);
    } catch (e) {
      // A listener throwing must not break the others.
      console.error("[file-watcher] listener threw:", e);
    }
  }
}

/**
 * Subscribes to debounced file change events for a user workspace, lazily creating the watcher.
 * @returns Unsubscribe cleanup callback.
 */
export function subscribeToFileWatch(
  userId: string,
  workspaceRoot: string,
  callback: Listener,
): () => void {
  let entry = watchers.get(userId);

  // Close existing watcher if workspace root changed.
  if (entry && entry.rootDir !== workspaceRoot) {
    closeWatcher(entry);
    watchers.delete(userId);
    entry = undefined;
  }

  if (!entry) {
    entry = {
      rootDir: workspaceRoot,
      watcher: null,
      listeners: new Set(),
      pendingPaths: new Map(),
      flushTimer: null,
    };
    watchers.set(userId, entry);
    entry.watcher = createWatcher(userId, entry);
  } else if (!entry.watcher) {
    // Re-create closed watcher if listeners are still present.
    entry.watcher = createWatcher(userId, entry);
  }

  entry.listeners.add(callback);

  return () => {
    const e = watchers.get(userId);
    if (!e) return;
    e.listeners.delete(callback);
    // Stop watcher when last listener unsubscribes.
    if (e.listeners.size === 0) {
      stopFileWatch(userId);
    }
  };
}

/** Closes user's file watcher, clears debounce timers, and cleans up registry entry. */
export function stopFileWatch(userId: string): void {
  const entry = watchers.get(userId);
  if (!entry) return;
  closeWatcher(entry);
  watchers.delete(userId);
}

function closeWatcher(entry: WatcherEntry): void {
  if (entry.flushTimer) {
    clearTimeout(entry.flushTimer);
    entry.flushTimer = null;
  }
  entry.pendingPaths.clear();
  if (entry.watcher) {
    try {
      entry.watcher.close();
    } catch {
      /* already closed */
    }
    entry.watcher = null;
  }
  entry.listeners.clear();
}
