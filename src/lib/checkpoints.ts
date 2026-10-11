import path from "path";
import fs from "fs/promises";
import { existsSync } from "fs";
import { createHash } from "crypto";
import { db } from "@/lib/db";
import { CHECKPOINTS_DIR } from "@/lib/paths";
import { computeDiff } from "@/lib/diff";

/**
 * Checkpoints store per-file pre-edit snapshots under `<CHECKPOINTS_DIR>/<userId>/<convId>/<chkId>/`.
 * Tracks modified files in manifest.json with an auto-pruning cap of 20 checkpoints per conversation.
 */

const MAX_CHECKPOINTS_PER_CONV = 20;

export interface CheckpointInfo {
  id: string;
  label: string | null;
  createdAt: string;
  fileCount: number;
  conversationId: string;
}

interface Manifest {
  files: Record<string, number>;
  /** sha1 hex per absolute path, written for new checkpoints; verified on restore when present. */
  hashes?: Record<string, string>;
  newFiles?: string[];
  newDirs?: string[];
}

/** sha1 hex of file bytes (used for confirm-plan verification). */
export function sha1Hex(data: Buffer | string): string {
  return createHash("sha1").update(data).digest("hex");
}

/** Current on-disk hash of a file, or null when missing/unreadable. */
export async function hashFileOnDisk(absPath: string): Promise<string | null> {
  try {
    return sha1Hex(await fs.readFile(absPath));
  } catch {
    return null;
  }
}

/**
 * Containment gate: restore/delete targets must resolve inside the
 * conversation's CURRENT workspace root. Manifests record absolute paths
 * from edit time; after a workspace switch/move those go stale, and without
 * this gate undo would write to (or rmdir above) the wrong location while
 * reporting success.
 */
function assertInsideWorkspace(rootDir: string, p: string): void {
  const root = path.resolve(rootDir);
  const target = path.resolve(p);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(`Refusing undo outside the workspace: ${p}`);
  }
}

const manifestLocks = new Map<string, Promise<unknown>>();

/**
 * Per-conversation undo lock (same-process, in-memory). The DELETE handler
 * holds it across hash-verify → restore → transcript delete so a racing tool
 * write or a second concurrent undo cannot land inside that window and get
 * silently clobbered (or silently clobber the restore). Tool write paths
 * check `isUndoLocked` immediately before writing and fail fast instead.
 * Best-effort like all in-memory guards: a server restart clears it (a
 * restart also kills in-flight restores, so nothing is left half-held).
 */
const undoLocks = new Set<string>();

export function tryAcquireUndoLock(conversationId: string): boolean {
  if (!conversationId || undoLocks.has(conversationId)) return false;
  undoLocks.add(conversationId);
  return true;
}

export function releaseUndoLock(conversationId: string): void {
  undoLocks.delete(conversationId);
}

export function isUndoLocked(conversationId: string): boolean {
  return undoLocks.has(conversationId);
}

async function withManifestLock<T>(
  userId: string,
  conversationId: string,
  checkpointId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = `${userId}:${conversationId}:${checkpointId}`;
  const prev = manifestLocks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  manifestLocks.set(key, tail);
  void tail.then(() => {
    if (manifestLocks.get(key) === tail) manifestLocks.delete(key);
  });
  return run;
}

async function removeEmptyParentDirs(startPath: string, stopAt?: string): Promise<void> {
  const stop = stopAt ? path.resolve(stopAt) : null;
  let current = path.dirname(startPath);
  while (current && current.length > 3) {
    // Never climb above the workspace root.
    if (stop && (current === stop || !current.startsWith(stop + path.sep))) break;
    try {
      const files = await fs.readdir(current);
      if (files.length === 0) {
        await fs.rmdir(current);
        current = path.dirname(current);
      } else {
        break;
      }
    } catch {
      break;
    }
  }
}

/** Track a newly created directory in the manifest for removal on undo. */
export async function trackNewDir(
  userId: string,
  conversationId: string,
  checkpointId: string,
  dirPath: string,
): Promise<void> {
  if (!checkpointId) return;
  return withManifestLock(userId, conversationId, checkpointId, async () => {
    try {
      const manifest = await readManifest(userId, conversationId, checkpointId);
      if (!manifest.newDirs) manifest.newDirs = [];
      if (!manifest.newDirs.includes(dirPath)) {
        manifest.newDirs.push(dirPath);
      }
      await writeManifest(userId, conversationId, checkpointId, manifest);
    } catch {
      /* non-critical */
    }
  });
}

function checkpointsRoot(userId: string): string {
  return path.join(CHECKPOINTS_DIR, userId);
}

function conversationCheckpointsDir(userId: string, conversationId: string): string {
  return path.join(checkpointsRoot(userId), conversationId);
}

function checkpointDir(userId: string, conversationId: string, id: string): string {
  return path.join(conversationCheckpointsDir(userId, conversationId), id);
}

function filesDir(userId: string, conversationId: string, id: string): string {
  return path.join(checkpointDir(userId, conversationId, id), "files");
}

function manifestPath(userId: string, conversationId: string, id: string): string {
  return path.join(checkpointDir(userId, conversationId, id), "manifest.json");
}

function timestampFromId(id: string): number {
  const ts = parseInt(id.split("-")[0] || "0", 10);
  return Number.isFinite(ts) ? ts : 0;
}

export function getSafeRelativePath(filePath: string): string {
  let normalized = path.normalize(filePath);
  // Strip extended length prefix \\?\ or //?/ if present
  if (normalized.startsWith("\\\\?\\") || normalized.startsWith("//?/")) {
    normalized = normalized.slice(4);
  }
  // Windows drive: e.g. "C:\foo\bar" or "c:\foo\bar" -> "drive-C\foo\bar"
  if (/^[a-zA-Z]:[\\/]/.test(normalized)) {
    const drive = normalized[0].toUpperCase();
    return path.join(`drive-${drive}`, normalized.slice(3));
  }
  // Strip leading slashes for absolute POSIX paths (e.g. "/home/user/..." -> "home/user/...")
  return normalized.replace(/^[\\/]+/, "");
}

async function verifyConversationOwnership(
  userId: string,
  conversationId: string,
): Promise<void> {
  const conv = await db.conversation.findUnique({
    where: { id: conversationId },
    select: { id: true, userId: true },
  });
  if (!conv || conv.userId !== userId) {
    throw new Error("Conversation not found");
  }
}

async function readManifest(userId: string, conversationId: string, id: string): Promise<Manifest> {
  const mp = manifestPath(userId, conversationId, id);
  try {
    const raw = await fs.readFile(mp, "utf-8");
    return JSON.parse(raw) as Manifest;
  } catch {
    return { files: {} };
  }
}

/** Rename with retry on Windows EPERM (antivirus/indexers briefly hold files). */
async function renameWithRetry(src: string, dest: string, attempts = 5): Promise<void> {
  for (let i = 1; i <= attempts; i++) {
    try {
      await fs.rename(src, dest);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EPERM" && i < attempts) {
        await new Promise((r) => setTimeout(r, 25 * i));
        continue;
      }
      await fs.unlink(src).catch(() => {});
      throw err;
    }
  }
}

async function writeManifest(
  userId: string, conversationId: string, id: string, manifest: Manifest,
): Promise<void> {
  const mp = manifestPath(userId, conversationId, id);
  const dir = path.dirname(mp);
  await fs.mkdir(dir, { recursive: true });
  // Atomic write: temp file in the same directory, then rename into place so
  // a crash mid-write never leaves a truncated/corrupt manifest.json.
  const tmp = path.join(
    dir,
    `.manifest-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`,
  );
  await fs.writeFile(tmp, JSON.stringify(manifest), "utf-8");
  await renameWithRetry(tmp, mp);
}

/** Create an empty checkpoint scoped to the given conversation. */
export async function createCheckpoint(
  userId: string,
  conversationId: string,
  label?: string,
): Promise<CheckpointInfo> {
  await verifyConversationOwnership(userId, conversationId);

  const ts = Date.now();
  const nonce = Math.random().toString(36).slice(2, 8);
  const id = `${ts}-${nonce}`;

  await fs.mkdir(filesDir(userId, conversationId, id), { recursive: true });
  await writeManifest(userId, conversationId, id, { files: {} });

  await pruneOldCheckpoints(userId, conversationId);

  const trimmedLabel = label && label.trim() ? label.trim().slice(0, 200) : null;

  return {
    id,
    label: trimmedLabel,
    createdAt: new Date(ts).toISOString(),
    fileCount: 0,
    conversationId,
  };
}

/** Snapshot a single file into the checkpoint files directory and update manifest. */
export async function snapshotFile(
  userId: string,
  conversationId: string,
  checkpointId: string,
  filePath: string,
): Promise<void> {
  const fDir = filesDir(userId, conversationId, checkpointId);
  const relPath = getSafeRelativePath(filePath);
  const target = path.join(fDir, relPath);

  return withManifestLock(userId, conversationId, checkpointId, async () => {
    // Existence check INSIDE the lock: two tools sharing one checkpointId
    // (main run + subagent) racing on the same file must not let the second
    // reader snapshot post-first-edit content as "original".
    if (existsSync(target)) return;

    // Read original file content. ENOENT (truly new file) → skip silently
    // so the caller tracks it as created; any OTHER read error (EACCES,
    // locks, transient I/O) must throw so the caller never misclassifies an
    // unreadable existing file as created (undo would DELETE it instead of
    // restoring it).
    let content: Buffer;
    try {
      content = await fs.readFile(filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return;
      throw err;
    }

    await fs.mkdir(path.dirname(target), { recursive: true });
    // Atomic snapshot write (tmp + rename): a crash mid-write must not
    // leave a truncated "original" that a later undo restores as truth.
    const tmp = path.join(
      path.dirname(target),
      `.snap-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`,
    );
    await fs.writeFile(tmp, content);
    await renameWithRetry(tmp, target);

    const manifest = await readManifest(userId, conversationId, checkpointId);
    manifest.files[filePath] = content.length;
    if (!manifest.hashes) manifest.hashes = {};
    manifest.hashes[filePath] = sha1Hex(content);
    await writeManifest(userId, conversationId, checkpointId, manifest);
  });
}

/** Track a newly created file in the checkpoint manifest for removal on undo. */
export async function trackNewFile(
  userId: string,
  conversationId: string,
  checkpointId: string,
  filePath: string,
): Promise<void> {
  if (!checkpointId) return;
  return withManifestLock(userId, conversationId, checkpointId, async () => {
    try {
      const manifest = await readManifest(userId, conversationId, checkpointId);
      if (!manifest.newFiles) manifest.newFiles = [];
      if (!manifest.newFiles.includes(filePath)) {
        manifest.newFiles.push(filePath);
      }
      await writeManifest(userId, conversationId, checkpointId, manifest);
    } catch {
      /* non-critical */
    }
  });
}

/** List all checkpoints for a conversation, newest first. */
export async function listCheckpoints(
  userId: string,
  conversationId: string,
): Promise<CheckpointInfo[]> {
  await verifyConversationOwnership(userId, conversationId);
  const dir = conversationCheckpointsDir(userId, conversationId);
  if (!existsSync(dir)) return [];

  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const ids = entries.filter((name) => /^\d+-[a-z0-9]+$/i.test(name) && !name.startsWith("."));
  const out: CheckpointInfo[] = [];

  for (const id of ids) {
    const cpDir = path.join(dir, id);
    const stat = await fs.stat(cpDir).catch(() => null);
    if (!stat || !stat.isDirectory()) continue;
    const manifest = await readManifest(userId, conversationId, id);
    const fileCount = Object.keys(manifest.files).length;
    out.push({
      id,
      label: null,
      createdAt: new Date(timestampFromId(id)).toISOString(),
      fileCount,
      conversationId,
    });
  }
  out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return out;
}

/** Locate a checkpoint by id across all user conversations. */
async function locateCheckpoint(
  userId: string,
  checkpointId: string,
): Promise<{ conversationId: string; dir: string } | null> {
  if (!/^\d+-[a-z0-9]+$/i.test(checkpointId)) return null;
  const cpRoot = checkpointsRoot(userId);
  if (!existsSync(cpRoot)) return null;

  let convDirs: string[];
  try {
    convDirs = await fs.readdir(cpRoot);
  } catch {
    return null;
  }
  for (const convId of convDirs) {
    const cpDir = path.join(cpRoot, convId, checkpointId);
    const stat = await fs.stat(cpDir).catch(() => null);
    if (stat && stat.isDirectory()) {
      try {
        await verifyConversationOwnership(userId, convId);
      } catch {
        return null;
      }
      return { conversationId: convId, dir: cpDir };
    }
  }
  return null;
}

export interface RestoreOptions {
  /**
   * Current workspace root for containment. Every restore/delete target
   * must resolve inside it — manifests record edit-time absolute paths,
   * which go stale after a workspace switch/move. Omitted (legacy callers)
   * skips the gate but still bounds parent-dir removal.
   */
  workspaceRoot?: string;
}

/** Restore a checkpoint by writing snapshot files back to disk and deleting newly added files. */
export async function restoreCheckpoint(
  userId: string,
  checkpointId: string,
  opts: RestoreOptions = {},
): Promise<{ ok: boolean; restoredFiles: string[]; conversationId: string }> {
  const located = await locateCheckpoint(userId, checkpointId);
  if (!located) throw new Error("Checkpoint not found");
  const { conversationId, dir } = located;

  const manifest = await readManifest(userId, conversationId, checkpointId);
  const restoredFiles: string[] = [];
  const errors: string[] = [];
  const guard = (p: string) => {
    if (opts.workspaceRoot) assertInsideWorkspace(opts.workspaceRoot, p);
  };

  // Delete files created by the agent
  if (manifest.newFiles && manifest.newFiles.length > 0) {
    for (const newFilePath of manifest.newFiles) {
      try {
        guard(newFilePath);
        if (existsSync(newFilePath)) {
          await fs.unlink(newFilePath);
          await removeEmptyParentDirs(newFilePath, opts.workspaceRoot);
          restoredFiles.push(newFilePath);
        }
      } catch (e) {
        errors.push(`${newFilePath}: ${e instanceof Error ? e.message : "delete error"}`);
      }
    }
  }

  // Delete directories created by the agent (deepest paths first)
  if (manifest.newDirs && manifest.newDirs.length > 0) {
    const sortedDirs = manifest.newDirs.slice().sort((a, b) => b.length - a.length);
    for (const newDirPath of sortedDirs) {
      try {
        guard(newDirPath);
        if (existsSync(newDirPath)) {
          await fs.rm(newDirPath, { recursive: true, force: true });
          await removeEmptyParentDirs(newDirPath, opts.workspaceRoot);
          restoredFiles.push(newDirPath);
        }
      } catch (e) {
        errors.push(`${newDirPath}: ${e instanceof Error ? e.message : "dir delete error"}`);
      }
    }
  }

  // Restore original content of pre-existing files
  for (const [absPath] of Object.entries(manifest.files)) {
    const relPath = getSafeRelativePath(absPath);
    const snapshotPath = path.join(dir, "files", relPath);
    try {
      guard(absPath);
      const content = await fs.readFile(snapshotPath);
      await fs.mkdir(path.dirname(absPath), { recursive: true });
      // Atomic restore (tmp + rename): a crash mid-write must not leave a
      // truncated file that still reports success upstream.
      const tmp = path.join(
        path.dirname(absPath),
        `.restore-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`,
      );
      await fs.writeFile(tmp, content);
      await renameWithRetry(tmp, absPath);
      // Verify against the manifest hash when the checkpoint recorded one
      // (new checkpoints do; legacy ones don't — fail open).
      const expected = manifest.hashes?.[absPath];
      if (expected) {
        const actual = await hashFileOnDisk(absPath);
        if (actual !== expected) {
          throw new Error(`post-restore hash mismatch (expected ${expected.slice(0, 8)}, got ${(actual ?? "unreadable").slice(0, 8)})`);
        }
      }
      restoredFiles.push(absPath);
    } catch (e) {
      errors.push(`${absPath}: ${e instanceof Error ? e.message : "unknown error"}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `Restored ${restoredFiles.length} file(s) with ${errors.length} error(s): ${errors.join("; ")}`,
    );
  }

  return { ok: true, restoredFiles, conversationId };
}

export interface RestoreSinceResult {
  ok: boolean;
  restoredFiles: string[];
  failed: { id: string; error: string }[];
  attempted: number;
}

/**
 * Restore checkpoints created at or after targetTimestamp in reverse chronological order.
 * Reverts file modifications, new files, and directories for all subsequent turns.
 *
 * Truth-propagating: per-checkpoint failures are collected (never swallowed
 * into ok:true), failed checkpoints are NOT purged (a later retry after
 * fixing the cause can still apply them), and the caller decides whether a
 * partial restore may proceed (the DELETE route refuses to delete transcript
 * rows on a failed restore).
 */
export async function restoreCheckpointsSinceTimestamp(
  userId: string,
  conversationId: string,
  targetTimestamp: number,
  opts: RestoreOptions = {},
): Promise<RestoreSinceResult> {
  await verifyConversationOwnership(userId, conversationId);
  const allCheckpoints = await listCheckpoints(userId, conversationId);

  // Filter checkpoints created at or after the target message timestamp.
  const targetCheckpoints = allCheckpoints.filter((cp) => {
    const cpTs = timestampFromId(cp.id);
    return cpTs >= targetTimestamp;
  });

  const restoredFilesSet = new Set<string>();
  const failed: { id: string; error: string }[] = [];
  for (const cp of targetCheckpoints) {
    try {
      const res = await restoreCheckpoint(userId, cp.id, opts);
      res.restoredFiles.forEach((f) => restoredFilesSet.add(f));
      // Purge the undone checkpoint directory from disk so future undos remain consistent
      await deleteCheckpoint(userId, cp.id).catch(() => null);
    } catch (e) {
      failed.push({ id: cp.id, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return {
    ok: failed.length === 0,
    restoredFiles: Array.from(restoredFilesSet),
    failed,
    attempted: targetCheckpoints.length,
  };
}

/** Delete a checkpoint by id. */
export async function deleteCheckpoint(
  userId: string,
  checkpointId: string,
): Promise<{ ok: boolean; conversationId: string }> {
  const located = await locateCheckpoint(userId, checkpointId);
  if (!located) throw new Error("Checkpoint not found");
  const { conversationId, dir } = located;
  await fs.rm(dir, { recursive: true, force: true });
  return { ok: true, conversationId };
}

/** List the files inside a checkpoint (relative paths). */
export async function getCheckpointFiles(
  userId: string,
  checkpointId: string,
): Promise<{
  id: string;
  conversationId: string;
  files: string[];
  fileCount: number;
}> {
  const located = await locateCheckpoint(userId, checkpointId);
  if (!located) throw new Error("Checkpoint not found");
  const { conversationId, dir } = located;
  const manifest = await readManifest(userId, conversationId, checkpointId);
  const files = Object.keys(manifest.files).sort();
  return { id: checkpointId, conversationId, files, fileCount: files.length };
}

async function pruneOldCheckpoints(
  userId: string,
  conversationId: string,
): Promise<void> {
  const dir = conversationCheckpointsDir(userId, conversationId);
  if (!existsSync(dir)) return;
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return;
  }
  const ids = entries.filter((name) => /^\d+-[a-z0-9]+$/i.test(name) && !name.startsWith("."));
  ids.sort((a, b) => timestampFromId(a) - timestampFromId(b));
  while (ids.length > MAX_CHECKPOINTS_PER_CONV) {
    const oldest = ids.shift()!;
    try {
      await fs.rm(path.join(dir, oldest), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

const PREVIEW_READ_CAP = 2 * 1024 * 1024;

function countLines(text: string): number {
  if (!text) return 0;
  const parts = text.split("\n");
  // A single trailing newline terminates the last line; it is not a line.
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts.length;
}

export type { UndoPreviewFile, UndoPreviewExpected, UndoPreview } from "@/lib/undo-plan";
import type { UndoPreviewFile, UndoPreview } from "@/lib/undo-plan";

/**
 * Build the revert plan for "undo to this point" WITHOUT changing anything.
 * Per path, newest-first manifests resolve to a final state: a path listed
 * as new in ANY target checkpoint (and snapshotted by none older) ends
 * DELETED; otherwise its content ends as the OLDEST snapshot. Line counts
 * are computed snapshot→current then INVERTED for display (agent additions
 * show as removals and vice versa — that is what the undo will do).
 */
export async function buildUndoPreview(
  userId: string,
  conversationId: string,
  targetTimestamp: number,
  opts: RestoreOptions = {},
): Promise<UndoPreview> {
  await verifyConversationOwnership(userId, conversationId);
  const allCheckpoints = await listCheckpoints(userId, conversationId);
  const target = allCheckpoints
    .filter((cp) => timestampFromId(cp.id) >= targetTimestamp)
    .sort((a, b) => timestampFromId(b.id) - timestampFromId(a.id));

  // Oldest touch wins per path — mirroring restore semantics exactly.
  // Restore applies newest-first overwrites, so the OLDEST target checkpoint
  // touching a path decides its final state: an oldest touch of `newFiles`
  // means DELETED (a newer snapshot write is undone by the older delete),
  // an oldest touch of `files` means that snapshot's content.
  const oldestTouch = new Map<
    string,
    { kind: "new" } | { kind: "files"; dir: string }
  >();
  let dirsRemoved = 0;
  for (const cp of [...target].reverse()) {
    const located = await locateCheckpoint(userId, cp.id);
    if (!located) continue;
    const manifest = await readManifest(userId, located.conversationId, cp.id);
    for (const f of manifest.newFiles ?? []) {
      if (!oldestTouch.has(f)) oldestTouch.set(f, { kind: "new" });
    }
    for (const absPath of Object.keys(manifest.files)) {
      if (!oldestTouch.has(absPath)) {
        oldestTouch.set(absPath, { kind: "files", dir: located.dir });
      }
    }
    dirsRemoved += (manifest.newDirs ?? []).length;
  }

  const files: UndoPreviewFile[] = [];
  const expected: { path: string; hash: string | null }[] = [];
  const displayOf = (absPath: string) =>
    opts.workspaceRoot
      ? path.relative(opts.workspaceRoot, absPath) || path.basename(absPath)
      : path.basename(absPath);

  // Paths deleted outright (oldest touch is agent-created).
  for (const [absPath, touch] of oldestTouch) {
    if (touch.kind !== "new") continue;
    try {
      if (opts.workspaceRoot) assertInsideWorkspace(opts.workspaceRoot, absPath);
    } catch {
      continue;
    }
    const current = await fs.readFile(absPath, "utf-8").catch(() => null);
    if (current === null) continue; // already gone — nothing to show or verify
    const hash = sha1Hex(current);
    files.push({
      path: absPath,
      display: displayOf(absPath),
      restored: 0,
      removed: countLines(current),
      status: "created",
      hash,
    });
    expected.push({ path: absPath, hash });
  }

  // Modified paths: diff oldest snapshot vs current, then invert for display.
  // Every tracked path joins `expected` (even unchanged ones) so the confirm
  // verification covers files dirtied anywhere in the preview→verify window —
  // clean-at-preview files must not escape the 409.
  for (const [absPath, touch] of oldestTouch) {
    if (touch.kind !== "files") continue;
    const { dir } = touch;
    try {
      if (opts.workspaceRoot) assertInsideWorkspace(opts.workspaceRoot, absPath);
    } catch {
      continue;
    }
    const relPath = getSafeRelativePath(absPath);
    const [snapRaw, curRaw] = await Promise.all([
      fs.readFile(path.join(dir, "files", relPath)).catch(() => null),
      fs.readFile(absPath, "utf-8").catch(() => null),
    ]);
    if (snapRaw === null) continue; // snapshot unreadable — restore would fail loudly; preview skips
    const hash = curRaw === null ? null : sha1Hex(curRaw);
    if (curRaw === null) {
      // Deleted since the snapshot: undo recreates the whole file.
      files.push({
        path: absPath,
        display: displayOf(absPath),
        restored: countLines(snapRaw.toString("utf-8")),
        removed: 0,
        status: "missing",
        hash,
      });
      expected.push({ path: absPath, hash });
      continue;
    }
    const snapText = snapRaw.toString("utf-8");
    let restored = 0;
    let removed = 0;
    if (snapText !== curRaw) {
      if (snapRaw.length > PREVIEW_READ_CAP || curRaw.length > PREVIEW_READ_CAP) {
        const s = countLines(snapText);
        const c = countLines(curRaw);
        restored = Math.max(0, s - c);
        removed = Math.max(0, c - s);
      } else {
        for (const d of computeDiff(snapText, curRaw)) {
          if (d.type === "add") removed += 1; // agent added → undo removes
          else if (d.type === "del") restored += 1; // agent deleted → undo restores
        }
      }
    }
    // Unchanged paths stay out of the dialog (nothing to show) but MUST join
    // `expected`: otherwise a file dirtied between preview and confirm
    // escapes verification and its 409 — the exact hole that silently
    // clobbers fresh user edits.
    expected.push({ path: absPath, hash });
    if (restored === 0 && removed === 0) continue; // no-op entry — keep the dialog clean
    files.push({ path: absPath, display: displayOf(absPath), restored, removed, status: "modified", hash });
  }

  files.sort((a, b) => a.display.localeCompare(b.display));
  return { files, expected, attempted: target.length, dirsRemoved };
}

/** Delete all checkpoints for a conversation and clean up its folder on disk. */
export async function deleteConversationCheckpoints(
  userId: string,
  conversationId: string,
): Promise<void> {
  const dir = conversationCheckpointsDir(userId, conversationId);
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    /* ignore if folder did not exist */
  }
}

