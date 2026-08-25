"use client";

/**
 * Workspace panel — shared types, query keys, and typed API helpers.
 *
 * These helpers wrap the workspace REST endpoints (all relative paths, all
 * cookie-authenticated). The standard envelope is unwrapped here so callers
 * receive the inner payload directly. `ApiRequestError` is re-thrown for the
 * caller to handle.
 */

import { apiGet, apiPost, apiDelete, ApiRequestError } from "@/lib/api-client";
import type { TerminalResponse } from "@/lib/types";

// Types — mirror the server-side contract from src/lib/workspace.ts

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
  rootDir?: string;
  isActive: boolean;
}

export interface WorkspaceFile {
  path: string;
  content: string;
  size: number;
  /**
   * Set to true when the backend truncated a large file's content (the
   * default GET returns only the first 500 lines for files >500 lines).
   * When true, `totalLines` indicates the full file's line count.
   */
  truncated?: boolean;
  /** Total line count of the underlying file (set when truncated or range-read). */
  totalLines?: number;
  /** First line of the returned range (1-based, inclusive). Set on range reads. */
  startLine?: number;
  /** Last line of the returned range (1-based, inclusive). Set on range reads. */
  endLine?: number;
}

export interface CommandResult extends TerminalResponse {
  cwd: string;
}

// Query keys

export const workspaceKeys = {
  all: ["workspace"] as const,
  info: ["workspace", "info"] as const,
  tree: ["workspace", "tree"] as const,
  list: ["workspace", "list"] as const,
  /** Default file-content query (no range). */
  file: (path: string) => ["workspace", "file", path] as const,
  /** Range-read query for a file (startLine/endLine inclusive, 1-based). */
  fileRange: (path: string, start: number, end: number) =>
    ["workspace", "file-range", path, start, end] as const,
};

/* ------------------------------------------------------------------ *
 * Format-file helpers (POST /api/workspace/format)
 * ------------------------------------------------------------------ */

/** File extensions supported by the lightweight formatter. */
const FORMATTABLE_EXTS = new Set([
  ".json",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".css",
  ".md",
]);

/** Return true if the path's extension is supported by the formatter. */
export function isFormattablePath(path: string): boolean {
  const lower = path.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot < 0) return false;
  return FORMATTABLE_EXTS.has(lower.slice(dot));
}

/** Shape returned by POST /api/workspace/format when changes are proposed. */
export interface FormatResult {
  ok: boolean;
  path: string;
  unchanged?: boolean;
  oldContent?: string;
  newContent?: string;
  diff?: Array<{ type: string; oldNo: number | null; newNo: number | null; text: string }>;
  error?: string;
  detail?: string;
}

/** Run the formatter for the given path. Does NOT write to disk. */
export async function formatFile(path: string): Promise<FormatResult> {
  return apiPost<FormatResult>("/api/workspace/format", { path }, { timeoutMs: 5 * 60_000 });
}

// API helpers

interface InfoResponse {
  workspace: WorkspaceInfo | null;
}
interface OpenResponse {
  workspace: WorkspaceInfo;
}
interface ListResponse {
  workspaces: WorkspaceInfo[];
}
interface TreeResponse {
  workspace: Pick<WorkspaceInfo, "id" | "name">;
  tree: FileNode[];
}
interface FileResponse {
  file: WorkspaceFile;
}
interface WriteResponse {
  path: string;
  bytes?: number;
}
interface CreateResponse {
  path: string;
  bytes?: number;
}
interface DeleteResponse {
  path: string;
}
interface RenameResponse {
  from: string;
  to: string;
}
type CommandResponse = CommandResult;

export async function fetchWorkspaceInfo(): Promise<WorkspaceInfo | null> {
  const res = await apiGet<InfoResponse>("/api/workspace");
  return res.workspace ?? null;
}

export async function openWorkspace(name: string): Promise<WorkspaceInfo> {
  const res = await apiPost<OpenResponse>("/api/workspace", {
    action: "open",
    name,
  });
  return res.workspace;
}

export async function listWorkspaces(): Promise<WorkspaceInfo[]> {
  const res = await apiPost<ListResponse>("/api/workspace", {
    action: "list",
  });
  return res.workspaces ?? [];
}

export async function closeWorkspace(): Promise<void> {
  await apiPost<{ ok: true }>("/api/workspace", { action: "close" });
}

export async function fetchTree(): Promise<{
  workspace: Pick<WorkspaceInfo, "id" | "name">;
  tree: FileNode[];
}> {
  return apiGet<TreeResponse>("/api/workspace/tree", { timeoutMs: 5 * 60_000 });
}

export async function fetchFile(path: string): Promise<WorkspaceFile> {
  const res = await apiGet<FileResponse>("/api/workspace/file", {
    query: { path },
    timeoutMs: 5 * 60_000,
  });
  return res.file;
}

/**
 * Read an inclusive 1-based line range from a file. Returns the slice
 * plus `totalLines` and the actual `startLine`/`endLine` returned (which
 * may differ from the request after server-side clamping to the file
 * bounds and the 1000-line cap).
 */
export async function fetchFileRange(
  path: string,
  start: number,
  end: number,
): Promise<WorkspaceFile> {
  const res = await apiGet<FileResponse>("/api/workspace/file", {
    query: { path, start, end },
    timeoutMs: 5 * 60_000,
  });
  return res.file;
}

export async function putFile(
  path: string,
  content: string,
): Promise<WriteResponse> {
  // api-client.ts does not export an apiPut helper; use fetch directly with
  // the same envelope parsing semantics (throws ApiRequestError on { error }).
  const res = await fetch("/api/workspace/file", {
    method: "PUT",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ path, content }),
    credentials: "include",
  });
  const text = await res.text();
  let json: unknown = undefined;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      throw new ApiRequestError(
        `Invalid JSON response: ${text.slice(0, 200)}`,
        undefined,
        res.status,
      );
    }
  }
  if (
    json &&
    typeof json === "object" &&
    "error" in json &&
    typeof (json as { error: unknown }).error === "string"
  ) {
    const e = json as { error: string; code?: string; details?: unknown };
    throw new ApiRequestError(e.error, e.code, res.status, e.details);
  }
  return json as WriteResponse;
}

export async function createFile(
  path: string,
  type: "file" | "dir",
  content?: string,
): Promise<CreateResponse> {
  return apiPost<CreateResponse>("/api/workspace/file", { path, type, content });
}

export async function deleteFile(path: string): Promise<DeleteResponse> {
  // api-client's apiDelete doesn't accept a query string, so build the URL
  // manually. The endpoint reads `path` from the search params.
  const url = `/api/workspace/file?path=${encodeURIComponent(path)}`;
  return apiDelete<DeleteResponse>(url);
}

export async function renamePath(
  from: string,
  to: string,
): Promise<RenameResponse> {
  return apiPost<RenameResponse>("/api/workspace/rename", { from, to });
}

export async function runCommand(command: string): Promise<CommandResponse> {
  // Arbitrary user commands (npm install, test suites, long builds) can run
  // well past the 30s default; give them the same budget as the terminal.
  return apiPost<CommandResponse>("/api/workspace/command", { command }, { timeoutMs: 10 * 60_000 });
}

// UI helpers

/** Map a file path to a Prism language identifier for syntax highlighting. */
export function langFromPath(path: string): string {
  const name = path.split("/").pop() ?? path;
  const lower = name.toLowerCase();
  if (lower === "package.json" || lower.endsWith(".json")) return "json";
  if (lower.endsWith(".ts")) return "typescript";
  if (lower.endsWith(".tsx")) return "tsx";
  if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs"))
    return "javascript";
  if (lower.endsWith(".jsx")) return "jsx";
  if (lower.endsWith(".css")) return "css";
  if (lower.endsWith(".scss")) return "scss";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "markup";
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "markdown";
  if (lower.endsWith(".py")) return "python";
  if (lower.endsWith(".sh") || lower.endsWith(".bash")) return "bash";
  if (lower.endsWith(".yml") || lower.endsWith(".yaml")) return "yaml";
  if (lower.endsWith(".xml")) return "markup";
  if (lower.endsWith(".sql")) return "sql";
  if (lower === "dockerfile") return "docker";
  if (lower === ".gitignore" || lower === ".env") return "bash";
  return "text";
}

/** Format a byte count as a human-readable string. */
export function formatBytes(bytes: number | undefined | null): string {
  if (bytes === undefined || bytes === null || Number.isNaN(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** Return the final path segment. */
export function baseName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** Return the parent directory path (workspace-relative). */
export function dirName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 1) return "";
  return parts.slice(0, -1).join("/");
}

/** Join a directory and a name into a workspace-relative path. */
export function joinPath(dir: string, name: string): string {
  const clean = (s: string) => s.replace(/^\/+|\/+$/g, "");
  const d = clean(dir);
  const n = clean(name);
  if (!d) return n;
  return `${d}/${n}`;
}
