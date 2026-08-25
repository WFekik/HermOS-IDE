import path from "path";
import fs from "fs/promises";
import { existsSync } from "fs";
import { db } from "@/lib/db";
import { CHECKPOINTS_DIR } from "@/lib/paths";

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
  newFiles?: string[];
  newDirs?: string[];
}

const manifestLocks = new Map<string, Promise<unknown>>();

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

async function removeEmptyParentDirs(startPath: string): Promise<void> {
  let current = path.dirname(startPath);
  while (current && current.length > 3) {
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

function getSafeRelativePath(filePath: string): string {
  const parsed = path.parse(filePath);
  if (filePath.startsWith(parsed.root)) {
    return filePath.slice(parsed.root.length);
  }
  return filePath;
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

  if (existsSync(target)) return;

  // Read original file content. If it doesn't exist or can't be read, skip.
  let content: Buffer;
  try {
    content = await fs.readFile(filePath);
  } catch {
    return;
  }

  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);

  return withManifestLock(userId, conversationId, checkpointId, async () => {
    const manifest = await readManifest(userId, conversationId, checkpointId);
    manifest.files[filePath] = content.length;
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

/** Restore a checkpoint by writing snapshot files back to disk and deleting newly added files. */
export async function restoreCheckpoint(
  userId: string,
  checkpointId: string,
): Promise<{ ok: boolean; restoredFiles: string[]; conversationId: string }> {
  const located = await locateCheckpoint(userId, checkpointId);
  if (!located) throw new Error("Checkpoint not found");
  const { conversationId, dir } = located;

  const manifest = await readManifest(userId, conversationId, checkpointId);
  const restoredFiles: string[] = [];
  const errors: string[] = [];

  // Delete files created by the agent
  if (manifest.newFiles && manifest.newFiles.length > 0) {
    for (const newFilePath of manifest.newFiles) {
      try {
        if (existsSync(newFilePath)) {
          await fs.unlink(newFilePath);
          await removeEmptyParentDirs(newFilePath);
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
        if (existsSync(newDirPath)) {
          await fs.rm(newDirPath, { recursive: true, force: true });
          await removeEmptyParentDirs(newDirPath);
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
      const content = await fs.readFile(snapshotPath);
      await fs.mkdir(path.dirname(absPath), { recursive: true });
      await fs.writeFile(absPath, content);
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

/**
 * Restore checkpoints created at or after targetTimestamp in reverse chronological order.
 * Reverts file modifications, new files, and directories for all subsequent turns.
 */
export async function restoreCheckpointsSinceTimestamp(
  userId: string,
  conversationId: string,
  targetTimestamp: number,
): Promise<{ ok: boolean; restoredFiles: string[] }> {
  await verifyConversationOwnership(userId, conversationId);
  const allCheckpoints = await listCheckpoints(userId, conversationId);

  // Filter checkpoints created at or after the target message timestamp.
  const targetCheckpoints = allCheckpoints.filter((cp) => {
    const cpTs = timestampFromId(cp.id);
    return cpTs >= targetTimestamp;
  });

  const restoredFilesSet = new Set<string>();
  for (const cp of targetCheckpoints) {
    try {
      const res = await restoreCheckpoint(userId, cp.id);
      res.restoredFiles.forEach((f) => restoredFilesSet.add(f));
      // Purge the undone checkpoint directory from disk so future undos remain consistent
      await deleteCheckpoint(userId, cp.id).catch(() => null);
    } catch (e) {
      console.warn(`[checkpoints] Warning restoring checkpoint ${cp.id}:`, e);
    }
  }

  return { ok: true, restoredFiles: Array.from(restoredFilesSet) };
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
