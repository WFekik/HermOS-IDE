import { ChildProcess, execFile } from "child_process";
import { promisify } from "util";
import { existsSync } from "fs";
import { mkdir, readFile, unlink, readdir, stat } from "fs/promises";
import path from "path";
import os from "os";
import { randomUUID } from "crypto";
import { SCREENSHOT_DIR } from "@/lib/paths";
import { checkUrlHost } from "@/lib/ssrf";
import { EventEmitter } from "events";

export const browserEvents = new EventEmitter();
// One listener per connected panel/SSE client; default Node limit is 10.
browserEvents.setMaxListeners(50);

class BrowserProcessSupervisor {
  private activeProcesses = new Set<ChildProcess>();
  private isShuttingDown = false;

  constructor() {
    this.registerSignalHandlers();
  }

  public register(child?: ChildProcess): void {
    if (!child) return;
    if (this.isShuttingDown) {
      try {
        child.kill?.("SIGKILL");
      } catch { /* ignore */ }
      return;
    }
    this.activeProcesses.add(child);
    if (typeof child.once === "function") {
      child.once("close", () => this.activeProcesses.delete(child));
      child.once("exit", () => this.activeProcesses.delete(child));
    }
  }

  public unregister(child?: ChildProcess): void {
    if (!child) return;
    this.activeProcesses.delete(child);
  }

  public async shutdownAll(timeoutMs = 1500): Promise<void> {
    if (this.activeProcesses.size === 0) return;
    this.isShuttingDown = true;

    const killPromises: Promise<void>[] = [];

    for (const child of Array.from(this.activeProcesses)) {
      killPromises.push(
        new Promise((resolve) => {
          if (child.killed || child.exitCode !== null) {
            this.activeProcesses.delete(child);
            return resolve();
          }

          let forceTimer: NodeJS.Timeout | null = null;

          const cleanup = () => {
            if (forceTimer) clearTimeout(forceTimer);
            this.activeProcesses.delete(child);
            resolve();
          };

          child.once("close", cleanup);
          child.once("exit", cleanup);

          try {
            child.kill("SIGTERM");
          } catch {
            this.activeProcesses.delete(child);
            return resolve();
          }

          forceTimer = setTimeout(() => {
            try {
              if (!child.killed && child.exitCode === null) {
                child.kill("SIGKILL");
              }
            } catch { /* ignore */ }
            cleanup();
          }, timeoutMs);
        })
      );
    }

    await Promise.all(killPromises);
  }

  private registerSignalHandlers(): void {
    if (typeof process === "undefined") return;

    const handleSignal = async (_signal: string) => {
      await this.shutdownAll(1500);
    };

    process.once("SIGINT", () => void handleSignal("SIGINT"));
    process.once("SIGTERM", () => void handleSignal("SIGTERM"));
    process.once("beforeExit", () => void handleSignal("beforeExit"));
  }
}

export const browserSupervisor = new BrowserProcessSupervisor();

/**
 * Headless browser driver wrapping `agent-browser` CLI with multi-tenant session isolation,
 * strict input validation, timeouts, sanitized subprocess environment, and safe error returns.
 */

export function findAgentBrowserCli(): string {
  const candidates: string[] = [];

  // 1. cwd-anchored (dev: repo root; standalone: server.js cwd)
  candidates.push(
    path.resolve(process.cwd(), "node_modules", "agent-browser", "bin", "agent-browser.js"),
    path.resolve(process.cwd(), ".next-build", "standalone", "node_modules", "agent-browser", "bin", "agent-browser.js"),
    path.resolve(process.cwd(), "_up_", ".next-build", "standalone", "node_modules", "agent-browser", "bin", "agent-browser.js"),
  );

  // 2. Relative to process.execPath (in desktop standalone, sidecar node executable is next to the bundle)
  const execDir = path.dirname(process.execPath);
  candidates.push(
    path.join(execDir, "node_modules", "agent-browser", "bin", "agent-browser.js"),
    path.join(execDir, "resources", "node_modules", "agent-browser", "bin", "agent-browser.js"),
    path.join(execDir, "..", "node_modules", "agent-browser", "bin", "agent-browser.js"),
    path.join(execDir, "..", "Resources", "node_modules", "agent-browser", "bin", "agent-browser.js"),
  );

  // 3. Walk up from __dirname (up to 10 levels)
  // Guard: __dirname is undefined in ESM mode or under Turbopack virtual builds.
  // Strategies 1 (cwd) and 2 (execPath) cover all production paths; this is a
  // defense-in-depth fallback for unusual dev/CI environments.
  if (typeof __dirname !== "undefined") {
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    candidates.push(
      path.join(dir, "node_modules", "agent-browser", "bin", "agent-browser.js"),
      path.join(dir, "standalone", "node_modules", "agent-browser", "bin", "agent-browser.js"),
      path.join(dir, ".next-build", "standalone", "node_modules", "agent-browser", "bin", "agent-browser.js"),
    );
    const parent = path.dirname(dir);
    if (!parent || parent === dir) break;
    dir = parent;
  }
  } // end __dirname guard

  for (const candidate of candidates) {
    try {
      if (existsSync(/*turbopackIgnore: true*/ candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  return candidates[0];
}

const TIMEOUT_MS = 30_000;
const MAX_BUFFER = 10_000_000;
const MAX_URL_LEN = 2000;
const MAX_TEXT_LEN = 2000;
const MAX_QUERY_LEN = 500;

const REF_RE = /^@e\d+$/;
const SCROLL_DIRS = new Set(["up", "down", "left", "right"]);
const KEY_ALLOWLIST = new Set([
  "Enter",
  "Tab",
  "Escape",
  "Backspace",
  "Delete",
  "Space",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

export interface BrowserSession {
  id: string;
  url: string;
  title: string;
  createdAt: number;
}

// Session state keyed by sessionKey (bare userId — the agent tools and the
// integrated browser panel share ONE browser per user so the user always
// sees exactly what the agent sees).
const sessions = new Map<string, BrowserSession>();

/** Idle sessions expire after 30 minutes; map is capped to bound memory. */
const SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_SESSIONS = 200;
/** Upper bound on daemon teardowns spawned by a single prune pass. */
const MAX_CLOSES_PER_PRUNE = 10;

function touchSession(key: string): void {
  const s = sessions.get(key);
  if (s) s.createdAt = Date.now();
}

/** Lazily evict expired sessions and overflow the cap (oldest first). */
function pruneStaleSessions(): void {
  const now = Date.now();
  if (sessions.size === 0) return;
  // Evicting the map entry alone would orphan the daemon-side browser page —
  // also tear it down (best-effort). Capped per pass so a cold-start prune
  // after long idle can't burst-spawn hundreds of close processes.
  let closes = 0;
  const evict = (key: string) => {
    sessions.delete(key);
    if (closes < MAX_CLOSES_PER_PRUNE) {
      closes++;
      void runCli(["close"], key);
    }
  };
  if (sessions.size > MAX_SESSIONS) {
    const sorted = Array.from(sessions.entries()).sort((a, b) => a[1].createdAt - b[1].createdAt);
    for (let i = 0; i < sorted.length - MAX_SESSIONS; i++) {
      evict(sorted[i][0]);
    }
  }
  for (const [key, s] of sessions) {
    if (now - s.createdAt > SESSION_TTL_MS) evict(key);
  }
}

function getCleanSessionKey(sessionKey = "default"): string {
  return sessionKey.trim() || "default";
}

function getSafeBrowserEnv(sessionKey: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_ENV: process.env.NODE_ENV ?? "development",
    PATH: process.env.PATH || "",
    HOME: process.env.HOME || process.env.USERPROFILE || "",
    USERPROFILE: process.env.USERPROFILE || "",
    LOCALAPPDATA: process.env.LOCALAPPDATA || "",
    APPDATA: process.env.APPDATA || "",
    PROGRAMFILES: process.env["PROGRAMFILES"] || process.env["ProgramFiles"] || "C:\\Program Files",
    "PROGRAMFILES(X86)": process.env["PROGRAMFILES(X86)"] || process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
    ProgramData: process.env["ProgramData"] || "C:\\ProgramData",
    SYSTEMROOT: process.env.SYSTEMROOT || process.env.SystemRoot || "C:\\Windows",
    COMSPEC: process.env.COMSPEC || process.env.ComSpec || "cmd.exe",
    PATHEXT: process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD;.VBS;.JS;.WSF;.WSH",
    TEMP: process.env.TEMP || os.tmpdir(),
    TMP: process.env.TMP || os.tmpdir(),
    TMPDIR: process.env.TMPDIR || os.tmpdir(),
    LANG: process.env.LANG || "en_US.UTF-8",
    TZ: process.env.TZ || "UTC",
    AGENT_BROWSER_HEADED: "false",
    AGENT_BROWSER_SESSION: sessionKey,
  };
}

interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}

async function runCli(args: string[], sessionKey = "default"): Promise<RunResult> {
  const safeKey = getCleanSessionKey(sessionKey).replace(/[^a-zA-Z0-9_-]/g, "_");
  const cliPath = findAgentBrowserCli();
  const cliArgs = ["--session", safeKey, ...args];
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [cliPath, ...cliArgs],
      {
        maxBuffer: MAX_BUFFER,
        timeout: TIMEOUT_MS,
        shell: false,
        env: getSafeBrowserEnv(safeKey),
      },
      (err, stdout, stderr) => {
        browserSupervisor.unregister(child);
        if (err) {
          const msg =
            err.signal === "SIGTERM" || err.signal === "SIGKILL"
              ? `Browser command timed out after ${TIMEOUT_MS}ms.`
              : (err as Error & { code?: string }).code === "ENOENT"
                ? "agent-browser CLI not found on PATH."
                : err.message;
          resolve({
            ok: false,
            stdout: typeof stdout === "string" ? stdout : "",
            stderr: typeof stderr === "string" ? stderr : "",
            error: msg,
          });
          return;
        }
        resolve({ ok: true, stdout: stdout ?? "", stderr: stderr ?? "" });
      },
    );

    if (child) {
      browserSupervisor.register(child);

      // Ensure child process errors are handled and cleaned up.
      if (typeof child.on === "function") {
        child.on("error", (e) => {
          browserSupervisor.unregister(child);
          resolve({ ok: false, stdout: "", stderr: "", error: e.message });
        });
      }
    }
  });
}

function err(message: string): { ok: false; error: string } {
  return { ok: false, error: message };
}

async function snapshotCompact(sessionKey = "default"): Promise<RunResult> {
  return runCli(["snapshot", "-i", "-c"], sessionKey);
}

async function snapshotFull(sessionKey = "default"): Promise<RunResult> {
  return runCli(["snapshot"], sessionKey);
}

async function getTitle(sessionKey = "default"): Promise<string> {
  const r = await runCli(["get", "title"], sessionKey);
  if (!r.ok) return "";
  return r.stdout.trim();
}

async function getUrl(sessionKey = "default"): Promise<string> {
  const r = await runCli(["get", "url"], sessionKey);
  if (!r.ok) return "";
  return r.stdout.trim();
}

/**
 * Validate the live browser URL against SSRF policy after navigation or redirects.
 * If the navigated URL is prohibited, immediately blanks out the page and returns an error.
 */
async function enforceCurrentUrlSsrf(key: string): Promise<string | null> {
  const currentUrl = await getUrl(key);
  if (!currentUrl || currentUrl === "about:blank") return null;
  const blocked = await checkUrlHost(currentUrl);
  if (blocked) {
    // Proactively blank out the page and notify session listeners
    await runCli(["open", "about:blank"], key);
    const s = sessions.get(key);
    if (s) {
      s.url = "about:blank";
      s.title = "Blocked by SSRF Policy";
      browserEvents.emit("change", { sessionKey: key, session: { ...s } });
    }
    return `SSRF policy blocked navigation to target host (${currentUrl}): ${blocked}`;
  }
  return null;
}

/**
 * Refresh a session's url/title from the live page and broadcast a change
 * event so the integrated panel mirrors agent navigation in real time.
 * Reads run in parallel — they are independent queries after an action.
 */
async function syncSessionState(key: string): Promise<void> {
  const s = sessions.get(key);
  if (!s) return;
  const url = await getUrl(key);
  if (url && url !== "about:blank") {
    const blocked = await checkUrlHost(url);
    if (blocked) {
      await runCli(["open", "about:blank"], key);
      s.url = "about:blank";
      s.title = "Blocked by SSRF Policy";
      browserEvents.emit("change", { sessionKey: key, session: { ...s } });
      return;
    }
  }
  const title = await getTitle(key);
  // Re-check identity: the session may have been closed or evicted while the
  // CLI reads were in flight — never resurrect a dead session's state.
  if (sessions.get(key) !== s) return;
  let changed = false;
  if (url && url !== s.url) { s.url = url; changed = true; }
  if (title && title !== s.title) { s.title = title; changed = true; }
  touchSession(key);
  if (changed) browserEvents.emit("change", { sessionKey: key, session: { ...s } });
}

/** Opens a URL in the session, returning an interactive snapshot and page title. */
export async function browserOpen(
  url: string,
  sessionKey = "default",
): Promise<
  | { ok: true; session: BrowserSession; title: string; snapshot: string }
  | { ok: false; error: string }
> {
  const key = getCleanSessionKey(sessionKey);
  pruneStaleSessions();
  if (typeof url !== "string" || url.length > MAX_URL_LEN) {
    return err(`Invalid URL. Must be ≤${MAX_URL_LEN} chars.`);
  }
  // Validate host against SSRF policy.
  const blocked = await checkUrlHost(url);
  if (blocked) return err(blocked);
  // Navigate (this also launches the browser if needed).
  const openRes = await runCli(["open", url], key);
  if (!openRes.ok) {
    return err(openRes.error || `Failed to open ${url}.`);
  }
  // Best-effort wait for DOM content loaded.
  await runCli(["wait", "--load", "domcontentloaded"], key);

  // Validate post-navigation/redirect URL against SSRF policy.
  const postNavBlocked = await enforceCurrentUrlSsrf(key);
  if (postNavBlocked) {
    return err(postNavBlocked);
  }

  const session: BrowserSession = {
    id: randomUUID(),
    url: url,
    title: "", // updated below
    createdAt: Date.now(),
  };
  sessions.set(key, session);

  const snapResult = await snapshotCompact(key);
  const title = await getTitle(key);
  session.title = title;

  browserEvents.emit("change", { sessionKey: key, session });

  return {
    ok: true,
    session,
    title,
    snapshot: snapResult.ok ? snapResult.stdout : "",
  };
}

/** Re-run the compact interactive snapshot. */
export async function browserSnapshot(
  sessionKey = "default",
): Promise<
  | { ok: true; snapshot: string }
  | { ok: false; error: string }
> {
  const key = getCleanSessionKey(sessionKey);
  pruneStaleSessions();
  if (!sessions.has(key)) return err("No active browser session. Open a URL first.");
  touchSession(key);
  const postNavBlocked = await enforceCurrentUrlSsrf(key);
  if (postNavBlocked) return err(postNavBlocked);
  const r = await snapshotCompact(key);
  if (!r.ok) return err(r.error || "Failed to capture snapshot.");
  return { ok: true, snapshot: r.stdout };
}

/** Validate and click an element by ref (e.g. `@e3`). */
export async function browserClick(
  ref: string,
  sessionKey = "default",
): Promise<
  | { ok: true; snapshot: string }
  | { ok: false; error: string }
> {
  const key = getCleanSessionKey(sessionKey);
  pruneStaleSessions();
  if (typeof ref !== "string" || !REF_RE.test(ref)) {
    return err("Invalid ref. Must be of the form @eN (e.g. @e3).");
  }
  if (!sessions.has(key)) return err("No active browser session.");
  touchSession(key);
  const cleanRef = ref.replace(/^@/, "");
  const r = await runCli(["click", cleanRef], key);
  if (!r.ok) return err(r.error || `Failed to click ${ref}.`);
  // Wait for any post-click navigation/render.
  await runCli(["wait", "--load", "domcontentloaded"], key);
  const [snap] = await Promise.all([snapshotCompact(key), syncSessionState(key)]);
  const postNavBlocked = await enforceCurrentUrlSsrf(key);
  if (postNavBlocked) return err(postNavBlocked);
  if (!snap.ok) return err(snap.error || "Click succeeded but snapshot failed.");
  return { ok: true, snapshot: snap.stdout };
}

/** Fill an input field (clears first). */
export async function browserType(
  ref: string,
  text: string,
  sessionKey = "default",
): Promise<
  | { ok: true; snapshot: string }
  | { ok: false; error: string }
> {
  const key = getCleanSessionKey(sessionKey);
  if (typeof ref !== "string" || !REF_RE.test(ref)) {
    return err("Invalid ref. Must be of the form @eN.");
  }
  if (typeof text !== "string" || text.length > MAX_TEXT_LEN) {
    return err(`Text too long (max ${MAX_TEXT_LEN} chars).`);
  }
  if (!sessions.has(key)) return err("No active browser session.");
  touchSession(key);
  const cleanRef = ref.replace(/^@/, "");
  const r = await runCli(["fill", cleanRef, text], key);
  if (!r.ok) return err(r.error || `Failed to fill ${ref}.`);
  const snap = await snapshotCompact(key);
  if (!snap.ok) return err(snap.error || "Fill succeeded but snapshot failed.");
  return { ok: true, snapshot: snap.stdout };
}

/** Press a key (allowlisted). */
export async function browserPress(
  key: string,
  sessionKey = "default",
): Promise<
  | { ok: true; snapshot: string }
  | { ok: false; error: string }
> {
  const sKey = getCleanSessionKey(sessionKey);
  if (typeof key !== "string") return err("Invalid key.");
  const k = key.trim();
  const isPrintable = /^[a-zA-Z0-9]$/.test(k);
  if (!isPrintable && !KEY_ALLOWLIST.has(k)) {
    return err(
      "Key not allowed. Use a single alnum char or one of: " +
        Array.from(KEY_ALLOWLIST).join(", "),
    );
  }
  if (!sessions.has(sKey)) return err("No active browser session.");
  touchSession(sKey);
  const r = await runCli(["press", k], sKey);
  if (!r.ok) return err(r.error || `Failed to press ${k}.`);
  await runCli(["wait", "--load", "domcontentloaded"], sKey);
  const [snap] = await Promise.all([snapshotCompact(sKey), syncSessionState(sKey)]);
  const postNavBlocked = await enforceCurrentUrlSsrf(sKey);
  if (postNavBlocked) return err(postNavBlocked);
  if (!snap.ok) return err(snap.error || "Press succeeded but snapshot failed.");
  return { ok: true, snapshot: snap.stdout };
}

/** Max age for screenshot files (5 minutes). Older files are cleaned up. */
const SCREENSHOT_MAX_AGE_MS = 300_000;

async function cleanupOldScreenshots(): Promise<void> {
  try {
    const now = Date.now();
    const files = await readdir(SCREENSHOT_DIR).catch(() => [] as string[]);
    for (const f of files) {
      const fp = path.join(SCREENSHOT_DIR, f);
      try {
        const st = await stat(fp);
        if (now - st.mtimeMs > SCREENSHOT_MAX_AGE_MS) {
          await unlink(fp).catch(() => {});
        }
      } catch { /* skip unreadable */ }
    }
  } catch { /* ignore */ }
}

export async function browserScreenshot(
  sessionKey = "default",
): Promise<
  | { ok: true; path: string; base64: string; dataUrl: string }
  | { ok: false; error: string }
> {
  const key = getCleanSessionKey(sessionKey);
  pruneStaleSessions();
  if (!sessions.has(key)) return err("No active browser session.");
  touchSession(key);
  const postNavBlocked = await enforceCurrentUrlSsrf(key);
  if (postNavBlocked) return err(postNavBlocked);
  try {
    await mkdir(SCREENSHOT_DIR, { recursive: true });
  } catch { /* ignore */ }
  const filename = `screenshot-${Date.now()}-${randomUUID().slice(0, 8)}.png`;
  const filePath = path.join(SCREENSHOT_DIR, filename);
  const r = await runCli(["screenshot", filePath], key);
  if (!r.ok) return err(r.error || "Failed to capture screenshot.");
  let buf: Buffer;
  try {
    buf = await readFile(filePath);
  } catch (e) {
    return err(e instanceof Error ? e.message : "Failed to read screenshot file.");
  }
  const base64 = buf.toString("base64");
  const dataUrl = `data:image/png;base64,${base64}`;
  void cleanupOldScreenshots();
  return { ok: true, path: filePath, base64, dataUrl };
}

/** Scroll the page in a direction by an optional pixel amount. */
export async function browserScroll(
  direction: "up" | "down" | "left" | "right",
  px?: number,
  sessionKey = "default",
): Promise<
  | { ok: true; snapshot: string }
  | { ok: false; error: string }
> {
  const key = getCleanSessionKey(sessionKey);
  pruneStaleSessions();
  if (!SCROLL_DIRS.has(direction)) {
    return err("Invalid scroll direction. Use up/down/left/right.");
  }
  let amount = 300;
  if (px !== undefined) {
    if (typeof px !== "number" || !Number.isFinite(px) || px < 1 || px > 10000) {
      return err("Invalid scroll amount (1–10000 px).");
    }
    amount = Math.floor(px);
  }
  if (!sessions.has(key)) return err("No active browser session.");
  touchSession(key);
  const r = await runCli(["scroll", direction, String(amount)], key);
  if (!r.ok) return err(r.error || "Failed to scroll.");
  const snap = await snapshotCompact(key);
  if (!snap.ok) return err(snap.error || "Scroll succeeded but snapshot failed.");
  return { ok: true, snapshot: snap.stdout };
}

/** Extracts visible page text by converting accessibility tree snapshot to plain text. */
export async function browserExtractText(
  sessionKey = "default",
): Promise<
  | { ok: true; text: string }
  | { ok: false; error: string }
> {
  const key = getCleanSessionKey(sessionKey);
  pruneStaleSessions();
  if (!sessions.has(key)) return err("No active browser session.");
  touchSession(key);
  const postNavBlocked = await enforceCurrentUrlSsrf(key);
  if (postNavBlocked) return err(postNavBlocked);
  const r = await snapshotFull(key);
  if (!r.ok) return err(r.error || "Failed to capture snapshot.");
  return { ok: true, text: snapshotToPlainText(r.stdout) };
}

/** Navigate back in browser history. */
export async function browserGoBack(
  sessionKey = "default",
): Promise<
  | { ok: true; snapshot: string }
  | { ok: false; error: string }
> {
  const key = getCleanSessionKey(sessionKey);
  pruneStaleSessions();
  if (!sessions.has(key)) return err("No active browser session.");
  touchSession(key);
  const r = await runCli(["press", "BrowserBack"], key);
  if (!r.ok) return err(r.error || "Failed to go back.");
  const [snap] = await Promise.all([snapshotCompact(key), syncSessionState(key)]);
  const postNavBlocked = await enforceCurrentUrlSsrf(key);
  if (postNavBlocked) return err(postNavBlocked);
  if (!snap.ok) return err(snap.error || "Back succeeded but snapshot failed.");
  return { ok: true, snapshot: snap.stdout };
}

/** Navigate forward in browser history. */
export async function browserGoForward(
  sessionKey = "default",
): Promise<
  | { ok: true; snapshot: string }
  | { ok: false; error: string }
> {
  const key = getCleanSessionKey(sessionKey);
  pruneStaleSessions();
  if (!sessions.has(key)) return err("No active browser session.");
  touchSession(key);
  const r = await runCli(["press", "BrowserForward"], key);
  if (!r.ok) return err(r.error || "Failed to go forward.");
  const [snap] = await Promise.all([snapshotCompact(key), syncSessionState(key)]);
  const postNavBlocked = await enforceCurrentUrlSsrf(key);
  if (postNavBlocked) return err(postNavBlocked);
  if (!snap.ok) return err(snap.error || "Forward succeeded but snapshot failed.");
  return { ok: true, snapshot: snap.stdout };
}

/** Close the browser session. */
export async function browserClose(
  sessionKey = "default",
): Promise<
  | { ok: true }
  | { ok: false; error: string }
> {
  const key = getCleanSessionKey(sessionKey);
  pruneStaleSessions();
  if (!sessions.has(key)) return err("No active browser session.");
  // CLI close is best-effort — local session tracking is cleared regardless
  // so a stale handle can never be reused.
  await runCli(["close"], key);
  sessions.delete(key);
  browserEvents.emit("change", { sessionKey: key, session: null });
  return { ok: true };
}

/** Return the current session for the specified key (read-only). */
export function getBrowserSession(sessionKey = "default"): BrowserSession | null {
  const key = getCleanSessionKey(sessionKey);
  pruneStaleSessions();
  const session = sessions.get(key) ?? null;
  if (session) touchSession(key);
  return session;
}

/** Strips accessibility-tree formatting from snapshot to plain text. */
function snapshotToPlainText(snapshot: string): string {
  if (!snapshot) return "";
  const lines = snapshot.split("\n");
  const out: string[] = [];
  for (const raw of lines) {
    let line = raw;
    line = line.replace(/^\s*-\s*/, "");
    line = line.replace(/\s*\[[^\]]*\]\s*$/, "");
    line = line.replace(/^[a-zA-Z]+\s+/, "");
    const q = line.match(/^"([^"]*)"$/);
    if (q) {
      if (q[1]) out.push(q[1]);
      continue;
    }
    const trimmed = line.trim();
    if (trimmed) out.push(trimmed);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
