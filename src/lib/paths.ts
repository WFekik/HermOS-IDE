import path from "path";
import os from "os";
import { createHash } from "crypto";
import { existsSync, mkdirSync, chmodSync, statSync, lstatSync } from "fs";

/**
 * Centralized filesystem roots for HermOS IDE.
 * Resolves APP_DATA_DIR (custom override, desktop mode, or dev ~/.hermos) and runtime subdirectories.
 */

function computeAppDataDir(): string {
  if (process.env.HERMOS_APP_DATA_DIR) {
    return process.env.HERMOS_APP_DATA_DIR;
  }
  if (process.env.HERMOS_DESKTOP === "true") {
    // Windows: %APPDATA%/com.hermos.ide
    if (process.env.APPDATA) {
      return path.join(process.env.APPDATA, "com.hermos.ide");
    }
    // macOS: ~/Library/Application Support/com.hermos.ide
    if (process.env.HOME) {
      const libDir = process.platform === "darwin"
        ? path.join(process.env.HOME, "Library", "Application Support")
        : path.join(process.env.HOME, ".local", "share");
      return path.join(libDir, "com.hermos.ide");
    }
    // Fallback — should never happen on a real OS
    return path.join(__dirname, "..", "..", ".hermos-data");
  }
  // Dev/browser mode: use a per-user data dir outside the project
  return path.join(os.homedir(), ".hermos");
}

function computeProjectRoot(): string {
  if (process.env.HERMOS_PROJECT_ROOT) {
    return process.env.HERMOS_PROJECT_ROOT;
  }
  // Desktop mode has no intrinsic "project root" — workspaces point directly
  // to the user's folders. Return the dev repo root as a safe fallback.
  return path.resolve(__dirname, "..", "..");
}

function computeUploadsDir(appDataDir: string): string {
  return path.join(appDataDir, "uploads");
}

function computeScreenshotDir(appDataDir: string): string {
  return path.join(appDataDir, "browser-screenshots");
}

function computeCheckpointsDir(appDataDir: string): string {
  return path.join(appDataDir, "checkpoints");
}

export const APP_DATA_DIR: string = computeAppDataDir();
export const PROJECT_ROOT: string = computeProjectRoot();
export const UPLOADS_ROOT: string = computeUploadsDir(APP_DATA_DIR);
export const SCREENSHOT_DIR: string = computeScreenshotDir(APP_DATA_DIR);
export const CHECKPOINTS_DIR: string = computeCheckpointsDir(APP_DATA_DIR);
export const ARTIFACTS_DIR: string = path.join(APP_DATA_DIR, "artifacts");
export const WORKSPACES_ROOT: string = path.join(APP_DATA_DIR, "workspaces");
export const AGENT_TEMP_ROOT: string = path.join(APP_DATA_DIR, "agent-temp");

/**
 * Canonical com.hermos-ide temporary directory for sessions, temp files, and cross-mode control.
 *
 * CONTRACT: do not join paths off this constant for I/O. Call
 * `ensureHermosTempDir()` and use its return value instead — it quarantines
 * first-run symlink plants to a fresh owner-only dir and repairs modes.
 * The constant remains exported for display strings and tests only.
 */
export const HERMOS_TEMP_DIR: string = path.join(os.tmpdir(), "com.hermos-ide");
/** Sessions subdir — same contract as HERMOS_TEMP_DIR: prefer the ensure* return value. */
export const HERMOS_TEMP_SESSIONS_DIR: string = path.join(HERMOS_TEMP_DIR, "sessions");

let hermosTempDirOverride: string | null = null;

export function ensureHermosTempDir(): string {
  const dir = hermosTempDirOverride ?? HERMOS_TEMP_DIR;
  const sessionsDir =
    hermosTempDirOverride != null
      ? path.join(hermosTempDirOverride, "sessions")
      : HERMOS_TEMP_SESSIONS_DIR;
  try {
    // Fail closed on first-run symlink plants: a pre-created
    // os.tmpdir()/com.hermos-ide symlink would redirect session writes
    // (prompts, excerpts) to an attacker directory. On detection, quarantine
    // to a fresh owner-only dir instead of following the link (throwing would
    // break the never-throws contract; silently using it would leak data).
    try {
      const st = lstatSync(/* turbopackIgnore: true */ dir);
      if (st.isSymbolicLink()) {
        console.error(
          `[paths] Refusing symlinked temp dir, quarantining: ${dir}. Remove it and restart to restore the default.`,
        );
        const safe = path.join(os.tmpdir(), `com.hermos-ide-safe-${process.pid}`);
        mkdirSync(/* turbopackIgnore: true */ safe, { recursive: true, mode: 0o700 });
        mkdirSync(/* turbopackIgnore: true */ path.join(safe, "sessions"), { recursive: true, mode: 0o700 });
        hermosTempDirOverride = safe;
        return safe;
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") throw e;
    }
    if (!existsSync(/* turbopackIgnore: true */ dir)) {
      // mode 0o700: owner-only read/write/execute. Prevents other local users
      // on a multi-user host from reading session data, prompts, or file excerpts
      // stored under com.hermos-ide/sessions.
      mkdirSync(/* turbopackIgnore: true */ dir, { recursive: true, mode: 0o700 });
    } else {
      // Repair pre-existing dirs created before the 0o700 hardening (or by a
      // different installer with 0777): enforce owner-only access best-effort.
      // Windows-tolerant — chmod is a no-op there, failures are ignored.
      try {
        if (process.platform !== "win32") {
          const st = statSync(/* turbopackIgnore: true */ dir);
          if ((st.mode & 0o777) !== 0o700) chmodSync(/* turbopackIgnore: true */ dir, 0o700);
        }
      } catch {
        /* ignore — best-effort hardening */
      }
    }
    if (!existsSync(/* turbopackIgnore: true */ sessionsDir)) {
      mkdirSync(/* turbopackIgnore: true */ sessionsDir, { recursive: true, mode: 0o700 });
    } else {
      try {
        if (process.platform !== "win32") {
          const st = statSync(/* turbopackIgnore: true */ sessionsDir);
          if ((st.mode & 0o777) !== 0o700) chmodSync(/* turbopackIgnore: true */ sessionsDir, 0o700);
        }
      } catch {
        /* ignore — best-effort hardening */
      }
    }
  } catch {
    /* ignore */
  }
  return dir;
}

/** Generates a filesystem-safe per-user dir name, appending a hash on sanitization to avoid collisions. */
export function safeUserId(userId: string): string {
  const sanitized = userId.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (sanitized === userId) return userId;
  return `${sanitized}-${createHash("sha1").update(userId).digest("hex").slice(0, 12)}`;
}

/** Ensure the app data dirs exist (best-effort, never throws). */
export function ensureRuntimeDirs(): void {
  try {
    // turbopackIgnore is only honored on a bare variable argument passed
    // directly to the fs call — not on path.join(...) expressions.
    if (!existsSync(/* turbopackIgnore: true */ APP_DATA_DIR)) {
      mkdirSync(/* turbopackIgnore: true */ APP_DATA_DIR, { recursive: true });
    }
    if (!existsSync(/* turbopackIgnore: true */ UPLOADS_ROOT)) {
      mkdirSync(/* turbopackIgnore: true */ UPLOADS_ROOT, { recursive: true });
    }
    if (!existsSync(/* turbopackIgnore: true */ SCREENSHOT_DIR)) {
      mkdirSync(/* turbopackIgnore: true */ SCREENSHOT_DIR, { recursive: true });
    }
    if (!existsSync(/* turbopackIgnore: true */ CHECKPOINTS_DIR)) {
      mkdirSync(/* turbopackIgnore: true */ CHECKPOINTS_DIR, { recursive: true });
    }
    if (!existsSync(/* turbopackIgnore: true */ ARTIFACTS_DIR)) {
      mkdirSync(/* turbopackIgnore: true */ ARTIFACTS_DIR, { recursive: true });
    }
    if (!existsSync(/* turbopackIgnore: true */ WORKSPACES_ROOT)) {
      mkdirSync(/* turbopackIgnore: true */ WORKSPACES_ROOT, { recursive: true });
    }
    if (!existsSync(/* turbopackIgnore: true */ AGENT_TEMP_ROOT)) {
      mkdirSync(/* turbopackIgnore: true */ AGENT_TEMP_ROOT, { recursive: true });
    }
    ensureHermosTempDir();
  } catch {
    /* ignore */
  }
}
