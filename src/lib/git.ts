import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import path from "path";

/**
 * Git operations via `execFile` with path confinement under workspace roots.
 * Invariants: safe defaults on failure (never throws), capped output sizes, and posix-relative paths.
 */

const execFile = promisify(execFileCb);

const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 10 * 1024 * 1024; // 10 MB

const MAX_LOG_ENTRIES = 50;
const MAX_BRANCHES = 200;
const MAX_WORKTREES = 100;
const MAX_PATCH_CHARS = 50_000;

export type GitFileStatus = "A" | "M" | "D" | "R" | "?" | "U";

export interface GitFileChange {
  path: string;
  status: GitFileStatus;
  oldPath?: string;
}

export interface GitStatus {
  branch: string;
  ahead: number;
  behind: number;
  staged: GitFileChange[];
  modified: GitFileChange[];
  untracked: GitFileChange[];
  clean: boolean;
}

export interface GitDiffFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  additions: number;
  deletions: number;
  patch: string;
}

export interface GitDiffResult {
  files: GitDiffFile[];
  totalAdditions: number;
  totalDeletions: number;
}

export interface GitLogEntry {
  hash: string;
  author: string;
  date: string; // ISO 8601
  message: string;
}

export interface GitBranch {
  name: string;
  current: boolean;
  remote: boolean;
}

export interface GitWorktree {
  path: string; // absolute path to the worktree on disk
  branch: string; // branch name (short ref), or empty for detached
  head: string; // commit hash
  bare: boolean;
}

interface GitExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

/**
 * Run `git <args...>` via execFile without shell expansion.
 * Never throws — returns a result envelope with timeout and error handling.
 */
async function gitExec(rootDir: string, args: string[]): Promise<GitExecResult> {
  try {
    const { stdout, stderr } = await execFile("git", args, {
      cwd: rootDir,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      shell: false,
      windowsHide: true,
      // Bounded env to prevent parent process vars from altering git behavior.
      env: {
        PATH: process.env.PATH ?? (process.platform === "win32" ? "C:\\Windows\\System32;C:\\Windows" : "/usr/local/bin:/usr/bin:/bin"),
        HOME: process.env.HOME ?? (process.env.USERPROFILE ?? rootDir),
        LANG: "en_US.UTF-8",
        LC_ALL: "en_US.UTF-8",
        NODE_ENV: process.env.NODE_ENV ?? "development",
        GIT_TERMINAL_PROMPT: "0", // never prompt for credentials — fail instead
        ...(process.platform === "win32"
          ? { GIT_ASKPASS: "" }
          : { GIT_ASKPASS: "/bin/true", SSH_ASKPASS: "/bin/true" }),
      },
    });
    return { ok: true, stdout, stderr, exitCode: 0, timedOut: false };
  } catch (e) {
    const err = e as {
      stdout?: string;
      stderr?: string;
      code?: number | string;
      signal?: string;
      message?: string;
    };
    const timedOut = err.signal === "SIGTERM";
    return {
      ok: false,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? err.message ?? "",
      exitCode: typeof err.code === "number" ? err.code : null,
      timedOut,
    };
  }
}

/** Convert a possibly-quoted git path to a plain posix-relative path, decoding C-style escapes. */
function unquoteGitPath(p: string): string {
  if (!p) return p;
  if (p.length >= 2 && p.startsWith('"') && p.endsWith('"')) {
    const inner = p.slice(1, -1);
    try {
      return JSON.parse(`"${inner}"`) as string;
    } catch {
      return inner;
    }
  }
  return p;
}

/** Convert any OS-native path separators in a path to posix forward slashes. */
function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

/** Returns true if `rootDir` is inside a git working tree. */
export async function gitIsRepo(rootDir: string): Promise<boolean> {
  if (!rootDir) return false;
  const res = await gitExec(rootDir, ["rev-parse", "--git-dir"]);
  return res.ok;
}

function emptyStatus(): GitStatus {
  return {
    branch: "",
    ahead: 0,
    behind: 0,
    staged: [],
    modified: [],
    untracked: [],
    clean: true,
  };
}

/**
 * Parse `git status --porcelain=v2 --branch` output into a structured `GitStatus`.
 * Classifies files into staged, modified (unstaged), and untracked.
 */
export async function gitStatus(rootDir: string): Promise<GitStatus> {
  if (!rootDir) return emptyStatus();
  const res = await gitExec(rootDir, [
    "status",
    "--porcelain=v2",
    "--branch",
    // Don't surface ignored files — they'd just be noise in the UI.
    "--no-renames",
  ]);
  if (!res.ok) return emptyStatus();

  const status = emptyStatus();
  const lines = res.stdout.split("\n");

  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith("# branch.head ")) {
      const head = line.slice("# branch.head ".length).trim();
      // "(detached)" is reported for detached HEAD — surface the SHA instead.
      if (head && head !== "(detached)") {
        status.branch = head;
      }
      continue;
    }
    if (line.startsWith("# branch.ab ")) {
      // Format: "# branch.ab +<ahead> -<behind>"
      const m = line.match(/^# branch\.ab \+(\d+) -(\d+)$/);
      if (m) {
        status.ahead = parseInt(m[1], 10) || 0;
        status.behind = parseInt(m[2], 10) || 0;
      }
      continue;
    }
    if (line.startsWith("# branch.oid ") && !status.branch) {
      // Detached HEAD — show the short SHA as the "branch".
      const sha = line.slice("# branch.oid ".length).trim();
      if (sha) status.branch = sha.slice(0, 7);
      continue;
    }
    if (line.startsWith("#")) continue;

    if (line.startsWith("? ")) {
      const p = unquoteGitPath(line.slice(2).trim());
      if (p) {
        status.untracked.push({ path: toPosix(p), status: "?" });
        status.clean = false;
      }
      continue;
    }
    if (line.startsWith("! ")) continue; // ignored

    // Ordinary (1), renamed (2), and unmerged (u) entries have <XY> at chars 2-3.
    const xy = line.slice(2, 4);
    if (xy.length < 2) continue;
    const x = xy[0];
    const y = xy[1];

    // In porcelain v2, ' ' and '.' both indicate unmodified in that column.
    const X_UNMODIFIED = x === " " || x === ".";
    const Y_UNMODIFIED = y === " " || y === ".";

    // Extract path: 9th field for ordinary entries, or "new" path for renames.
    const pathStart = findPathStart(line);
    if (pathStart === -1) continue;
    let rawPath = line.slice(pathStart);
    // For renamed entries, rawPath is "old\tnew" — take the new path.
    if (rawPath.includes("\t")) {
      const parts = rawPath.split("\t");
      rawPath = parts[parts.length - 1];
    }
    const p = unquoteGitPath(rawPath.trim());
    if (!p) continue;
    const posix = toPosix(p);

    // Staged: X is a real status char (not unmodified, not '?').
    if (!X_UNMODIFIED && x !== "?") {
      status.staged.push({ path: posix, status: x as GitFileStatus });
      status.clean = false;
    }
    // Unstaged (modified): Y is a real status char (not unmodified, not '?').
    if (!Y_UNMODIFIED && y !== "?") {
      status.modified.push({ path: posix, status: y as GitFileStatus });
      status.clean = false;
    }
  }

  return status;
}

/** Find character offset where path field begins (after 8 space-delimited fields). */
function findPathStart(line: string): number {
  let spaces = 0;
  let i = 0;
  for (; i < line.length && spaces < 8; i++) {
    if (line[i] === " ") {
      spaces++;
      while (i + 1 < line.length && line[i + 1] === " ") i++;
    }
  }
  return spaces === 8 ? i : -1;
}

function emptyDiff(): GitDiffResult {
  return { files: [], totalAdditions: 0, totalDeletions: 0 };
}

/**
 * Parse unified diff into per-file patches with additions and deletions counts.
 */
function parseUnifiedDiff(diff: string): GitDiffResult {
  if (!diff) return emptyDiff();
  const files: GitDiffFile[] = [];
  let totalAdditions = 0;
  let totalDeletions = 0;

  // Split on 'diff --git ' boundaries.
  const chunks = diff.split(/^diff --git /m);
  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    const full = "diff --git " + chunk;
    const file = parseDiffChunk(full);
    if (file) {
      files.push(file);
      totalAdditions += file.additions;
      totalDeletions += file.deletions;
    }
  }
  return { files, totalAdditions, totalDeletions };
}

function parseDiffChunk(chunk: string): GitDiffFile | null {
  const lines = chunk.split("\n");
  let path = "";
  let status: GitDiffFile["status"] = "modified";
  let additions = 0;
  let deletions = 0;
  let inHunk = false;

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      continue;
    }
    if (line.startsWith("new file mode")) {
      status = "added";
      continue;
    }
    if (line.startsWith("deleted file mode")) {
      status = "deleted";
      continue;
    }
    if (line.startsWith("rename from") || line.startsWith("rename to")) {
      status = "renamed";
      continue;
    }
    if (line.startsWith("copy from") || line.startsWith("copy to")) {
      // Treat copies like renames for UI purposes — they show up as a new
      // path with a "from" link.
      status = "renamed";
      continue;
    }
    if (line.startsWith("+++ ")) {
      if (line === "+++ /dev/null") {
        // Deletion — path comes from `--- a/<path>` below.
        continue;
      }
      // `+++ b/<path>` or `+++ "b/path with space"`.
      const raw = line.slice(4);
      if (raw.startsWith("b/")) {
        path = unquoteGitPath(raw.slice(2));
      } else if (raw.startsWith("a/")) {
        // Defensive — git shouldn't do this for +++, but handle it.
        path = unquoteGitPath(raw.slice(2));
      } else {
        path = unquoteGitPath(raw);
      }
      continue;
    }
    if (line.startsWith("--- ")) {
      if (line === "--- /dev/null") {
        // New file — path already captured from +++ b/.
        continue;
      }
      if (!path) {
        // Deletion: capture path from --- a/<path> when +++ was /dev/null.
        const raw = line.slice(4);
        if (raw.startsWith("a/")) {
          path = unquoteGitPath(raw.slice(2));
        } else if (raw.startsWith("b/")) {
          path = unquoteGitPath(raw.slice(2));
        } else {
          path = unquoteGitPath(raw);
        }
      }
      continue;
    }
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (line.startsWith("diff --git")) {
      // Shouldn't reach here (we split on `diff --git `), but defensive.
      break;
    }
    if (!inHunk) continue;
    // Inside a hunk — count + / - lines (NOT +++ / --- which are headers).
    if (line.startsWith("+")) {
      additions++;
    } else if (line.startsWith("-")) {
      deletions++;
    }
    // Context lines (start with space) and `\ No newline at end of file`
    // are not counted.
  }

  if (!path) return null;

  // Truncate patch text to MAX_PATCH_CHARS if oversized.
  const patch =
    chunk.length > MAX_PATCH_CHARS
      ? chunk.slice(0, MAX_PATCH_CHARS) + "\n…[patch truncated]"
      : chunk;

  return { path, status, additions, deletions, patch };
}

/** Run `git diff` for unstaged or staged changes, optionally filtered by relative path. */
export async function gitDiff(
  rootDir: string,
  opts?: { staged?: boolean; path?: string },
): Promise<GitDiffResult> {
  if (!rootDir) return emptyDiff();
  const args = ["diff", "--no-renames", "--no-color"];
  if (opts?.staged) args.push("--staged");
  if (opts?.path) {
    args.push("--", opts.path);
  }
  const res = await gitExec(rootDir, args);
  if (!res.ok) return emptyDiff();
  return parseUnifiedDiff(res.stdout);
}

/**
 * Diff between two branches using triple-dot (`<base>...<compare>`) notation.
 * Validates branch ref formatting before invoking git.
 */
export async function gitDiffBranches(
  rootDir: string,
  base: string,
  compare: string,
): Promise<GitDiffResult> {
  if (!rootDir) return emptyDiff();
  // Sanitize ref names against flag injection or invalid characters.
  if (!base || !compare) return emptyDiff();
  if (base.length > 200 || compare.length > 200) return emptyDiff();
  if (base.startsWith("-") || compare.startsWith("-")) return emptyDiff();
  if (/\s/.test(base) || /\s/.test(compare)) return emptyDiff();

  const res = await gitExec(rootDir, [
    "diff",
    "--no-renames",
    "--no-color",
    `${base}...${compare}`,
  ]);
  if (!res.ok) return emptyDiff();
  return parseUnifiedDiff(res.stdout);
}

/** Retrieve recent commits on the current branch with unit-separator formatting. */
export async function gitLog(
  rootDir: string,
  limit = 20,
): Promise<GitLogEntry[]> {
  if (!rootDir) return [];
  const n = Math.max(1, Math.min(MAX_LOG_ENTRIES, Math.floor(limit) || 20));
  const res = await gitExec(rootDir, [
    "log",
    `--format=%H%x1f%an%x1f%aI%x1f%s`,
    "-n",
    String(n),
  ]);
  if (!res.ok) return [];

  const out: GitLogEntry[] = [];
  const lines = res.stdout.split("\n");
  for (const line of lines) {
    if (!line) continue;
    const parts = line.split("\x1f");
    if (parts.length < 4) continue;
    const [hash, author, date, ...rest] = parts;
    const message = rest.join("\x1f"); // preserve any \x1f in the message
    out.push({
      hash: hash.trim(),
      author: author.trim(),
      date: date.trim(),
      message,
    });
  }
  return out;
}

/** List all local and remote branches via `git branch -a` with current branch indicator. */
export async function gitBranches(rootDir: string): Promise<GitBranch[]> {
  if (!rootDir) return [];
  // Format: <full-refname>\t<*|>\t<upstream>
  const res = await gitExec(rootDir, [
    "branch",
    "-a",
    "--format=%(refname)%09%(HEAD)%09%(upstream:short)",
  ]);
  if (!res.ok) return [];

  const out: GitBranch[] = [];
  const lines = res.stdout.split("\n");
  for (const line of lines) {
    if (!line) continue;
    const [refname, head, _upstream] = line.split("\t");
    if (!refname) continue;
    const current = head === "*";
    let name = "";
    let remote = false;
    if (refname.startsWith("refs/heads/")) {
      name = refname.slice("refs/heads/".length);
      remote = false;
    } else if (refname.startsWith("refs/remotes/")) {
      name = refname.slice("refs/remotes/".length);
      remote = true;
    } else {
      // refs/tags/ or anything else — skip; we only surface branches.
      continue;
    }
    // Skip the synthetic `HEAD -> origin/HEAD` symlink that `branch -a`
    // sometimes emits for remotes.
    if (name === "HEAD" || name.endsWith("/HEAD")) continue;
    out.push({ name, current, remote });
    if (out.length >= MAX_BRANCHES) break;
  }
  return out;
}

function emptyWorktreeList(): GitWorktree[] {
  return [];
}

/** List all worktrees linked to the repository via `git worktree list --porcelain`. */
export async function gitWorktreeList(rootDir: string): Promise<GitWorktree[]> {
  if (!rootDir) return emptyWorktreeList();
  const res = await gitExec(rootDir, ["worktree", "list", "--porcelain"]);
  if (!res.ok) return emptyWorktreeList();

  const out: GitWorktree[] = [];
  let cur: Partial<GitWorktree> | null = null;
  const lines = res.stdout.split("\n");

  for (const line of lines) {
    if (line === "") {
      // Blank line — end of current entry.
      if (cur && cur.path) {
        out.push({
          path: cur.path,
          branch: cur.branch ?? "",
          head: cur.head ?? "",
          bare: cur.bare ?? false,
        });
        if (out.length >= MAX_WORKTREES) return out;
      }
      cur = null;
      continue;
    }
    if (line.startsWith("worktree ")) {
      cur = { path: line.slice("worktree ".length), bare: false };
    } else if (line.startsWith("HEAD ") && cur) {
      cur.head = line.slice("HEAD ".length).trim();
    } else if (line.startsWith("branch ") && cur) {
      // Long refname: refs/heads/<name> — strip the prefix.
      const ref = line.slice("branch ".length).trim();
      cur.branch =
        ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
    } else if (line === "detached" && cur) {
      cur.branch = "(detached)";
    } else if (line === "bare" && cur) {
      cur.bare = true;
    }
    // Unknown lines (e.g. "locked", "prunable") are ignored — we don't
    // surface them in the UI.
  }
  // Flush the last entry (porcelain output may not end with a blank line).
  if (cur && cur.path) {
    out.push({
      path: cur.path,
      branch: cur.branch ?? "",
      head: cur.head ?? "",
      bare: cur.bare ?? false,
    });
  }
  return out;
}

/**
 * Resolve `targetPath` and verify it is strictly confined within `<rootDir>/.worktrees/<subpath>`.
 * Returns the normalized absolute path on success, or `null` if escaping.
 */
function confineWorktreePath(rootDir: string, targetPath: string): string | null {
  if (!rootDir || !targetPath) return null;
  const worktreesRoot = path.resolve(rootDir, ".worktrees");
  const resolved = path.resolve(targetPath);
  // Case-insensitive comparison on Windows.
  const normalise = (p: string) => process.platform === "win32" ? p.toLowerCase() : p;
  const rootNorm = normalise(worktreesRoot);
  const resolvedNorm = normalise(resolved);
  if (resolvedNorm !== rootNorm && !resolvedNorm.startsWith(rootNorm + path.sep)) {
    return null;
  }
  // Refuse the worktrees root itself — must be a subfolder.
  if (resolvedNorm === rootNorm) return null;
  return resolved;
}

/**
 * Pure validation check for git branch ref names against illegal metacharacters, whitespace, and option flags.
 */
function isValidBranchName(name: string): boolean {
  if (!name || typeof name !== "string") return false;
  if (name.length < 1 || name.length > 200) return false;
  if (name.startsWith("-")) return false;
  if (name.includes("..")) return false;
  // Reject whitespace, control chars, and git ref metacharacters.
  if (/[\s\x00-\x1f\:~^?*\[\\]/.test(name)) return false;
  return true;
}

/**
 * Create a new git worktree at `targetPath` checking out `branch`.
 * Enforces path confinement under `.worktrees/` and validates the branch name.
 */
export async function gitWorktreeAdd(
  rootDir: string,
  branch: string,
  targetPath: string,
): Promise<{ ok: boolean; path: string }> {
  if (!rootDir) return { ok: false, path: targetPath };
  if (!isValidBranchName(branch)) return { ok: false, path: targetPath };
  const confined = confineWorktreePath(rootDir, targetPath);
  if (!confined) return { ok: false, path: targetPath };

  const res = await gitExec(rootDir, [
    "worktree",
    "add",
    confined,
    "--",
    branch,
  ]);
  if (!res.ok) {
    return { ok: false, path: confined };
  }
  return { ok: true, path: confined };
}

/** Remove a git worktree at `targetPath`, confined under `.worktrees/`. */
export async function gitWorktreeRemove(
  rootDir: string,
  targetPath: string,
  force = false,
): Promise<{ ok: boolean }> {
  if (!rootDir) return { ok: false };
  const confined = confineWorktreePath(rootDir, targetPath);
  if (!confined) return { ok: false };

  const args = ["worktree", "remove"];
  if (force) args.push("--force");
  args.push(confined);

  const res = await gitExec(rootDir, args);
  return { ok: res.ok };
}

export type GitCheckoutFailureReason =
  | "unknown_branch"
  | "invalid_ref"
  | "conflict"
  | "timeout"
  | "error";

export interface GitCheckoutResult {
  ok: boolean;
  /** Classified failure reason when `ok` is false. */
  reason?: GitCheckoutFailureReason;
  stderr?: string;
}

/**
 * Check out `branch` in the repo at `rootDir`, validating the ref name before
 * invoking git. Never throws — failures are classified so the API layer can
 * map them to precise status codes (404 unknown branch, 409 dirty tree).
 */
export async function gitCheckout(
  rootDir: string,
  branch: string,
): Promise<GitCheckoutResult> {
  if (!rootDir) return { ok: false, reason: "error" };
  // Same validation gate as worktree creation — rejects flag injection,
  // whitespace, control chars, and ref metacharacters.
  if (!isValidBranchName(branch)) {
    return { ok: false, reason: "invalid_ref", stderr: "Invalid branch name." };
  }

  const res = await gitExec(rootDir, ["checkout", "--", branch]);
  if (res.ok) return { ok: true };
  if (res.timedOut) {
    return { ok: false, reason: "timeout", stderr: res.stderr };
  }

  const errText = `${res.stderr}\n${res.stdout}`;
  if (/did not match any file\(s\) known to git/i.test(errText)) {
    return { ok: false, reason: "unknown_branch", stderr: res.stderr };
  }
  if (
    /would be overwritten by checkout|please commit your changes or stash them|untracked working tree file[s]? would be overwritten/i.test(
      errText,
    )
  ) {
    return { ok: false, reason: "conflict", stderr: res.stderr };
  }
  return { ok: false, reason: "error", stderr: res.stderr };
}
