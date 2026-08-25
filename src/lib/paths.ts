import path from "path";
import os from "os";
import { createHash } from "crypto";
import { existsSync, mkdirSync } from "fs";

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
  } catch {
    /* ignore */
  }
}
