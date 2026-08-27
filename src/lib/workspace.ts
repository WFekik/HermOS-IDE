import path from "path";
import fs from "fs/promises";
import { existsSync, realpathSync, statSync, mkdirSync, readdirSync, unlinkSync } from "fs";
import { spawn, execSync } from "child_process";
import { db } from "@/lib/db";
import type { TerminalResponse } from "@/lib/types";
import { WORKSPACES_ROOT, AGENT_TEMP_ROOT, safeUserId } from "@/lib/paths";
import { TRUNCATION_DIR, truncationUserDir } from "@/lib/truncate";
import { getSandboxRunner } from "@/lib/sandbox";


export interface FileNode {
  name: string;
  path: string; // path relative to workspace root
  type: "file" | "dir";
  size?: number;
  children?: FileNode[];
}

export interface WorkspaceInfo {
  id: string;
  name: string;
  rootDir: string;
  isActive: boolean;
}

function userRoot(userId: string): string {
  // Fallback path under the persistent workspaces root (used when a
  // workspace has no rootDir set). Normal workspaces (from-folder) store
  // their real path directly.
  return path.join(WORKSPACES_ROOT, userId);
}

/** Per-user agent scratch dir (`<APP_DATA_DIR>/agent-temp/<userId>`), exposed via HERMOS_TEMP_DIR. */
export function agentTempDir(userId: string): string {
  return path.join(AGENT_TEMP_ROOT, safeUserId(userId));
}

const TEMP_FILE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
let lastTempSweep = 0;

function sweepAgentTemp(): void {
  const now = Date.now();
  if (now - lastTempSweep < 24 * 60 * 60 * 1000) return;
  lastTempSweep = now;
  try {
    const cutoff = now - TEMP_FILE_RETENTION_MS;
    for (const user of readdirSync(AGENT_TEMP_ROOT, { withFileTypes: true })) {
      if (!user.isDirectory()) continue;
      const dir = path.join(AGENT_TEMP_ROOT, user.name);
      for (const { name, isFile } of readdirSync(dir, { withFileTypes: true })) {
        if (!isFile) continue;
        try {
          if (statSync(path.join(dir, name)).mtimeMs < cutoff) unlinkSync(path.join(dir, name));
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* ignore */
  }
}

/** Ensure the per-user scratch dir exists; best-effort, never throws. */
export function ensureAgentTempDir(userId: string): string {
  const dir = agentTempDir(userId);
  try {
    if (!existsSync(/* turbopackIgnore: true */ dir)) {
      mkdirSync(/* turbopackIgnore: true */ dir, { recursive: true });
    }
  } catch {
    /* ignore */
  }
  sweepAgentTemp();
  return dir;
}

// Cache for workspace rootDir lookups (userId:wsName -> rootDir)
const rootDirCache = new Map<string, string>();

/** Resolve a workspace's actual rootDir from the DB (cached). */
export async function resolveRootDir(userId: string, wsName: string): Promise<string> {
  const key = `${userId}:${wsName}`;
  const cached = rootDirCache.get(key);
  if (cached && existsSync(cached)) return cached;
  // Stale entry — evict and re-query
  rootDirCache.delete(key);
  try {
    const ws = await db.workspace.findFirst({
      where: { userId, name: wsName },
    });
    if (ws?.rootDir && existsSync(ws.rootDir)) {
      rootDirCache.set(key, ws.rootDir);
      return ws.rootDir;
    }
  } catch { /* fall through */ }
  // Don't cache the fallback — it would pin a stale path if the real
  // rootDir is later restored.
  return path.join(WORKSPACES_ROOT, userId, wsName);
}

/** Invalidate the rootDir cache for a workspace (e.g. after switching). */
export function invalidateRootDirCache(userId: string, wsName: string): void {
  rootDirCache.delete(`${userId}:${wsName}`);
}

/** Resolve a relative path inside the workspace, rejecting traversal escapes. */
export function safePath(userId: string, wsName: string, rel: string, rootDir?: string): string | null {
  const base = rootDir ?? rootDirCache.get(`${userId}:${wsName}`) ?? path.join(userRoot(userId), wsName);
  return safePathFromRoot(base, rel);
}

/** Check if target path is equal to or a child of base path (handles Windows drive casing & case-insensitivity). */
export function isSubpathOrEqual(target: string, base: string): boolean {
  if (!target || !base) return false;
  if (process.platform === "win32") {
    const t = target.toLowerCase();
    const b = base.toLowerCase();
    if (t === b) return true;
    const bSep = b.endsWith(path.sep) ? b : b + path.sep;
    return t.startsWith(bSep);
  }
  if (target === base) return true;
  const bSep = base.endsWith(path.sep) ? base : base + path.sep;
  return target.startsWith(bSep);
}

/** Resolve a relative path against a known rootDir (for native folders / desktop mode). */
export function safePathFromRoot(rootDir: string, rel: string): string | null {
  if (!rootDir) return null;
  const base = path.resolve(rootDir);
  // Absolute inputs from resolveAgentPath (e.g. /home/.../truncation/... on Linux)
  // must be checked directly against base. Stripping the leading / and re-resolving
  // as relative would break POSIX (/home/... → home/... → /base/home/...).
  // If the absolute path is inside base, return it; otherwise treat leading slashes
  // as relative (so "/foo.ts" → "foo.ts" inside the workspace, as expected by tests).
  if (path.isAbsolute(rel)) {
    const abs = path.resolve(rel);
    if (isSubpathOrEqual(abs, base)) {
      try {
        const realBase = realpathSync(base);
        if (existsSync(/* turbopackIgnore: true */ abs)) {
          const realAbs = realpathSync(/* turbopackIgnore: true */ abs);
          if (!isSubpathOrEqual(realAbs, realBase)) return null;
        } else {
          let checkDir = path.dirname(abs);
          while (!existsSync(checkDir) && checkDir !== base && path.dirname(checkDir) !== checkDir) {
            checkDir = path.dirname(checkDir);
          }
          if (existsSync(checkDir)) {
            const realCheck = realpathSync(checkDir);
            if (!isSubpathOrEqual(realCheck, realBase)) return null;
          }
        }
      } catch {
        /* ignore */
      }
      return abs;
    }
    // Windows drive-letter paths (C:\...) or UNC paths (\\server\...) outside base must be rejected.
    if (process.platform === "win32") {
      if (/^[a-zA-Z]:[\\/]/.test(rel) || /^\\\\[^\\]/.test(rel)) {
        return null;
      }
    } else {
      // On POSIX, reject real system root paths outside workspace base.
      const posixNorm = (rel || "").replace(/\\/g, "/");
      const systemRoots = /^\/(?:etc|var|usr|bin|sbin|home|root|opt|dev|proc|sys|tmp|private|Library|System|Users|Applications|Volumes|mnt|media|srv)(?:\/|$)/;
      if (systemRoots.test(posixNorm)) {
        return null;
      }
    }
    // Not a drive letter or system root — e.g. "/foo.ts" should be treated as "foo.ts" inside the workspace
    rel = rel.replace(/^\/+/, "").replace(/^\\+/, "");
  }
  const normalizedRel = (rel || "").replace(/\\/g, "/");
  // Strip leading ./ and / only — NOT leading .. (which must still be caught
  // by the includes("..") check below). The old regex /^[\.\/]+/ stripped
  // leading .. which defeated the traversal guard on Windows.
  const clean = normalizedRel.replace(/^(\.\/)+/, "").replace(/^\/+/, "").replace(/\/+$/, "");
  // Reject dot-only or dot-space traversal segments (>= 2 dots) while preserving
  // legitimate filenames like `foo..bar.ts` across Windows and POSIX.
  const segments = clean.split("/");
  const isTraversalSegment = (s: string): boolean => {
    if (!s) return false;
    if (process.platform === "win32") {
      if (!/^[. ]+$/.test(s)) return false;
      return s.replace(/ /g, "").length >= 2;
    }
    return /^\.+$/.test(s) && s.length >= 2;
  };
  if (segments.some(isTraversalSegment)) return null;
  const abs = path.resolve(base, clean || ".");
  if (!isSubpathOrEqual(abs, base)) return null;

  // Symlink defense-in-depth: ensure realpath does not escape workspace base
  try {
    const realBase = realpathSync(base);
    if (existsSync(/* turbopackIgnore: true */ abs)) {
      const realAbs = realpathSync(/* turbopackIgnore: true */ abs);
      if (!isSubpathOrEqual(realAbs, realBase)) {
        return null;
      }
    } else {
      let checkDir = path.dirname(abs);
      while (!existsSync(checkDir) && checkDir !== base && path.dirname(checkDir) !== checkDir) {
        checkDir = path.dirname(checkDir);
      }
      if (existsSync(checkDir)) {
        const realCheck = realpathSync(checkDir);
        if (!isSubpathOrEqual(realCheck, realBase)) {
          return null;
        }
      }
    }
  } catch {
    /* ignore stat/permission failures */
  }
  return abs;
}

const BOX_DRAWING_MAP: Record<string, string> = {
  "\u00b3": "│", // CP1252 ³ → │
  "\u00c3": "├", // CP1252 Ã → ├
  "\u00c4": "─", // CP1252 Ä → ─
  "\u00c0": "└", // CP1252 À → └
  "\u00c2": "┬", // CP1252 Â → ┬
  "\u00c1": "┴", // CP1252 Á → ┴
  "\u00c5": "┼", // CP1252 Å → ┼
  "\u00b4": "┤", // CP1252 ´ → ┤
};

export function decodeBuffer(chunk: Buffer): string {
  try {
    const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
    return utf8Decoder.decode(chunk);
  } catch (e) {
    if (process.platform === "win32") {
      try {
        const text = new TextDecoder("windows-1252").decode(chunk);
        return text.replace(/[\u00b3\u00c3\u00c4\u00c0\u00c2\u00c1\u00c5\u00b4]/g, (c) => BOX_DRAWING_MAP[c] || c);
      } catch {
        // fallback
      }
    }
    return new TextDecoder("utf-8").decode(chunk);
  }
}

async function ensureDir(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true });
}

export async function openWorkspace(
  userId: string,
  name: string,
  rootDir?: string,
): Promise<WorkspaceInfo> {
  const cleanName = name
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .slice(0, 64);
  if (!cleanName) throw new Error("Invalid workspace name.");
  // Persistent default workspace under WORKSPACES_ROOT (NOT a temp dir) so
  // files survive restarts. The desktop app should use from-folder instead.
  const dir = rootDir ?? path.join(WORKSPACES_ROOT, userId, cleanName);
  // Ensure the workspace directory exists before anything tries to run
  // commands in it (parity with ensureDefaultWorkspace; a missing cwd makes
  // assertCwdInsideWorkspace throw at spawn time).
  await ensureDir(dir);
  const ws = await db.workspace.upsert({
    where: { userId_name: { userId, name: cleanName } },
    update: { isActive: true, rootDir: dir },
    create: { userId, name: cleanName, rootDir: dir, isActive: true },
  });
  await db.workspace.updateMany({
    where: { userId, NOT: { id: ws.id } },
    data: { isActive: false },
  });
  await db.user.update({
    where: { id: userId },
    data: { workspaceName: cleanName },
  });
  return {
    id: ws.id,
    name: cleanName,
    rootDir: dir,
    isActive: true,
  };
}

export async function getActiveWorkspace(
  userId: string,
): Promise<WorkspaceInfo | null> {
  const ws = await db.workspace.findFirst({
    where: { userId, isActive: true },
    orderBy: { updatedAt: "desc" },
  });
  if (!ws) return null;
  if (!existsSync(ws.rootDir)) {
    await ensureDir(ws.rootDir);
  }
  // Populate rootDir cache so sync callers (safePath) resolve correctly.
  rootDirCache.set(`${userId}:${ws.name}`, ws.rootDir);
  return { id: ws.id, name: ws.name, rootDir: ws.rootDir, isActive: true };
}

/** Resolve a workspace by id (ownership-checked) or fall back to the active workspace. */
export async function resolveWorkspace(
  userId: string,
  workspaceId?: string,
): Promise<WorkspaceInfo | null> {
  if (workspaceId) {
    const ws = await db.workspace.findFirst({
      where: { id: workspaceId, userId },
    });
    if (ws) {
      rootDirCache.set(`${userId}:${ws.name}`, ws.rootDir);
      return { id: ws.id, name: ws.name, rootDir: ws.rootDir, isActive: true };
    }
  }
  return getActiveWorkspace(userId);
}

export async function ensureDefaultWorkspace(
  userId: string,
): Promise<WorkspaceInfo> {
  // Persistent fallback workspace under WORKSPACES_ROOT (NOT a temp dir) so
  // the default workspace's files survive restarts.
  const rootDir = path.join(WORKSPACES_ROOT, userId);
  await ensureDir(rootDir);
  const ws = await db.workspace.upsert({
    where: { userId_name: { userId, name: "default" } },
    update: { isActive: true, rootDir },
    create: { userId, name: "default", rootDir, isActive: true },
  });
  await db.workspace.updateMany({
    where: { userId, NOT: { id: ws.id } },
    data: { isActive: false },
  });
  await db.user.update({
    where: { id: userId },
    data: { workspaceName: "default" },
  });
  return { id: ws.id, name: "default", rootDir, isActive: true };
}

export async function listWorkspaces(userId: string): Promise<WorkspaceInfo[]> {
  const rows = await db.workspace.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    rootDir: r.rootDir,
    isActive: r.isActive,
  }));
}

/** Workspace list entry extending `WorkspaceInfo` with DB timestamps for switcher UI. */
export interface WorkspaceListItem extends WorkspaceInfo {
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}

function toWorkspaceListItem(r: {
  id: string;
  name: string;
  rootDir: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}): WorkspaceListItem {
  return {
    id: r.id,
    name: r.name,
    rootDir: r.rootDir,
    isActive: r.isActive,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** Return all user workspaces sorted newest-first by `createdAt` (stable, recent-first). */
export async function listUserWorkspaces(
  userId: string,
): Promise<WorkspaceListItem[]> {
  const rows = await db.workspace.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });
  return rows.map(toWorkspaceListItem);
}

/** Return user's N most-recently-updated workspaces (default 5, clamped 1–50). */
export async function getRecentWorkspaces(
  userId: string,
  limit = 5,
): Promise<WorkspaceListItem[]> {
  const clamped = Math.max(1, Math.min(50, Math.floor(limit) || 5));
  const rows = await db.workspace.findMany({
    where: { userId },
    orderBy: { updatedAt: "desc" },
    take: clamped,
  });
  return rows.map(toWorkspaceListItem);
}

/** Switch active workspace to `workspaceId`, updating active pointer and timestamps. */
export async function switchWorkspace(
  userId: string,
  workspaceId: string,
): Promise<WorkspaceInfo | null> {
  // Validate the id shape minimally (cuid — 24 lowercase alnum). This is a
  // defence-in-depth check; the DB lookup below is the real authority.
  if (!workspaceId || typeof workspaceId !== "string" || workspaceId.length > 64) {
    return null;
  }
  const target = await db.workspace.findFirst({
    where: { id: workspaceId, userId },
  });
  if (!target) return null;
  // Ensure the on-disk root exists (defensive — a backup/restore could have
  // removed the folder; we never want switchWorkspace to silently succeed
  // then have file ops fail later).
  if (!existsSync(target.rootDir)) {
    await ensureDir(target.rootDir);
  }
  await db.$transaction([
    db.workspace.updateMany({
      where: { userId, isActive: true },
      data: { isActive: false },
    }),
    db.workspace.update({
      where: { id: target.id },
      data: { isActive: true, updatedAt: new Date() },
    }),
    db.user.update({
      where: { id: userId },
      data: { workspaceName: target.name },
    }),
  ]);
  return {
    id: target.id,
    name: target.name,
    rootDir: target.rootDir,
    isActive: true,
  };
}

export async function closeWorkspace(userId: string): Promise<void> {
  await db.workspace.updateMany({
    where: { userId, isActive: true },
    data: { isActive: false },
  });
  await db.user.update({
    where: { id: userId },
    data: { workspaceName: null },
  });
}

export async function renameWorkspace(
  userId: string,
  workspaceId: string,
  newName: string,
): Promise<WorkspaceInfo> {
  const ws = await db.workspace.findFirst({
    where: { id: workspaceId, userId },
  });
  if (!ws) throw new Error("Workspace not found");
  const existing = await db.workspace.findFirst({
    where: { userId, name: newName, NOT: { id: workspaceId } },
  });
  if (existing) throw new Error(`A workspace named "${newName}" already exists`);
  const updated = await db.workspace.update({
    where: { id: workspaceId },
    data: { name: newName },
  });
  rootDirCache.set(`${userId}:${updated.name}`, updated.rootDir);
  return { id: updated.id, name: updated.name, rootDir: updated.rootDir, isActive: updated.isActive };
}

export async function deleteWorkspace(
  userId: string,
  workspaceId: string,
): Promise<void> {
  const ws = await db.workspace.findFirst({
    where: { id: workspaceId, userId },
  });
  if (!ws) throw new Error("Workspace not found");
  // Unlink conversations before deleting.
  await db.conversation.updateMany({
    where: { workspaceId },
    data: { workspaceId: null },
  });
  await db.workspace.delete({ where: { id: workspaceId } });
}

export async function readTree(
  userId: string,
  wsName: string,
  maxDepth = 6,
  rootDir?: string,
): Promise<FileNode[]> {
  const base = rootDir ?? path.join(userRoot(userId), wsName);
  if (!existsSync(base)) return [];
  const state = { count: 0 };
  return readTreeRec(base, base, "", 0, maxDepth, state);
}

const MAX_TREE_NODES = 50_000;

const IGNORED_TREE_ENTRIES: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  ".next",
  ".next-build",
  ".gemini",
  ".hermos",
  ".artifacts",
  "npm-cache",
  ".npm",
  "dist",
  "build",
  "out",
  "coverage",
  ".vercel",
  ".turbo",
  ".eslintcache",
  ".cache",
]);

async function readTreeRec(
  base: string,
  abs: string,
  rel: string,
  depth: number,
  maxDepth: number,
  state: { count: number },
): Promise<FileNode[]> {
  if (depth > maxDepth || state.count >= MAX_TREE_NODES) return [];
  const entries = await fs.readdir(abs, { withFileTypes: true }).catch(() => []);
  const nodes: FileNode[] = [];
  const filePromises: Promise<FileNode>[] = [];
  for (const e of entries) {
    if (IGNORED_TREE_ENTRIES.has(e.name)) {
      continue;
    }
    const childAbs = path.join(abs, e.name);
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    state.count++;
    if (state.count >= MAX_TREE_NODES) break;
    if (e.isDirectory()) {
      const node: FileNode = {
        name: e.name,
        path: childRel,
        type: "dir",
        children:
          depth < maxDepth
            ? await readTreeRec(base, childAbs, childRel, depth + 1, maxDepth, state)
            : undefined,
      };
      nodes.push(node);
    } else if (e.isFile()) {
      filePromises.push(
        fs.stat(childAbs).then((stat) => ({
          name: e.name,
          path: childRel,
          type: "file" as const,
          size: stat.size,
        })).catch(() => ({
          name: e.name,
          path: childRel,
          type: "file" as const,
        }))
      );
    }
  }

  if (filePromises.length > 0) {
    const fileNodes = await Promise.all(filePromises);
    nodes.push(...fileNodes);
  }
  // dirs first, then files, alpha within.
  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return nodes;
}

export async function readFileWs(
  userId: string,
  wsName: string,
  rel: string,
  maxBytes = 10_000_000,
  rootDir?: string,
): Promise<{ path: string; content: string; size: number }> {
  const abs = safePath(userId, wsName, rel, rootDir);
  if (!abs) throw new Error("Invalid path.");
  const stat = await fs.stat(/* turbopackIgnore: true */ abs).catch(() => null);
  if (!stat || !stat.isFile()) throw new Error("File not found.");
  if (stat.size > maxBytes) {
    throw new Error(
      `File ${rel} is ${stat.size} bytes (limit ${maxBytes}). Use readFileRangeWs to read in chunks.`,
    );
  }
  const buf = await fs.readFile(/* turbopackIgnore: true */ abs);
  const sample = buf.subarray(0, 8192);
  if (sample.includes(0)) {
    return {
      path: rel,
      content: `(binary file: ${stat.size} bytes — cannot be displayed as text)`,
      size: stat.size,
    };
  }
  const content = buf.toString("utf8");
  return { path: rel, content, size: stat.size };
}

/**
 * Reads a 1-based inclusive line range (`startLine..endLine`) from a workspace file.
 * Automatically clamps range boundaries to total line bounds.
 */
export async function readFileRangeWs(
  userId: string,
  wsName: string,
  rel: string,
  startLine: number,
  endLine?: number,
  rootDir?: string,
): Promise<{
  path: string;
  content: string;
  totalLines: number;
  startLine: number;
  endLine: number;
  size: number;
}> {
  const abs = safePath(userId, wsName, rel, rootDir);
  if (!abs) throw new Error("Invalid path.");
  const stat = await fs.stat(/* turbopackIgnore: true */ abs).catch(() => null);
  if (!stat || !stat.isFile()) throw new Error("File not found.");

  // Guard: reject excessively large files to prevent memory exhaustion
  const MAX_RANGE_FILE = 10_000_000; // 10 MB
  if (stat.size > MAX_RANGE_FILE) {
    throw new Error(
      `File ${rel} is ${stat.size} bytes (limit ${MAX_RANGE_FILE} for range reads). Use a smaller file or read with an offset.`,
    );
  }

  let s = Math.max(1, Math.floor(startLine));
  let e = endLine !== undefined && Number.isFinite(endLine) ? Math.floor(endLine) : undefined;

  const buf = await fs.readFile(/* turbopackIgnore: true */ abs);
  const sample = buf.subarray(0, 8192);
  if (sample.includes(0)) {
    return {
      path: rel,
      content: `(binary file: ${stat.size} bytes — cannot be displayed as text)`,
      totalLines: 0,
      startLine: s,
      endLine: e ?? s,
      size: stat.size,
    };
  }
  const content = buf.toString("utf8");

  // Split into lines, dropping the trailing empty string produced by a
  // final newline (so "a\nb\nc\n" → 3 lines, not 4).
  let lines: string[];
  if (content === "") {
    lines = [];
  } else {
    lines = content.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
    if (content.endsWith("\n")) lines.pop();
  }
  const totalLines = lines.length;

  if (e === undefined) {
    e = totalLines;
  }
  if (e < s) e = s;

  if (s > totalLines) s = totalLines;
  if (e > totalLines) e = totalLines;

  const slice = s <= e ? lines.slice(s - 1, e).join("\n") : "";

  return {
    path: rel,
    content: slice,
    totalLines,
    startLine: s,
    endLine: e,
    size: stat.size,
  };

}

/**
 * Converts a glob pattern (`**`, `*`, `?`, `{a,b}`) into a case-insensitive RegExp.
 */
export function globToRegex(glob: string): RegExp {
  let regex = "^";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "{") {
      const closeIdx = glob.indexOf("}", i);
      if (closeIdx > i + 1) {
        const body = glob.slice(i + 1, closeIdx);
        if (body.includes(",")) {
          const parts = body.split(",").map((p) =>
            p.trim().replace(/[.+^${}()|[\]\\]/g, "\\$&")
          );
          regex += "(?:" + parts.join("|") + ")";
          i = closeIdx + 1;
          continue;
        }
      }
    }
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**` — matches across segments.
        i += 2;
        if (glob[i] === "/") {
          // `**/` — zero or more path segments.
          regex += "(?:.*/)?";
          i++;
        } else {
          // `**` not followed by `/` — match anything (incl. separators).
          regex += ".*";
        }
      } else {
        // `*` — match within a single segment.
        regex += "[^/]*";
        i++;
      }
    } else if (c === "?") {
      regex += "[^/]";
      i++;
    } else if (/[.+^${}()|[\]\\]/.test(c)) {
      regex += "\\" + c;
      i++;
    } else if (c === "/") {
      regex += "/";
      i++;
    } else {
      regex += c;
      i++;
    }
  }
  regex += "$";
  return new RegExp(regex, "i");
}

/** Flatten a `FileNode[]` tree into a list of workspace-relative file paths. */
function flattenFileTree(nodes: FileNode[], prefix = ""): string[] {
  const out: string[] = [];
  const stack: Array<{ nodes: FileNode[]; prefix: string }> = [{ nodes, prefix }];

  while (stack.length > 0) {
    const top = stack.pop()!;
    for (let i = top.nodes.length - 1; i >= 0; i--) {
      const n = top.nodes[i];
      const p = top.prefix ? `${top.prefix}/${n.name}` : n.name;
      if (n.type === "file") {
        out.push(p);
      }
      if (n.children && n.children.length > 0) {
        stack.push({ nodes: n.children, prefix: p });
      }
    }
  }

  return out;
}

/**
 * Finds workspace files matching a glob pattern within an optional subdirectory scope.
 * Returns up to 1000 sorted workspace-relative matches.
 */
export async function globWs(
  userId: string,
  wsName: string,
  pattern: string,
  subPath?: string,
  rootDir?: string,
): Promise<{ matches: string[]; pattern: string; path: string; count: number }> {
  if (!pattern || typeof pattern !== "string") {
    throw new Error("glob pattern must be a non-empty string.");
  }
  // Resolve an optional sub-path to scope the search to (still confined to the
  // workspace root via safePath). Empty / "." means search the whole ws.
  let rootRel = "";
  if (subPath && subPath.trim() && subPath.trim() !== ".") {
    const clean = subPath.trim().replace(/^\.?\//, "").replace(/\/+$/, "");
    if (clean.includes("..")) throw new Error("Invalid path.");
    // Verify the resolved subpath is within the workspace.
    const resolved = safePath(userId, wsName, clean, rootDir);
    if (!resolved) throw new Error("Invalid path.");
    rootRel = clean;
  }

  const re = globToRegex(pattern);

  // Single-file target: `path` may point at a file (not just a directory).
  // Match the glob against the file's workspace-relative path.
  const targetAbs = safePath(userId, wsName, rootRel || ".", rootDir);
  const targetStat = targetAbs ? await fs.stat(/* turbopackIgnore: true */ targetAbs).catch(() => null) : null;
  if (targetStat?.isFile() && targetAbs) {
    const matchPath = path.basename(targetAbs);
    const matches = re.test(matchPath) ? [matchPath] : [];
    return { matches, pattern, path: matchPath, count: matches.length };
  }

  const tree = await readTree(userId, wsName, 8, rootDir);
  const allPaths = flattenFileTree(tree);

  // If subPath is set, narrow the candidate list to paths under rootRel/.
  const prefix = rootRel ? rootRel + "/" : "";
  const matches: string[] = [];
  for (const p of allPaths) {
    if (prefix) {
      if (p === rootRel) continue; // subPath itself is a dir, not a file
      if (!p.startsWith(prefix)) continue;
    }
    // Match against path relative to the subPath prefix (or the whole path).
    const testPath = prefix ? p.slice(prefix.length) : p;
    if (re.test(testPath)) {
      matches.push(p);
      if (matches.length >= 1000) break;
    }
  }
  matches.sort((a, b) => a.localeCompare(b));
  return {
    matches,
    pattern,
    path: rootRel || ".",
    count: matches.length,
  };
}

export const DENIED_WRITE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".exe",
  ".bat",
  ".cmd",
  ".com",
  ".ps1",
  ".dll",
  ".scr",
  ".lnk",
]);

/** Return denied extension for `rel` (handling NTFS ADS suffixes), or null if allowed. */
export function deniedWriteExtension(rel: string): string | null {
  const noAds = rel.split("::")[0];
  const base = (noAds.split(/[\\/]/).pop() ?? noAds).replace(/[. ]+$/, "");
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return null;
  const ext = base.slice(dot).toLowerCase();
  return DENIED_WRITE_EXTENSIONS.has(ext) ? ext : null;
}

/** Throw when `rel` targets a denied executable extension. */
function assertWritableExtension(rel: string): void {
  const denied = deniedWriteExtension(rel);
  if (denied) {
    throw new Error(`Writing files with the "${denied}" extension is not allowed.`);
  }
}

/** Atomically write `content` to `abs` via a temp file in the same directory. */
async function atomicWriteFile(abs: string, content: string): Promise<void> {
  const tmp = `${abs}.hermos-tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await fs.writeFile(tmp, content, "utf8");
  try {
    // Preserve target's existing permissions mode across atomic rename.
    try {
      const existing = await fs.stat(abs);
      await fs.chmod(tmp, existing.mode).catch(() => {});
    } catch {
      // Target does not exist yet — nothing to preserve.
    }
    await fs.rename(tmp, abs);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
}

export async function writeFileWs(
  userId: string,
  wsName: string,
  rel: string,
  content: string,
  rootDir?: string,
): Promise<{ path: string; bytes: number }> {
  assertWritableExtension(rel);
  const abs = safePath(userId, wsName, rel, rootDir);
  if (!abs) throw new Error("Invalid path.");
  
  await ensureDir(path.dirname(abs));
  await atomicWriteFile(abs, content);
  return { path: rel, bytes: Buffer.byteLength(content, "utf8") };
}

/**
 * Applies a find/replace operation with exact substring and whitespace-normalized fallback matching.
 * Returns updated content and occurrence count.
 */
export function applyEditToContent(
  content: string,
  find: string,
  replace: string,
  replaceAll = false,
): { content: string; occurrences: number } {
  let occurrences = 0;

  if (content.includes(find)) {
    const updated = replaceAll
      ? content.split(find).reduce((acc: string, part: string, i: number) => {
          if (i === 0) return part;
          occurrences++;
          return acc + replace + part;
        }, "")
      : content.replace(find, () => {
          occurrences = 1;
          return replace;
        });
    return { content: updated, occurrences };
  }

  // Fallback: whitespace-insensitive match mapping stripped span to original indices.
  const findStripped = find.replace(/\s+/g, "");
  if (!findStripped) throw new Error("Text to find is empty.");
  // Build a stripped copy of the file and a map from stripped index →
  // original index.
  const strippedChars: string[] = [];
  const origIndex: number[] = [];
  for (let i = 0; i < content.length; i++) {
    if (/\s/.test(content[i])) continue;
    strippedChars.push(content[i]);
    origIndex.push(i);
  }
  const fileStripped = strippedChars.join("");
  const strippedStart = replaceAll ? 0 : fileStripped.indexOf(findStripped);
  if (strippedStart === -1) {
    // Not found via exact or whitespace-insensitive match.
    return { content, occurrences: 0 };
  }

  let updated: string;
  if (replaceAll) {
    let cursor = 0;
    let out = "";
    let lastOrigEnd = 0;
    let idx = fileStripped.indexOf(findStripped, cursor);
    while (idx !== -1) {
      const oStart = origIndex[idx];
      const oEnd = origIndex[idx + findStripped.length - 1] + 1;
      out += content.slice(lastOrigEnd, oStart) + replace;
      lastOrigEnd = oEnd;
      occurrences++;
      cursor = idx + findStripped.length;
      idx = fileStripped.indexOf(findStripped, cursor);
    }
    out += content.slice(lastOrigEnd);
    updated = out;
  } else {
    const oStart = origIndex[strippedStart];
    const oEnd = origIndex[strippedStart + findStripped.length - 1] + 1;
    updated = content.slice(0, oStart) + replace + content.slice(oEnd);
    occurrences = 1;
  }
  return { content: updated, occurrences };
}

/** In-place edit: replace first occurrence of `find` with `replace` in a file. */
export async function editFileWs(
  userId: string,
  wsName: string,
  rel: string,
  find: string,
  replace: string,
  replaceAll = false,
  rootDir?: string,
): Promise<{ path: string; occurrences: number }> {
  assertWritableExtension(rel);
  const abs = safePath(userId, wsName, rel, rootDir);
  if (!abs) throw new Error("Invalid path.");
  const original = await fs.readFile(/* turbopackIgnore: true */ abs, "utf8");
  const { content: updated, occurrences } = applyEditToContent(
    original,
    find,
    replace,
    replaceAll,
  );
  if (occurrences === 0) {
    throw new Error("Text to find not present in file.");
  }
  await atomicWriteFile(abs, updated);
  return { path: rel, occurrences };
}

/** Error thrown by `multiEditWs` containing the 0-based index of the failed edit. */
export class MultiEditError extends Error {
  index: number;
  constructor(message: string, index: number) {
    super(message);
    this.name = "MultiEditError";
    this.index = index;
  }
}

export interface MultiEditOp {
  find: string;
  replace: string;
  replaceAll?: boolean;
}

/**
 * Applies multiple find/replace edits to a file atomically in-memory before writing.
 * Throws `MultiEditError` if any edit fails without modifying the on-disk file.
 */
export async function multiEditWs(
  userId: string,
  wsName: string,
  rel: string,
  edits: MultiEditOp[],
  rootDir?: string,
): Promise<{
  path: string;
  occurrences: number[];
  totalOccurrences: number;
  oldContent: string;
  newContent: string;
}> {
  assertWritableExtension(rel);
  const abs = safePath(userId, wsName, rel, rootDir);
  if (!abs) throw new Error("Invalid path.");
  if (!Array.isArray(edits) || edits.length === 0) {
    throw new Error("multi_edit requires a non-empty `edits` array.");
  }
  const oldContent = await fs.readFile(/* turbopackIgnore: true */ abs, "utf8");
  let content = oldContent;
  const occurrences: number[] = [];
  let totalOccurrences = 0;
  for (let i = 0; i < edits.length; i++) {
    const e = edits[i];
    if (!e || typeof e.find !== "string" || typeof e.replace !== "string") {
      throw new MultiEditError(
        `Edit #${i + 1} of ${edits.length}: invalid edit shape (must have string \`find\` and \`replace\`).`,
        i,
      );
    }
    const r = applyEditToContent(content, e.find, e.replace, Boolean(e.replaceAll));
    if (r.occurrences === 0) {
      throw new MultiEditError(
        `Edit #${i + 1} of ${edits.length}: text to find not present in file (after previous edits were applied).`,
        i,
      );
    }
    content = r.content;
    occurrences.push(r.occurrences);
    totalOccurrences += r.occurrences;
  }
  // All edits succeeded — write the final content in one shot.
  await atomicWriteFile(abs, content);
  return {
    path: rel,
    occurrences,
    totalOccurrences,
    oldContent,
    newContent: content,
  };
}

export async function createFileWs(
  userId: string,
  wsName: string,
  rel: string,
  content = "",
  rootDir?: string,
): Promise<{ path: string; bytes: number }> {
  return writeFileWs(userId, wsName, rel, content, rootDir);
}

export async function deletePathWs(
  userId: string,
  wsName: string,
  rel: string,
  rootDir?: string,
): Promise<{ path: string; existed: boolean; deleted: boolean }> {
  const abs = safePath(userId, wsName, rel, rootDir);
  if (!abs) throw new Error("Invalid path.");
  const base = rootDir ?? path.join(userRoot(userId), wsName);
  if (abs === base) throw new Error("Cannot delete workspace root.");
  const existed = await fs.stat(/* turbopackIgnore: true */ abs).then(() => true).catch(() => false);
  if (!existed) {
    return { path: rel, existed: false, deleted: false };
  }
  await fs.rm(abs, { recursive: true, force: true });
  return { path: rel, existed: true, deleted: true };
}

export async function mkdirWs(
  userId: string,
  wsName: string,
  rel: string,
  rootDir?: string,
): Promise<{ path: string }> {
  const abs = safePath(userId, wsName, rel, rootDir);
  if (!abs) throw new Error("Invalid path.");
  await ensureDir(abs);
  return { path: rel };
}

export async function renamePathWs(
  userId: string,
  wsName: string,
  from: string,
  to: string,
  rootDir?: string,
): Promise<{ from: string; to: string }> {
  // Renaming INTO a denied executable extension is a write of that
  // extension (e.g. notes.txt -> evil.bat) — enforce the same deny-list.
  assertWritableExtension(to);
  const fromAbs = safePath(userId, wsName, from, rootDir);
  const toAbs = safePath(userId, wsName, to, rootDir);
  if (!fromAbs || !toAbs) throw new Error("Invalid path.");
  await ensureDir(path.dirname(toAbs));
  await fs.rename(fromAbs, toAbs);
  return { from, to };
}

// Real shell terminal execution (`powershell.exe` on Win, `/bin/sh` on POSIX)
// rooted at the active workspace with configurable timeouts and a 10MB output buffer cap.

const MAX_COMMAND_OUTPUT = 10 * 1024 * 1024; // 10MB per stream

function truncateOut(s: string): string {
  if (s.length <= MAX_COMMAND_OUTPUT) return s;
  return s.slice(0, MAX_COMMAND_OUTPUT) + "\n...[output truncated]\n";
}

export interface ExecResult extends TerminalResponse {
  cwd: string;
}

// Keyed by "userId:conversationId" so the agent can check/stop its own
// commands and the frontend can offer a stop button.

interface RunningCommand {
  process: ReturnType<typeof spawn>;
  startTime: number;
  command: string;
  stdout: string;
  stderr: string;
  execId?: string;
}

const runningCommands = new Map<string, RunningCommand>();
const activeConversationCommands = new Map<string, string>();
/** execIds killed via stopRunningCommand — their close must not re-inject a completion. */
const stoppedCommandExecs = new Set<string>();

function commandKey(userId: string, conversationId: string): string {
  const convKey = `${userId}:${conversationId}`;
  const activeId = activeConversationCommands.get(convKey);
  if (activeId && runningCommands.has(`${convKey}:${activeId}`)) {
    return `${convKey}:${activeId}`;
  }
  // Fall back to newest live command if active alias finished while older processes live.
  let newestKey: string | null = null;
  let newestStart = 0;
  for (const [key, entry] of runningCommands) {
    if (!key.startsWith(convKey + ":")) continue;
    if (entry.startTime > newestStart) {
      newestStart = entry.startTime;
      newestKey = key;
    }
  }
  return newestKey ?? convKey;
}

/** Register a running command so it can be checked or killed later. */
function registerCommand(
  userId: string,
  conversationId: string,
  proc: ReturnType<typeof spawn>,
  command: string,
  execId?: string,
): void {
  const convKey = `${userId}:${conversationId}`;
  const key = execId ? `${userId}:${conversationId}:${execId}` : convKey;
  if (execId) {
    activeConversationCommands.set(convKey, execId);
  }
  const entry: RunningCommand = { process: proc, startTime: Date.now(), command, stdout: "", stderr: "", execId };
  runningCommands.set(key, entry);
  runningCommands.set(convKey, entry);
}

/** Unregister a completed command, clearing aliases only if still pointing to this exec. */
function unregisterCommand(userId: string, conversationId: string, execId?: string): void {
  const convKey = `${userId}:${conversationId}`;
  if (execId) {
    runningCommands.delete(`${userId}:${conversationId}:${execId}`);
    if (activeConversationCommands.get(convKey) === execId) {
      activeConversationCommands.delete(convKey);
    }
    if (runningCommands.get(convKey)?.execId === execId) {
      runningCommands.delete(convKey);
    }
  } else {
    runningCommands.delete(convKey);
  }
}

/** Get the running command state (or null if none or finished). */
export function getRunningCommand(
  userId: string,
  conversationId: string,
): { command: string; elapsed: number; stdout: string; stderr: string } | null {
  const key = commandKey(userId, conversationId);
  const entry = runningCommands.get(key);
  if (!entry) return null;
  return {
    command: entry.command,
    elapsed: Date.now() - entry.startTime,
    stdout: truncateOut(entry.stdout),
    stderr: truncateOut(entry.stderr),
  };
}

interface CompletedCommand {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  completedAt: number;
  execId?: string;
}

/**
 * Completed background commands keyed by ID and conversation alias.
 * Delivers results directly to blocking waiters or background completion pollers.
 */
const completedCommands = new Map<string, CompletedCommand>();

/** Resolves completion waiters when a command finishes so blocking callers don't poll. */
const commandWaiters = new Map<string, Array<(c: CompletedCommand) => void>>();

function resolveCommandWaiters(
  userId: string,
  conversationId: string,
  completed: CompletedCommand,
  execId?: string,
): void {
  // Resolve waiters registered specifically for this command's own execution key.
  const ownKey = `${userId}:${conversationId}:${execId}`;
  const ownWaiters = commandWaiters.get(ownKey);
  if (ownWaiters) {
    commandWaiters.delete(ownKey);
    for (const resolve of ownWaiters) resolve(completed);
  }
  // Resolve legacy waiters keyed by bare conversation key if this command owns the alias.
  const convKey = `${userId}:${conversationId}`;
  if (activeConversationCommands.get(convKey) === execId) {
    const legacy = commandWaiters.get(convKey);
    if (legacy) {
      commandWaiters.delete(convKey);
      for (const resolve of legacy) resolve(completed);
    }
  }
}

/**
 * Waits for a running background command to finish up to `timeoutMs` (or resolves null on timeout/abort).
 */
export function waitForCommandCompletion(
  userId: string,
  conversationId: string,
  timeoutMs: number,
  signal?: AbortSignal,
  execId?: string,
): Promise<CompletedCommand | null> {
  // Target specific execId when provided, or fall back to current conversation alias owner.
  const key = execId ? `${userId}:${conversationId}:${execId}` : commandKey(userId, conversationId);
  const existing = completedCommands.get(key);
  if (existing) return Promise.resolve(existing);
  if (!runningCommands.has(key)) return Promise.resolve(null);

  return new Promise((resolve) => {
    const waiters = commandWaiters.get(key) ?? [];
    waiters.push(resolve);
    commandWaiters.set(key, waiters);

    let timer: ReturnType<typeof setTimeout> | null = null;
    let done = false;
    const settle = (value: CompletedCommand | null) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      const list = commandWaiters.get(key) ?? [];
      const idx = list.indexOf(resolve);
      if (idx !== -1) {
        list.splice(idx, 1);
        if (list.length === 0) commandWaiters.delete(key);
      }
      resolve(value);
    };
    const onAbort = () => settle(null);

    timer = setTimeout(() => settle(null), timeoutMs);
    timer.unref?.();
    if (signal) {
      if (signal.aborted) {
        settle(null);
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/** Build a minimal sanitized environment for spawned child processes with temp/truncation dirs. */
function buildEnv(isWin: boolean, cwd: string, tempDir?: string, truncationDir?: string): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = isWin
    ? {
        PATH: process.env.PATH ?? "C:\\Windows\\System32;C:\\Windows",
        SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
        PATHEXT: process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD;.VBS;.JS;.WSF;.MSC",
        // USERPROFILE/APPDATA: keep real host values for tool compatibility
        // (many Windows tools require them). The SSRF fix handles the actual
        // PII concern at the network boundary; here we preserve functionality.
        USERPROFILE: process.env.USERPROFILE ?? "",
        HOMEDRIVE: process.env.HOMEDRIVE ?? "C:",
        HOMEPATH: process.env.HOMEPATH ?? "\\",
        USERNAME: process.env.USERNAME ?? "hermos",
        TEMP: process.env.TEMP ?? "C:\\Windows\\Temp",
        TMP: process.env.TMP ?? "C:\\Windows\\Temp",
        APPDATA: process.env.APPDATA ?? "",
        LOCALAPPDATA: process.env.LOCALAPPDATA ?? "",
        ProgramFiles: process.env.ProgramFiles ?? "C:\\Program Files",
        "ProgramFiles(x86)": process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
        COMSPEC: process.env.COMSPEC ?? "C:\\Windows\\System32\\cmd.exe",
        SystemDrive: process.env.SystemDrive ?? "C:",
        LANG: "en_US.UTF-8",
        LC_ALL: "en_US.UTF-8",
        PYTHONIOENCODING: "utf-8",
        NODE_ENV: process.env.NODE_ENV ?? "production",
        HERMOS_TEMP_DIR: tempDir ?? "",
        HERMOS_TRUNCATION_DIR: truncationDir ?? "",
      }
    : {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: process.env.HOME ?? cwd,
        USER: process.env.USER ?? "hermos",
        LANG: "en_US.UTF-8",
        LC_ALL: "en_US.UTF-8",
        TERM: "xterm-256color",
        NODE_ENV: process.env.NODE_ENV ?? "production",
        HERMOS_TEMP_DIR: tempDir ?? "",
        HERMOS_TRUNCATION_DIR: truncationDir ?? "",
      };
  return base;
}

export interface CommandSafetyResult {
  ok: boolean;
  reason?: string;
  command?: string;
  cwd?: string;
}

/** Check if a cd target contains unverifiable shell expansions or wildcards. */
function hasShellExpansion(target: string, isWin: boolean): boolean {
  if (isWin) return /[%$*?`]/.test(target) || /^~([\\/]|$)/.test(target);
  return /[~$`]/.test(target); // ~ / $VAR / `command substitution`
}

/** Split a command on shell separators (&, |, ;) without breaking inside quotes. */
function splitCommandSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let inDouble = false;
  let inSingle = false;
  for (const ch of command) {
    if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === "'" && !inDouble) inSingle = !inSingle;
    if ((ch === ";" || ch === "|" || ch === "&") && !inDouble && !inSingle) {
      const seg = current.trim();
      if (seg) segments.push(seg);
      current = "";
      continue;
    }
    current += ch;
  }
  const last = current.trim();
  if (last) segments.push(last);
  return segments;
}

/** True when the path exists and is a directory. Stat failures (EACCES,
 *  race-deleted dirs) count as nonexistent so the sandbox never crashes. */
function isExistingDir(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Shell binary names that can launch nested subshells with inline command flags. */
const NESTED_SHELL_SPAWNERS = new Set([
  "cmd",
  "cmd.exe",
  "powershell",
  "powershell.exe",
  "pwsh",
  "pwsh.exe",
  "bash",
  "bash.exe",
  "sh",
  "sh.exe",
  "zsh",
  "zsh.exe",
  "fish",
  "fish.exe",
  "ksh",
  "ksh.exe",
  "dash",
  "dash.exe",
  "ash",
  "ash.exe",
  "tcsh",
  "tcsh.exe",
  "csh",
  "csh.exe",
  "busybox",
  "busybox.exe",
  "wsl",
  "wsl.exe",
  "start",
]);

/** PowerShell spawners whose inline verbs cannot be safely validated in subshells. */
const PS_SPAWNERS = new Set(["powershell", "powershell.exe", "pwsh", "pwsh.exe"]);

/** WSL spawners whose nested execution semantics cannot be safely verified. */
const WSL_SPAWNERS = new Set(["wsl", "wsl.exe"]);

/** Inline command execution flags in nested shells, including attached flag values. */
interface NestedShellFlag {
  /** cmd.exe family: the whole remainder after the flag is the command. */
  cmd: boolean;
  /** Inline value attached to the same token ("" when none). */
  value: string;
}

function nestedShellInline(token: string): NestedShellFlag | null {
  const low = token.toLowerCase();
  if (/^\/[ck]$/i.test(low)) return { cmd: true, value: "" };
  if (/^\/[ck].+$/i.test(low)) return { cmd: true, value: low.slice(2) };
  if (/^-(?:command|encodedcommand)$/i.test(low)) return { cmd: true, value: "" };
  // Attached form: PowerShell accepts `-Command"..."` with value attached to parameter name.
  const psFlagMatch = low.match(/^-(command|encodedcommand)(.+)$/i);
  if (psFlagMatch) {
    const name = psFlagMatch[1];
    return { cmd: true, value: low.slice(1 + name.length) };
  }
  if (/^\/command$/i.test(low)) return { cmd: true, value: "" };
  if (/^--(?:exec|command)(?:=.*)?$/i.test(low)) return { cmd: true, value: "" };
  if (/^-[a-z]*c$/.test(low)) return { cmd: false, value: "" };
  const ci = low.indexOf("c");
  if (ci > 0 && /^-[a-z]+$/.test(low.slice(0, ci + 1))) {
    return { cmd: false, value: low.slice(ci + 1) };
  }
  return null;
}

interface RawToken {
  /** Quote-stripped content. */
  text: string;
  /** Raw offset of the token start (may point at a leading quote). */
  start: number;
  /** Raw offset just past the token (including trailing quote chars). */
  end: number;
}

/** Quote-aware tokenizer returning quote-stripped tokens alongside raw character offsets. */
function splitRawTokens(segment: string): RawToken[] {
  const tokens: RawToken[] = [];
  let current = "";
  let start = -1;
  let inSingle = false;
  let inDouble = false;
  let i = 0;
  for (; i < segment.length; i++) {
    const ch = segment[i];
    if (ch === "'" && !inDouble) {
      if (start < 0) start = i;
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      if (start < 0) start = i;
      inDouble = !inDouble;
      continue;
    }
    if (/\s/.test(ch) && !inSingle && !inDouble) {
      if (current) {
        tokens.push({ text: current, start, end: i });
        current = "";
        start = -1;
      }
      continue;
    }
    if (start < 0) start = i;
    current += ch;
  }
  if (current) tokens.push({ text: current, start, end: i });
  return tokens;
}

/** Strip unquoted word-boundary `#` comments from shell command segments. */
function stripShellComment(segment: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === "#" && !inSingle && !inDouble && (i === 0 || /\s/.test(segment[i - 1]))) {
      return segment.slice(0, i);
    }
  }
  return segment;
}

/** Check if argument contains backslash-escaped quotes that alter path parsing. */
function hasEscapedQuotes(s: string): boolean {
  return /\\(["'`])/.test(s);
}

/** Resolve a path's real location; falls back to the lexical path when stat fails. */
function realPathOrFallback(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Command safety validator checking leading cd directory changes, subshell executions,
 * and path confinement before running commands in the active workspace.
 */
export function resolveCommandSafety(
  rawCommand: string,
  baseCwd: string,
  extraRoots: string[] = [],
): CommandSafetyResult {
  const command = (rawCommand || "").trim();
  if (!command) return { ok: true, command: "", cwd: baseCwd };
  // PS treats newline (CR, LF, or CRLF) as a statement separator — scan
  // each line independently so `cd C:\Windows\nnpm start` can't smuggle
  // its target into a nonexistent multi-line string.
  const lines = command.split(/\r\n|\r|\n/);
  if (lines.length > 1) {
    let cur = baseCwd;
    const parts: string[] = [];
    for (const ln of lines) {
      if (!ln.trim()) {
        parts.push(ln);
        continue;
      }
      const r = resolveCommandSafety(ln.trim(), cur, extraRoots);
      if (!r.ok) return r;
      cur = r.cwd ?? cur;
      parts.push(r.command ?? "");
    }
    return { ok: true, command: parts.join("\n"), cwd: cur };
  }
  const isWin = process.platform === "win32";
  let cwd = baseCwd;

  const refuse = (
    target: string,
    segment: string,
    kind: "escape" | "expansion" | "flag" | "bare",
  ): CommandSafetyResult => ({
    ok: false,
    reason:
      kind === "escape"
        ? `cd target escapes the workspace root or the agent temp dir: "${target}" (segment: "${segment}")`
        : kind === "flag"
          ? `cd target starts with a PowerShell parameter flag and cannot be verified: "${target}" (segment: "${segment}")`
          : kind === "expansion"
            ? `cd target contains unverifiable shell expansion characters: "${target}" (segment: "${segment}")`
            : `bare cd without a target would leave the workspace root (segment: "${segment}")`,
  });

  const refuseNestedShell = (segment: string): CommandSafetyResult => ({
    ok: false,
    reason: `nested shell with an execution flag (-c, -lc, -ic, -xc, -Command, -EncodedCommand, /c, /k) can escape the workspace root (segment: "${segment}")`,
  });

  let remaining = command;

  // cmd.exe alias: `chdir` IS `cd`. Normalize a LEADING chdir clause so the
  // leading-cd rules (1-3) apply to it too; mid-chain chdir is handled by
  // the segment scan below.
  if (isWin) remaining = remaining.replace(/^chdir(?=\s|["'])/i, "cd");

  // Resolve cd target against base: reject expansions and escapes beyond trusted roots.
  const resolveCdTarget = (
    target: string,
    segment: string,
    from: string,
  ): string | null | CommandSafetyResult => {
    if (hasShellExpansion(target, isWin)) {
      return refuse(target, segment, "expansion");
    }
    const resolved = path.resolve(from, target);
    if (!isExistingDir(resolved)) return null;
    const realResolved = realPathOrFallback(resolved);
    const trustedRoots = [realPathOrFallback(baseCwd), ...extraRoots.map((r) => realPathOrFallback(r))];
    if (!trustedRoots.some((r) => isSubpathOrEqual(realResolved, r))) {
      return refuse(target, segment, "escape");
    }
    return resolved;
  };

  // Leading cd clause (`cd <dir> ;|&& <rest>`, including Windows `cd /d` and attached quotes).
  const cdHead = isWin
    ? `cd(?=\\s|["'])(?:\\s+(?:\\/d\\s*"?\\s*)?)?`
    : `cd(?=\\s|["'])\\s*`;
  const cdTarget = `(?:"([^"]+)"|'([^']+)'|([^\\s;&]+))`;
  const leadingRe = new RegExp(`^${cdHead}${cdTarget}\\s*(?:;|&&)\\s*(.+)$`, "i");
  const leadingMatch = remaining.match(leadingRe);
  if (leadingMatch) {
    const targetRaw = leadingMatch[1] || leadingMatch[2] || leadingMatch[3] || "";
    if (hasEscapedQuotes(targetRaw)) {
      return refuse(targetRaw, remaining, "expansion");
    }
    // Reject unquoted leading dash on Windows (PowerShell parameter flag).
    if (isWin && targetRaw.startsWith("-") && !leadingMatch[1] && !leadingMatch[2]) {
      return refuse(targetRaw, remaining, "flag");
    }
    const target = targetRaw.replace(/["']/g, "");
    const rest = leadingMatch[4];
    if (target) {
      const resolved = resolveCdTarget(target, remaining, cwd);
      if (resolved && typeof resolved !== "string") return resolved;
      if (typeof resolved === "string") {
        cwd = resolved;
        remaining = rest.trim();
      }
      // Nonexistent target: keep the command as-is; the shell fails it
      // harmlessly (e.g. `cd missing && npm run dev` aborts at the cd).
    }
  }

  // Standalone `cd <dir>` (no continuation): resolve when it exists inside
  // the base (no-op token), refuse when it escapes.
  const standaloneRe = new RegExp(`^${cdHead}${cdTarget}\\s*$`, "i");
  const standaloneMatch = remaining.match(standaloneRe);
  if (standaloneMatch) {
    const targetRaw = standaloneMatch[1] || standaloneMatch[2] || standaloneMatch[3] || "";
    if (hasEscapedQuotes(targetRaw)) {
      return refuse(targetRaw, remaining, "expansion");
    }
    if (isWin && targetRaw.startsWith("-") && !standaloneMatch[1] && !standaloneMatch[2]) {
      return refuse(targetRaw, remaining, "flag");
    }
    const target = targetRaw.replace(/["']/g, "");
    if (target) {
      const resolved = resolveCdTarget(target, remaining, cwd);
      if (resolved && typeof resolved !== "string") return resolved;
      if (typeof resolved === "string") {
        cwd = resolved;
        remaining = isWin ? "cd" : ":";
      }
    }
  }

  // Rule 4/6 — mid-chain scan: validate every cd-family segment (`cd`,
  // Windows `pushd`/`chdir`, PowerShell `sl`/`set-location`/
  // `push-location`), and check nested shell spawners with an exec flag.
  let chainCwd = cwd;
  for (const rawSeg of splitCommandSegments(remaining)) {
    // Strip comments so hidden commands or bypasses aren't masked.
    const segment = stripShellComment(rawSeg);
    if (!segment) continue;
    const rawTokens = splitRawTokens(segment);
    // Strip POSIX env assignments and command prefixes to identify first-token verbs.
    let ti = 0;
    if (!isWin) {
      while (ti < rawTokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rawTokens[ti].text)) ti++;
      if (ti < rawTokens.length && /^(?:command|builtin|exec|time)$/i.test(rawTokens[ti].text)) ti++;
    }
    if (ti >= rawTokens.length) continue;
    const token = rawTokens[ti].text.toLowerCase();
    const gluedCd = isWin ? /^cd[.\\~]/.test(token) : false;
    // Check cd family verbs across POSIX, cmd, and PowerShell aliases.
    if (token !== "cd" && !gluedCd && !(isWin && (token === "pushd" || token === "chdir" || token === "sl" || token === "set-location" || token === "push-location"))) {
      // Check nested shell spawners followed by execution flags.
      const flagIdx = rawTokens.findIndex((t) => nestedShellInline(t.text) !== null);
      if (flagIdx >= 0) {
        const spawnerIdx = rawTokens.findIndex((t) => NESTED_SHELL_SPAWNERS.has(t.text.toLowerCase()));
        if (spawnerIdx >= 0 && spawnerIdx < flagIdx) {
          const spawner = rawTokens[spawnerIdx].text.toLowerCase();
          // PowerShell/WSL inline verbs (Set-Location, whole distro
          // shells) are outside the cd grammar — blanket-refuse.
          if (PS_SPAWNERS.has(spawner) || WSL_SPAWNERS.has(spawner)) {
            return refuseNestedShell(segment);
          }
          // Recursively validate inner commands executed via POSIX/cmd inline execution flags.
          const flag = nestedShellInline(rawTokens[flagIdx].text)!;
          if (flag.value.includes("\\")) return refuseNestedShell(segment);
          const restRaw = segment.slice(rawTokens[flagIdx].end).trim();
          // Backslash-escaped quotes would survive the quote strip as
          // stray backslashes and change the path — refuse (conservative).
          const innerRaw = (flag.value + (flag.value && restRaw ? " " : "") + restRaw).trim();
          if (hasEscapedQuotes(innerRaw)) return refuseNestedShell(segment);
          const inner = innerRaw.replace(/["']/g, "").trim();
          if (!inner) return refuseNestedShell(segment);
          // The inner shell shares this invocation's trusted roots (the
          // agent temp dir stays reachable from `bash -c "cd <temp>; ..."`).
          if (!resolveCommandSafety(inner, chainCwd, extraRoots).ok) {
            return refuseNestedShell(segment);
          }
        }
      }
      // WSL-only exec flag: `wsl -e` (single dash) is not in the generic
      // flag list (that would false-positive on `bash -e`).
      const wslIdx = rawTokens.findIndex((t) => WSL_SPAWNERS.has(t.text.toLowerCase()));
      if (wslIdx >= 0 && rawTokens.some((t, i) => i > wslIdx && /^-[e]$/i.test(t.text))) {
        return refuseNestedShell(segment);
      }
      // `start [/title] /D <dir> <app>` changes the child cwd without an
      // exec flag — verify its target like a cd target (the title precedes
      // `/D` in cmd.exe's canonical form, so scan any `start` before it).
      if (isWin) {
        const dIdx = rawTokens.findIndex((t) => /^\/d/i.test(t.text));
        if (dIdx >= 0 && rawTokens.slice(0, dIdx).some((t) => /^start$/i.test(t.text.toLowerCase()))) {
          const dGlued = rawTokens[dIdx].text.replace(/^\/d/i, "").replace(/["']/g, "").trim();
          const dNext = rawTokens[dIdx + 1]?.text.replace(/["']/g, "").trim() ?? "";
          const dTarget = dGlued || (dNext && !dNext.startsWith("/") ? dNext : "");
          if (dTarget) {
            const dResolved = resolveCdTarget(dTarget, segment, chainCwd);
            if (dResolved && typeof dResolved !== "string") return dResolved;
          }
        }
      }
      // PowerShell block wrappers (`(cd ..)`, `& { cd .. }`, `$(cd ..)`,
      // `{cd ..}`, `if (...) { cd .. }`) hide a cd where the scan can't
      // track its target — refuse them; `echo cd ..` stays an argument.
      // `{cd ...}` is refused too: it is byte-identical to the invoked
      // `& {cd ...}` after the `&` is consumed by splitting. `iex`/
      // `invoke-expression` (a full PS evaluator) and assignment positions
      // (`$x = cd ...`) are refused as well.
      if (isWin) {
        const plainFamily = (t: string): boolean => {
          const l = t.toLowerCase();
          return l === "cd" || l === "chdir" || l === "sl" || l === "set-location" || l === "pushd" || l === "push-location" || /^cd[.\\~]/.test(l);
        };
        const wrapPrev = /^(?:\{|\}|&|\.|=|if|else|while|foreach|for|do|try|catch|switch|trap|finally|filter|workflow)$/;
        for (let i = 0; i < rawTokens.length; i++) {
          const tok = rawTokens[i].text;
          const stripped = tok.replace(/^[.&${}@()]+/, "").toLowerCase();
          const prev = rawTokens[i - 1]?.text.toLowerCase() ?? "";
          if ((stripped === "iex" || stripped === "invoke-expression") && (i === 0 || wrapPrev.test(prev))) {
            return refuseNestedShell(segment);
          }
          if (/\{iex\b|\{invoke-expression\b/i.test(tok)) {
            return refuseNestedShell(segment);
          }
          if (/\{(?:cd|chdir|sl|set-location|pushd|push-location)/i.test(tok)) {
            return refuse(segment, segment, "escape");
          }
          if (!plainFamily(stripped)) continue;
          if (i === 0 && plainFamily(tok)) continue;
          const open = /^[@$(.&{}]/.test(tok) || /^\(+$/.test(prev);
          if (open || wrapPrev.test(prev)) {
            return refuse(segment, segment, "escape");
          }
        }
      }
      continue;
    }
    // Rest of the segment after the (prefix-stripped) token, raw-sliced so
    // quoted tokens (`"cd" C:\Windows`) keep their position, then stripped.
    let restRaw = segment.slice(rawTokens[ti].end).trim();
    // Win32 glued cd forms (`cd..`, `cd\`, `cd.\x`, `cd..\..\out`): PS
    // accepts the token remainder as the target.
    if (gluedCd) restRaw = token.slice(2);
    if (hasEscapedQuotes(restRaw)) {
      return refuse(restRaw, segment, "expansion");
    }
    if (isWin && /^-/.test(restRaw) && !/^["']/.test(restRaw)) {
      // Unquoted leading dash = PowerShell parameter (`sl -Path C:\Windows`,
      // `cd -LiteralPath ...`, abbreviations, unknown flags) — unverifiable.
      return refuse(restRaw, segment, "flag");
    }
    const rest = restRaw.replace(/["']/g, "").trim();
    let targetRaw = rest;
    if (isWin && (token === "cd" || token === "chdir")) {
      // The `/d` flag accepts zero whitespace + an attached quote
      // (`cd /d"C:\Windows"`).
      const flagMatch = rest.match(/^\/d\s*(.+)$/i);
      if (flagMatch) targetRaw = flagMatch[1];
    }
    // Strip quotes and trim target before path resolution.
    const target = targetRaw.replace(/["']/g, "").trim();
    if (!target) {
      // Bare cd (or quotes-only): Windows prints the cwd; POSIX goes to
      // $HOME (= escape).
      if (!isWin) return refuse("", segment, "bare");
      continue;
    }
    const resolved = resolveCdTarget(target, segment, chainCwd);
    if (resolved && typeof resolved !== "string") return resolved;
    if (typeof resolved === "string") {
      // Track the cwd through the chain so later relative cd targets are
      // resolved the way the shell would (against the dir we just cd'd to).
      chainCwd = resolved;
    } else if (resolved === null && isWin) {
      // Peel trailing PowerShell switches/redirects to detect escaping directory targets.
      const peelRest = rest.replace(/>\S*$/, "").trim();
      const words = peelRest.split(/\s+/);
      let cut = peelRest.length;
      for (let n = words.length - 1; n > 0; n--) {
        const dropped = words[n];
        const idx = peelRest.lastIndexOf(dropped, cut - 1);
        // `cut` points at the dropped word's START, so the next word may
        // end before it (whitespace gap) — only an overlap breaks the chain.
        if (idx < 0 || idx + dropped.length > cut) break;
        // Switch-VALUE words (`-PassThru`) aren't glue, but dropping them
        // re-adjacents the flag to their left so it gets peeled too.
        if (/(?:^-[a-z]|^\d{1,2}$)/i.test(dropped)) {
          const candidate = peelRest.slice(0, idx).trim();
          if (candidate) {
            const peeled = resolveCdTarget(candidate, segment, chainCwd);
            if (peeled && typeof peeled !== "string") return peeled;
          }
        }
        cut = idx;
      }
    }
  }

  return { ok: true, command: remaining, cwd };
}

/** Check deployment kill switch for terminal commands; returns reason if disabled, null if allowed. */
export function commandsDisabledMessage(): string | null {
  // Enabled by default on the local app; opt-out via HERMOS_ENABLE_COMMANDS=false.
  const v = process.env.HERMOS_ENABLE_COMMANDS;
  if (v === "true") return null;
  if (v === "false") {
    return "Terminal commands are disabled on this deployment (set HERMOS_ENABLE_COMMANDS=true to enable)";
  }
  return null;
}

/** Verify command cwd exists and stays inside trusted workspace/temp roots, preventing symlink escapes. */
function assertCwdInsideWorkspace(wsRoot: string, cwd: string, extraRoots: string[] = []): string | null {
  const roots = [wsRoot, ...extraRoots];
  if (!isExistingDir(cwd) || !roots.some((r) => isSubpathOrEqual(cwd, r))) {
    return `Command cwd is outside the workspace root or missing: ${cwd}`;
  }
  const realCwd = realPathOrFallback(cwd);
  const realRoots = roots.map((r) => realPathOrFallback(r));
  if (!realRoots.some((r) => isSubpathOrEqual(realCwd, r))) {
    return `Command cwd escapes the workspace root via a symlink: ${cwd}`;
  }
  return null;
}

/** Windows `-Command` wrapper: PREFIX pins UTF-8 (PS 5.1 otherwise
 * redirects UTF-16) and resets `$global:LASTEXITCODE`; SUFFIX propagates
 * the last native exit code and maps pure-cmdlet failures to 1 via `$?`. */
const PS_RUN_PREFIX =
  "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8; $PSDefaultParameterValues['Out-File:Encoding'] = 'utf8'; $global:LASTEXITCODE = 0; ";

const PS_RUN_SUFFIX =
  "\nif (-not $?) { if ($global:LASTEXITCODE -eq 0) { exit 1 } }; exit $global:LASTEXITCODE";

/** Wrap a command for `powershell.exe -Command`: strip bare `;` (an empty
 * `;;` is a PS 5.1 parse error) and start the suffix on its own line so a
 * trailing `#` comment can't swallow it. */
function psWrappedCommand(command: string): string {
  const stripped = command.replace(/;+\s*$/, "").replace(/^[\s;]+/, "");
  if (!stripped) return PS_RUN_PREFIX + PS_RUN_SUFFIX.replace(/^[\s;]+/, "");
  return PS_RUN_PREFIX + stripped + "\n" + PS_RUN_SUFFIX;
}

/** Start a background command non-blocking; poll or wait for output via `waitForCommandCompletion`. */
export function startBackgroundCommand(
  userId: string,
  conversationId: string,
  wsName: string,
  rawCommand: string,
  opts?: {
    onProgress?: (text: string) => void;
    rootDir?: string;
  },
): { ok: boolean; commandId: string; error?: string } {
  const disabled = commandsDisabledMessage();
  if (disabled) {
    return { ok: false, commandId: "", error: disabled };
  }
  // Container/microVM sandbox mode has no persistent process handle on the
  // host — background execution is unsupported there (use the foreground
  // terminal / runCommandWs path instead).
  if (getSandboxRunner().mode !== "local") {
    return {
      ok: false,
      commandId: "",
      error: "Background commands are unavailable in sandboxed (container) deployments. Run commands in the foreground terminal instead.",
    };
  }
  const initialCwd = opts?.rootDir ?? rootDirCache.get(`${userId}:${wsName}`) ?? path.join(userRoot(userId), wsName);
  const tempDir = ensureAgentTempDir(userId);
  const truncDir = truncationUserDir(userId);
  const safe = resolveCommandSafety(rawCommand, initialCwd, [tempDir]);
  if (!safe.ok) {
    return { ok: false, commandId: "", error: safe.reason ?? "Command refused by the sandbox." };
  }
  const command = safe.command ?? "";
  const cwd = safe.cwd ?? initialCwd;
  if (!command) return { ok: false, commandId: "", error: "Empty command." };
  const cwdError = assertCwdInsideWorkspace(initialCwd, cwd, [tempDir]);
  if (cwdError) {
    return { ok: false, commandId: "", error: cwdError };
  }

  // Built-in pseudo-commands (intercepted BEFORE spawning the shell so they
  // don't get interpreted by the platform shell) — mirrors runCommandWs so
  // the run_command tool's 'help' promise holds on the agent path too.
  if (/^help\s*$/.test(command)) {
    const execId = `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const helpCommandId = `${userId}:${conversationId}:${execId}`;
    const completed: CompletedCommand = {
      command: rawCommand,
      stdout: truncateOut(HELP_TEXT),
      stderr: "",
      exitCode: 0,
      completedAt: Date.now(),
      execId,
    };
    completedCommands.set(helpCommandId, completed);
    completedCommands.set(`${userId}:${conversationId}`, completed);
    resolveCommandWaiters(userId, conversationId, completed, execId);
    return { ok: true, commandId: helpCommandId };
  }

  const execId = `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const commandId = `${userId}:${conversationId}:${execId}`;
  const isWin = process.platform === "win32";

  const child = isWin
    ? spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", psWrappedCommand(command)], {
        cwd,
        env: buildEnv(isWin, cwd, tempDir, truncDir),
        windowsHide: true,
      })
    : spawn(command, [], {
        cwd,
        env: buildEnv(isWin, cwd, tempDir, truncDir),
        shell: "/bin/sh",
        windowsHide: true,
      });

  let stdout = "";
  let stderr = "";

  child.stdout?.on("data", (chunk: Buffer) => {
    const text = decodeBuffer(chunk);
    stdout += text;
    opts?.onProgress?.(text);
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    const text = decodeBuffer(chunk);
    stderr += text;
    opts?.onProgress?.(text);
  });

  registerCommand(userId, conversationId, child, rawCommand, execId);

  const cleanup = () => {
    unregisterCommand(userId, conversationId, execId);
  };

  child.on("close", (exitCode) => {
    const wasStopped = stoppedCommandExecs.delete(execId);
    const ownsAlias = activeConversationCommands.get(`${userId}:${conversationId}`) === execId;
    cleanup();
    const completed: CompletedCommand = {
      command: rawCommand,
      stdout,
      stderr,
      exitCode,
      completedAt: Date.now(),
      execId,
    };
    if (!wasStopped) {
      completedCommands.set(commandId, completed);
      if (ownsAlias) {
        completedCommands.set(`${userId}:${conversationId}`, completed);
      }
    }
    resolveCommandWaiters(userId, conversationId, completed, execId);
    evictCompletedCommands();
  });

  child.on("error", (err) => {
    const wasStopped = stoppedCommandExecs.delete(execId);
    const ownsAlias = activeConversationCommands.get(`${userId}:${conversationId}`) === execId;
    cleanup();
    const completed: CompletedCommand = {
      command: rawCommand,
      stdout,
      stderr: err.message,
      exitCode: null,
      completedAt: Date.now(),
      execId,
    };
    if (!wasStopped) {
      completedCommands.set(commandId, completed);
      if (ownsAlias) {
        completedCommands.set(`${userId}:${conversationId}`, completed);
      }
    }
    resolveCommandWaiters(userId, conversationId, completed, execId);
    evictCompletedCommands();
  });

  return { ok: true, commandId };
}

/** Evict oldest completed commands when exceeding capacity limit. */
const MAX_COMPLETED_COMMANDS = 100;

function evictCompletedCommands(): void {
  if (completedCommands.size <= MAX_COMPLETED_COMMANDS) return;
  const entries = Array.from(completedCommands.entries())
    .sort(([, a], [, b]) => (a.completedAt ?? 0) - (b.completedAt ?? 0));
  const toRemove = entries.length - MAX_COMPLETED_COMMANDS;
  for (let i = 0; i < toRemove; i++) {
    completedCommands.delete(entries[i][0]);
  }
}

/** Resolve conversation key for completed commands, prioritizing alias then newest exec entry. */
function completedCommandKey(userId: string, conversationId: string): string {
  const convKey = `${userId}:${conversationId}`;
  if (completedCommands.has(convKey)) return convKey;
  let newestKey: string | null = null;
  let newestAt = 0;
  for (const [key, entry] of completedCommands) {
    if (!key.startsWith(convKey + ":")) continue;
    if ((entry.completedAt ?? 0) > newestAt) {
      newestAt = entry.completedAt ?? 0;
      newestKey = key;
    }
  }
  return newestKey ?? convKey;
}

/** Check if a background command has completed and return its output. */
export function getCompletedCommand(
  userId: string,
  conversationId: string,
): CompletedCommand | null {
  const key = completedCommandKey(userId, conversationId);
  return completedCommands.get(key) ?? null;
}

/** Remove consumed command result from both conversation alias and exec-keyed maps. */
export function acknowledgeCompletedCommand(
  userId: string,
  conversationId: string,
  execId?: string,
): void {
  const convKey = `${userId}:${conversationId}`;
  const key = execId ? `${convKey}:${execId}` : completedCommandKey(userId, conversationId);
  const entry = completedCommands.get(key);
  if (!entry) return;
  completedCommands.delete(key);
  if (key !== convKey && entry.execId) {
    // The alias may still hold a different (newer) completion — remove it
    // only when it is the twin of the acknowledged entry.
    if (completedCommands.get(convKey)?.execId === entry.execId) {
      completedCommands.delete(convKey);
    }
  } else if (key === convKey && entry.execId) {
    completedCommands.delete(`${convKey}:${entry.execId}`);
  }
}

/** Kill active or newest running command for a conversation. */
export function stopRunningCommand(userId: string, conversationId: string): boolean {
  const convKey = `${userId}:${conversationId}`;
  const key = commandKey(userId, conversationId);
  const entry = runningCommands.get(key);
  if (!entry) return false;
  if (entry.execId) {
    stoppedCommandExecs.add(entry.execId);
    // A stopped process that never emits 'close' would leak its execId
    // forever — cap the set FIFO so memory stays bounded regardless.
    if (stoppedCommandExecs.size > 256) {
      const oldest = stoppedCommandExecs.values().next().value;
      if (oldest !== undefined) stoppedCommandExecs.delete(oldest);
    }
  }
  try {
    const isWin = process.platform === "win32";
    const child = entry.process;
    // PID-reuse safety: don't taskkill a PID that no longer belongs to this
    // child. If the handle already shows exited/killed, the OS may have
    // recycled the numeric PID to an unrelated process.
    if (child.killed || child.exitCode !== null) {
      // Already dead — nothing to kill; avoids PID-reuse race.
    } else if (isWin && child.pid) {
      try {
        execSync(`taskkill /F /T /PID ${child.pid}`, { stdio: "ignore" });
      } catch {
        try {
          child.kill();
        } catch {}
      }
    } else {
      try {
        child.kill("SIGKILL");
      } catch {}
    }
  } catch {
    /* process already exited or killed */
  }
  if (entry.execId) {
    runningCommands.delete(`${convKey}:${entry.execId}`);
  }
  // Remove the conversation alias only when it still points at this entry —
  // a newer command may have taken it over.
  if (runningCommands.get(convKey) === entry) {
    runningCommands.delete(convKey);
  }
  if (entry.execId && activeConversationCommands.get(convKey) === entry.execId) {
    activeConversationCommands.delete(convKey);
  }
  return true;
}

/** Clear completed command output for a conversation. */
export function clearCompletedCommand(userId: string, conversationId: string): void {
  const convKey = `${userId}:${conversationId}`;
  const key = completedCommandKey(userId, conversationId);
  const entry = completedCommands.get(key);
  if (!entry) return;
  completedCommands.delete(key);
  if (key !== convKey && entry.execId && completedCommands.get(convKey)?.execId === entry.execId) {
    completedCommands.delete(convKey);
  } else if (key === convKey && entry.execId) {
    completedCommands.delete(`${convKey}:${entry.execId}`);
  }
}

export async function runCommandWs(
  userId: string,
  wsName: string,
  rawCommand: string,
  opts?: {
    signal?: AbortSignal;
    conversationId?: string;
    /** Called with each stdout/stderr chunk for real-time progress. */
    onProgress?: (chunk: string) => void;
  },
): Promise<ExecResult> {
  const initialCwd = await resolveRootDir(userId, wsName);
  const tempDir = ensureAgentTempDir(userId);
  const truncDir = truncationUserDir(userId);
  const disabled = commandsDisabledMessage();
  if (disabled) {
    return {
      ok: false,
      blocked: true,
      reason: disabled,
      stdout: "",
      stderr: disabled + "\n",
      exitCode: 126,
      command: rawCommand,
      cwd: initialCwd,
    };
  }
  const safe = resolveCommandSafety(rawCommand, initialCwd, [tempDir]);
  if (!safe.ok) {
    const reason = safe.reason ?? "Command refused by the sandbox.";
    return {
      ok: false,
      blocked: true,
      reason,
      stdout: "",
      stderr: reason + "\n",
      exitCode: 126,
      command: rawCommand,
      cwd: initialCwd,
    };
  }
  const command = safe.command ?? "";
  const cwd = safe.cwd ?? initialCwd;
  if (!command) {
    return {
      ok: false,
      blocked: true,
      reason: "Empty command.",
      stdout: "",
      stderr: "Empty command.\n",
      exitCode: 126,
      command: rawCommand,
      cwd,
    };
  }
  const cwdError = assertCwdInsideWorkspace(initialCwd, cwd, [tempDir]);
  if (cwdError) {
    return {
      ok: false,
      blocked: true,
      reason: cwdError,
      stdout: "",
      stderr: cwdError + "\n",
      exitCode: 126,
      command: rawCommand,
      cwd,
    };
  }
  // No command length limit — let the agent run any command.

  // Built-in pseudo-commands (intercepted BEFORE spawning the shell so they
  // don't get interpreted by the platform shell).
  if (command === "help" || command === "help " || /^help\s*$/.test(command)) {
    return {
      ok: true,
      stdout: truncateOut(HELP_TEXT),
      stderr: "",
      exitCode: 0,
      command: rawCommand,
      cwd,
    };
  }
  if (command === "clear" || /^clear\s*$/.test(command)) {
    return {
      ok: true,
      stdout: "\x1b[2J\x1b[H",
      stderr: "",
      exitCode: 0,
      command: rawCommand,
      cwd,
    };
  }
  // Treat bare `cd <dir>` as no-op success since shell builtins do not persist across spawns.
  if (/^cd(\s|$)/.test(command)) {
    return {
      ok: true,
      stdout: "",
      stderr: "",
      exitCode: 0,
      command: rawCommand,
      cwd,
    };
  }

  // Cloud/sandboxed execution (Model B): dispatch to the per-tenant container
  // worker instead of spawning on the host. Fail closed when the worker is
  // unreachable so commands never silently fall back to host execution.
  const isWin = process.platform === "win32";
  const runner = getSandboxRunner();
  if (runner.mode !== "local") {
    if (!(await runner.isAvailable())) {
      const reason =
        "Command execution is unavailable: the sandbox runner is not reachable. " +
        "Configure HERMOS_SANDBOX_URL (and HERMOS_SANDBOX_API_KEY) for the container worker.";
      return {
        ok: false,
        blocked: true,
        reason,
        stdout: "",
        stderr: reason + "\n",
        exitCode: 126,
        command: rawCommand,
        cwd,
      };
    }
    const containerResult = await runner.executeCommand(
      {
        userId,
        conversationId: opts?.conversationId,
        workspaceName: wsName,
        command,
        cwd,
        env: buildEnv(isWin, cwd, tempDir, truncDir),
        timeoutMs: Number(process.env.CMD_TIMEOUT_MS) || 30 * 60 * 1000,
        signal: opts?.signal,
      },
      opts?.onProgress,
    );
    return {
      ok: containerResult.ok,
      blocked: false,
      reason: containerResult.error,
      stdout: truncateOut(containerResult.stdout),
      stderr: truncateOut(containerResult.stderr),
      exitCode: containerResult.exitCode,
      command: rawCommand,
      cwd,
    };
  }

  // Execute via platform shell with bounded environment and hard timeout.
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const env = buildEnv(isWin, cwd, tempDir, truncDir);

    // If an AbortSignal was provided, wire it up to kill the child.
    // PID-reuse-safe: verify handle liveness, but keep taskkill /F /T as
    // primary on Windows to ensure the full process tree is reaped.
    const cleanupAbort = opts?.signal
      ? () => {
          try {
            if (!child || child.killed || child.exitCode !== null) return;
            if (isWin && child.pid) {
              try { execSync(`taskkill /F /T /PID ${child.pid}`, { stdio: "ignore" }); } catch { try { child.kill(); } catch {} }
            } else {
              try { child.kill("SIGKILL"); } catch {}
            }
          } catch { /* already dead */ }
        }
      : undefined;
    if (opts?.signal && cleanupAbort) {
      if (opts.signal.aborted) {
        return resolve({
          ok: false, blocked: false, reason: "Aborted before start.",
          stdout: "", stderr: "", exitCode: 124, command: rawCommand, cwd,
        });
      }
      opts.signal.addEventListener("abort", cleanupAbort, { once: true });
    }

    let child: ReturnType<typeof spawn>;
    let timedOut = false;
    try {
      child = isWin
        ? spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", psWrappedCommand(command)], {
            cwd,
            env,
            windowsHide: true,
          })
        : spawn(command, [], {
            cwd,
            env,
            shell: "/bin/sh",
            windowsHide: true,
          });
    } catch (e) {
      if (opts?.signal && cleanupAbort) opts.signal.removeEventListener("abort", cleanupAbort);
      resolve({
        ok: false,
        blocked: false,
        reason: e instanceof Error ? e.message : "Failed to spawn.",
        stdout: "",
        stderr: `spawn failed: ${command.slice(0, 80)}\n`,
        exitCode: 127,
        command: rawCommand,
        cwd,
      });
      return;
    }

    // Hard kill timer (env-overridable CMD_TIMEOUT_MS, default 30 min): a
    // hung process (e.g. `sleep 3600`) must not pin the promise forever. The
    // resolve gets exitCode 124 below via the timedOut flag.
    const timeoutMs = Number(process.env.CMD_TIMEOUT_MS) || 30 * 60 * 1000;
    const killTimer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.killed || child.exitCode !== null) {
          // Already dead — avoid PID-reuse race where taskkill could hit recycled PID.
        } else if (isWin && child.pid) {
          try { execSync(`taskkill /F /T /PID ${child.pid}`, { stdio: "ignore" }); } catch { try { child.kill(); } catch {} }
        } else {
          try { child.kill("SIGKILL"); } catch {}
        }
      } catch {
        /* already dead */
      }
    }, timeoutMs);
    killTimer.unref?.();

    // Track in the runningCommands registry for check/stop support.
    if (opts?.conversationId) {
      registerCommand(userId, opts.conversationId, child, rawCommand);
      // Update stdout/stderr incrementally so getRunningCommand returns current state.
      child.stdout?.removeAllListeners("data");
      child.stderr?.removeAllListeners("data");
      child.stdout?.on("data", (d: Buffer) => {
        const text = decodeBuffer(d);
        stdout += text;
        const entry = runningCommands.get(commandKey(userId, opts.conversationId!));
        if (entry) entry.stdout += text;
        opts?.onProgress?.(text);
      });
      child.stderr?.on("data", (d: Buffer) => {
        const text = decodeBuffer(d);
        stderr += text;
        const entry = runningCommands.get(commandKey(userId, opts.conversationId!));
        if (entry) entry.stderr += text;
        opts?.onProgress?.(text);
      });
    } else {
      child.stdout?.on("data", (d: Buffer) => {
        const text = decodeBuffer(d);
        stdout += text;
        opts?.onProgress?.(text);
      });
      child.stderr?.on("data", (d: Buffer) => {
        const text = decodeBuffer(d);
        stderr += text;
        opts?.onProgress?.(text);
      });
    }

    child.on("error", (err) => {
      clearTimeout(killTimer);
      if (opts?.conversationId) unregisterCommand(userId, opts.conversationId);
      if (opts?.signal && cleanupAbort) opts.signal.removeEventListener("abort", cleanupAbort);
      resolve({
        ok: false,
        blocked: false,
        reason: err.message,
        stdout: truncateOut(stdout),
        stderr: truncateOut(stderr) + `\n${err.message}\n`,
        exitCode: 127,
        command: rawCommand,
        cwd,
      });
    });
    child.on("close", (code) => {
      clearTimeout(killTimer);
      if (opts?.conversationId) unregisterCommand(userId, opts.conversationId);
      if (opts?.signal && cleanupAbort) opts.signal.removeEventListener("abort", cleanupAbort);
      if (timedOut) {
        resolve({
          ok: false,
          blocked: false,
          reason: `Command timed out after ${timeoutMs} ms.`,
          stdout: truncateOut(stdout),
          stderr: truncateOut(stderr) + `\n[Command timed out after ${timeoutMs} ms]\n`,
          exitCode: 124,
          command: rawCommand,
          cwd,
        });
        return;
      }
      resolve({
        ok: code === 0,
        blocked: false,
        stdout: truncateOut(stdout),
        stderr: truncateOut(stderr),
        exitCode: code ?? 1,
        command: rawCommand,
        cwd,
      });
    });
  });
}

export interface GrepMatch {
  path: string; // relative to workspace root
  line: number; // 1-based
  column: number; // 1-based
  preview: string; // the matching line, trimmed to ≤200 chars
  matchStart: number; // char index in preview where match starts
  matchEnd: number; // char index in preview where match ends
}

// Binary file extensions to skip when scanning content. We can't read these as
// UTF-8 and they'd produce noise / huge false-positive matches.
const BINARY_EXTS = new Set([
  "png", "jpg", "jpeg", "gif", "bmp", "ico", "webp", "tiff", "tif", "svgz",
  "mp3", "mp4", "wav", "avi", "mov", "mkv", "flv", "webm", "ogg", "aac",
  "pdf", "zip", "tar", "gz", "tgz", "rar", "7z", "bz2", "xz", "zst",
  "exe", "dll", "so", "bin", "dylib", "o", "a",
  "class", "jar", "war", "ear",
  "db", "sqlite", "sqlite3",
  "woff", "woff2", "ttf", "otf", "eot",
  "node", "wasm", "pyc", "pyo",
  "lockb",
]);

// Directories we never descend into — they're either noise (deps, build
// artifacts) or expensive.
const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build", ".turbo", ".cache"]);

const MAX_FILE_BYTES = 1_000_000; // 1 MB

function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot === -1) return "";
  return name.slice(dot + 1).toLowerCase();
}

// Note: globToRegex is defined and exported above.

function buildPreview(
  line: string,
  matchIdx: number, // 0-based match index in the ORIGINAL line
  matchLen: number,
): { preview: string; matchStart: number; matchEnd: number } | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  // Rebase the match index onto the trimmed line (leading whitespace removed).
  const leading = line.length - trimmed.length;
  const idx = Math.max(0, matchIdx - leading);
  if (matchLen <= 0 || idx >= trimmed.length) return null;
  const clampedLen = Math.min(matchLen, trimmed.length - idx);

  // Most lines fit comfortably in 200 chars — use them as-is.
  const MAX = 200;
  if (trimmed.length <= MAX) {
    return { preview: trimmed, matchStart: idx, matchEnd: idx + clampedLen };
  }

  // Long line: carve a window around the match so the highlighted span is
  // always visible. Reserve up to 60 chars before the match for context.
  const MAX_SLICE = MAX - 2; // leave room for leading/trailing ellipsis
  const before = Math.min(60, idx);
  let start = idx - before;
  let end = start + MAX_SLICE;
  if (end > trimmed.length) {
    end = trimmed.length;
    start = Math.max(0, end - MAX_SLICE);
  }
  const slice = trimmed.slice(start, end);
  let matchStart = idx - start;
  let matchEnd = matchStart + clampedLen;
  let preview = slice;
  if (start > 0) {
    preview = "…" + preview;
    matchStart += 1;
    matchEnd += 1;
  }
  if (end < trimmed.length) {
    preview = preview + "…";
  }
  return { preview, matchStart, matchEnd };
}

/** Match one line of source text and produce a preview + highlight span (regex or literal). */
function matchLine(
  line: string,
  patternRe: RegExp | null,
  queryLower: string | null,
): { preview: string; matchStart: number; matchEnd: number; rawIdx: number } | null {
  if (patternRe) {
    patternRe.lastIndex = 0; // defensive — caller regexes are non-global
    const m = patternRe.exec(line);
    if (!m || m[0].length === 0) return null;
    const built = buildPreview(line, m.index, m[0].length);
    return built ? { ...built, rawIdx: m.index } : null;
  }
  if (!queryLower) return null;
  const origIdx = line.toLowerCase().indexOf(queryLower);
  if (origIdx === -1) return null;
  const built = buildPreview(line, origIdx, queryLower.length);
  return built ? { ...built, rawIdx: origIdx } : null;
}

/**
 * Searches file contents across workspace for text or regex patterns (in-process grep).
 * Respects file size limits, excludes binary/ignored directories, and returns up to `maxResults` matches.
 */
export async function grepWorkspace(
  userId: string,
  wsName: string,
  query: string,
  opts?: { maxResults?: number; filePattern?: string; subPath?: string; rootDir?: string; regex?: RegExp },
): Promise<GrepMatch[]> {
  const q = (query || "").trim();
  if (q.length < 1 || q.length > 200) {
    throw new Error("Query must be 1–200 characters.");
  }
  const maxResults = Math.max(1, Math.min(200, opts?.maxResults ?? 100));
  const patternRe = opts?.regex ?? null;

  // Resolve an optional sub-path to scope the search to (still confined to
  // the workspace root via safePath). Empty / "." means search the whole ws.
  let searchRootAbs: string;
  let subPathRel: string; // sub-path relative to the workspace root, no leading/trailing slash
  if (opts?.subPath && opts.subPath.trim() && opts.subPath.trim() !== ".") {
    const resolved = safePath(userId, wsName, opts.subPath, opts.rootDir);
    if (!resolved) throw new Error("Invalid search path.");
    searchRootAbs = resolved;
    subPathRel = opts.subPath
      .trim()
      .replace(/^\.?\//, "")
      .replace(/\/+$/, "");
    if (subPathRel.includes("..")) throw new Error("Invalid search path.");
  } else {
    const resolvedRoot = safePath(userId, wsName, ".", opts?.rootDir);
    if (!resolvedRoot) throw new Error("Invalid search path.");
    searchRootAbs = resolvedRoot;
    subPathRel = "";
  }
  if (!existsSync(/* turbopackIgnore: true */ searchRootAbs)) return [];

  let globRe: RegExp | null = null;
  if (opts?.filePattern && opts.filePattern.trim()) {
    globRe = globToRegex(opts.filePattern.trim());
  }

  const queryLower = q.toLowerCase();
  const matches: GrepMatch[] = [];

  // Prepend the sub-path prefix (if any) so the returned `path` is always
  // relative to the workspace root, as the GrepMatch contract requires.
  const toWsRel = (rel: string): string =>
    subPathRel ? (rel ? `${subPathRel}/${rel}` : subPathRel) : rel;

  // Single-file target: `subPath` may point at a file — search it alone.
  const rootStat = await fs.stat(/* turbopackIgnore: true */ searchRootAbs).catch(() => null);
  if (rootStat?.isFile()) {
    if (rootStat.size > MAX_FILE_BYTES) return [];
    if (globRe && !globRe.test(path.basename(searchRootAbs))) return [];
    // Same binary guard as the directory branch: a binary file read as
    // UTF-8 produces replacement chars that a regex like `.*` can match.
    if (BINARY_EXTS.has(fileExtension(path.basename(searchRootAbs)))) return [];
    let content: string;
    try {
      content = await fs.readFile(/* turbopackIgnore: true */ searchRootAbs, "utf8");
    } catch {
      return []; // not valid UTF-8 or vanished — no matches
    }
    const lines = content.split("\n");
    for (let i = 0; i < lines.length && matches.length < maxResults; i++) {
      const built = matchLine(lines[i], patternRe, patternRe ? null : queryLower);
      if (!built) continue;
      matches.push({
        path: subPathRel || path.basename(searchRootAbs),
        line: i + 1,
        column: built.rawIdx + 1,
        preview: built.preview,
        matchStart: built.matchStart,
        matchEnd: built.matchEnd,
      });
    }
    return matches;
  }

  // Breadth-first traversal keeps memory bounded and produces results roughly
  // in directory order, which is friendlier for incremental rendering.
  const stack: Array<{ abs: string; rel: string }> = [{ abs: searchRootAbs, rel: "" }];
  while (stack.length > 0 && matches.length < maxResults) {
    const { abs, rel } = stack.shift()!;
    let entries: import("fs").Dirent[];
    try {
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch {
      continue; // permission error or vanished — skip silently
    }
    for (const entry of entries) {
      if (matches.length >= maxResults) break;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        stack.push({
          abs: path.join(abs, entry.name),
          rel: rel ? `${rel}/${entry.name}` : entry.name,
        });
        continue;
      }
      if (!entry.isFile()) continue;
      if (globRe && !globRe.test(entry.name)) continue;
      const ext = fileExtension(entry.name);
      if (BINARY_EXTS.has(ext)) continue;

      // Stat once to enforce the size cap before reading.
      let stat;
      try {
        stat = await fs.stat(path.join(abs, entry.name));
      } catch {
        continue;
      }
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;

      let content: string;
      try {
        content = await fs.readFile(path.join(abs, entry.name), "utf8");
      } catch {
        continue; // not valid UTF-8 or vanished — skip
      }
      const fileRel = toWsRel(rel ? `${rel}/${entry.name}` : entry.name);

      // Split into lines without keeping the trailing newline. We use a
      // simple split on \n; we don't normalize \r\n but the trim in
      // buildPreview handles stray \r.
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (matches.length >= maxResults) break;
        const built = matchLine(lines[i], patternRe, patternRe ? null : queryLower);
        if (!built) continue;
        matches.push({
          path: fileRel,
          line: i + 1,
          column: built.rawIdx + 1,
          preview: built.preview,
          matchStart: built.matchStart,
          matchEnd: built.matchEnd,
        });
      }
    }
  }

  return matches;
}

const HELP_TEXT = [
  "HermOS workspace terminal — a REAL shell running in the open folder.",
  "",
  "ALL commands are allowed. On POSIX the command runs through /bin/sh -c",
  "\"...\"; on Windows it runs through PowerShell (powershell.exe) with",
  "native PowerShell syntax: Test-Path, $env:VAR, Get-ChildItem.",
  "",
  "POSIX shell features: pipes |, redirects > >> <, command substitution",
  "$(...) and backticks, chaining && || ;, env vars $FOO, globbing *.ts,",
  "job control &, subshells (...).",
  "",
  "Windows (PowerShell 5.1) notes:",
  "  - Statements chain with ';' (&& and || are NOT supported in PS 5.1;",
  "    the parser errors on them — use ';' instead).",
  "  - Env vars use $env:NAME (e.g. $env:PATH).",
  "  - Use Test-Path/Get-ChildItem/Select-Object instead of ls/cat/grep.",
  "  - Output is UTF-8 (PYTHONIOENCODING=utf-8, LANG=en_US.UTF-8 set).",
  "",
  "Examples:",
  "  ls -la",
  "  cat src/index.ts | head -20",
  "  grep -rn \"TODO\" src/ > todos.txt",
  "  npm install; npm test",
  "  node -e 'console.log(1+1)'",
  "  python3 -c 'print(\"hi\")'",
  "  echo $HOME",
  "  find . -name '*.ts' | xargs wc -l",
  "",
  "Notes:",
  "  - cwd is the workspace root (use 'cd <dir>; <cmd>' for sub-dirs;",
  "    bare 'cd' is a no-op since each command is a fresh shell process).",
  "  - Bounded env (no host-secret leakage). HERMOS_TEMP_DIR points at the",
  "    per-user agent scratch dir, e.g. to run a temp script:",
  "      node $env:HERMOS_TEMP_DIR/script.js   (Windows)",
  "      node \"$HERMOS_TEMP_DIR/script.js\"    (POSIX)",
  "    You may read/write files there (Read/Write tools accept absolute",
  "    paths under it). To cd into it, use the literal path (shell",
  "    expansion in cd targets is refused by the sandbox).",
  "  - Truncated tool outputs are saved under HERMOS_TRUNCATION_DIR; Read/",
  "    Grep accept the absolute paths returned in truncationPath hints.",
  "",
].join("\n");
