import { toast } from 'sonner';
import { getAppVersion } from '@/lib/version';
import {
  t as translate,
  SUPPORTED_LANGUAGE_CODES,
  LANGUAGE_STORAGE_KEY,
  type SupportedLanguage,
} from '@/lib/i18n';

/** Synchronous translator for this non-React module (toasts). Reads the
 * stored UI language; unknown/missing locale chunks fall back to English
 * per-key inside `t()`, so this never throws and never blocks. */
function tx(key: string, params?: Record<string, string | number>): string {
  let lang: SupportedLanguage = "en";
  try {
    const raw =
      typeof window !== "undefined" ? window.localStorage.getItem(LANGUAGE_STORAGE_KEY) : null;
    if (raw && (SUPPORTED_LANGUAGE_CODES as readonly string[]).includes(raw)) {
      lang = raw as SupportedLanguage;
    }
  } catch {
    /* storage unavailable — English fallback */
  }
  try {
    return translate(key, lang, params);
  } catch {
    return key;
  }
}

/** Progress/stage hooks for the persistent titlebar update button. When
 * `quiet` is true the updater stays silent (no toasts) and the caller owns
 * all UI via the callbacks + update-store. Defaults preserve the legacy
 * toast behavior for the settings-dialog manual path. */
export interface UpdateProgressOpts {
  quiet?: boolean;
  onProgress?: (downloadedBytes: number, totalBytes: number) => void;
  onStage?: (stage: "downloading" | "installing") => void;
}

/**
 * Typed result of an update check so the UI can surface findings cleanly.
 */
export type UpdateCheckResult =
  | { status: 'up-to-date'; currentVersion: string }
  | {
      status: 'available';
      currentVersion: string;
      latestVersion: string;
      releaseName?: string;
      releaseNotes?: string;
      releaseUrl?: string;
    }
  | { status: 'downloaded'; version: string }
  | { status: 'error'; message: string };

export function isTauriDesktop(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

const RELEASE_REPO = "https://github.com/WFekik/HermOS-IDE";

/** Manual-install fallback URL for a given version (used when auto-install can't finish). */
export function releaseTagUrl(version: string): string {
  const v = String(version || "").trim().replace(/^v/, "");
  return `${RELEASE_REPO}/releases/tag/v${v}`;
}

function openReleaseTag(version: string): void {
  const url = releaseTagUrl(version);
  import("@/lib/open-external").then(({ openExternalUrl }) => {
    void openExternalUrl(url);
  }).catch(() => {
    window.open(url, "_blank", "noopener");
  });
}

const PENDING_UPDATE_KEY = "hermos:pending-update";

export interface PendingUpdate {
  from: string;
  to: string;
  at: number;
}

/**
 * Persist an update across the install step. On Windows the updater plugin
 * terminates the process to run the installer, so code after `install()`
 * never runs there — this record is the only way to know on next boot
 * whether the install actually applied (verify-on-launch pattern).
 */
export function recordPendingUpdate(from: string, to: string): void {
  try {
    localStorage.setItem(PENDING_UPDATE_KEY, JSON.stringify({ from, to, at: Date.now() }));
  } catch {
    /* storage unavailable — boot check simply won't fire */
  }
}

export function readPendingUpdate(): PendingUpdate | null {
  try {
    const raw = localStorage.getItem(PENDING_UPDATE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<PendingUpdate>;
    if (typeof p.from === "string" && typeof p.to === "string" && p.from !== p.to) {
      return { from: p.from, to: p.to, at: typeof p.at === "number" ? p.at : 0 };
    }
  } catch {
    /* corrupted record — treat as none */
  }
  return null;
}

export function clearPendingUpdate(): void {
  try {
    localStorage.removeItem(PENDING_UPDATE_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Boot check: call once at startup. Returns the pending record when an update
 * was staged but we are STILL on the old version (install did not apply).
 * Clears the record once the new version is running. Returns null otherwise.
 */
export function consumeStaleUpdate(): PendingUpdate | null {
  const pending = readPendingUpdate();
  if (!pending) return null;
  let current = "";
  try {
    current = getAppVersion();
  } catch {
    return null;
  }
  if (current === pending.to) {
    clearPendingUpdate();
    return null;
  }
  if (current === pending.from) return pending;
  // Unknown version (dev/rollback) — drop the stale record.
  clearPendingUpdate();
  return null;
}

/** Best-effort stop of our own Node sidecar so the installer can replace install-dir files.
 *
 * The Rust side (`stop_node_sidecar`) now kills the process tree AND waits up
 * to ~5s for the OS to release file locks + CWD before returning. We still
 * sleep an extra beat here because on Windows the `_up_` staging move races
 * the last handle close — without it `install()` intermittently fails with
 * an `_up` / "file in use" lock error mid-update.
 */
async function stopSidecarForUpdate(): Promise<void> {
  if (!isTauriDesktop()) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    // Retry the invoke itself: the WebView bridge can drop the first call
    // while the backend is busy serving the download.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await invoke("stop_node_sidecar");
        break;
      } catch (e) {
        if (attempt === 2) throw e;
        await new Promise((r) => setTimeout(r, 400));
      }
    }
  } catch (e) {
    console.warn("[updater] stop_node_sidecar failed (continuing anyway):", e);
  }
  // Give Windows time to drop the install-dir locks (open server.js handles
  // + process CWD) before the installer moves `_up_` into place.
  await new Promise((r) => setTimeout(r, 2200));
}

/**
 * Marker for "the installer would be blocked by locked files": the probe
 * site already toasted quit-first guidance (or the quiet caller owns the UI
 * via e.message), so generic failure handlers must not pile a second
 * "install failed" toast on top. Thrown BEFORE install() ever spawns NSIS.
 */
export class InstallBlockedError extends Error {
  readonly files: string[];
  constructor(message: string, files: string[]) {
    super(message);
    this.name = "InstallBlockedError";
    this.files = files;
  }
}

/** Best-effort full quit so the user can run the installer over a clean
 * tree. Needs the `process:allow-exit` capability; without it the user
 * quits via the OS and nothing here throws. */
function quitAppNow(): void {
  import("@tauri-apps/plugin-process")
    .then(({ exit }) => exit(0))
    .catch(() => {
      /* capability missing — user quits via the OS */
    });
}

/**
 * Ask the backend which install-dir files NSIS must replace are still
 * locked for writing (running node.exe, memory-mapped *.node modules).
 * Re-probes up to 3x: a transient holder (AV scan, indexer) can clear in a
 * second, so only a lock that survives every attempt blocks the install.
 * Returns the locked paths, or null when the probe itself is unavailable
 * (non-Windows, old backend) — null means "unknown, proceed exactly like
 * before the probe existed"; the install retries stay the backstop. A
 * non-array payload (e.g. a boolean from a mocked bridge) is also null.
 */
async function checkInstallLocks(): Promise<string[] | null> {
  if (!isTauriDesktop()) return null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const locked = await invoke<unknown>("check_install_locks");
      if (!Array.isArray(locked)) return null;
      if (locked.length === 0 || attempt === 2) return locked.map(String);
    } catch (e) {
      console.warn("[updater] check_install_locks unavailable, proceeding:", e);
      return null;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  // Satisfies the compiler; every loop path above already returned.
  return null;
}

/**
 * Exported for unit tests (updater.test.ts). Classifies installer failures
 * caused by Windows file locks so installWithRetries knows what is worth
 * retrying. Matching rules, all deliberate:
 * - `_up_` / `_up` + word boundary: the NSIS staging dir (NOT bare "my_uploads").
 * - Whole-word lock/locked/locks/locking: "blocked", "clock" and "unlock"
 *   have no leading word boundary before "lock", so they never match.
 * - `remove` alone is intentionally NOT a match — it must co-occur with
 *   `directory`, otherwise every rm-style error would retry.
 * - `opening file for writing`: the NSIS "Error opening file for writing:
 *   <path>" dialog shown when the sidecar (node.exe) or a loaded native
 *   module (*.node, e.g. the prisma engine) is still alive at install time.
 *   Narrowly the NSIS phrasing — a bare "failed to write file" (disk full
 *   etc.) is definitive, not a lock, and must not retry or retain pending.
 */
export function isFileLockError(e: unknown): boolean {
  const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return (
    msg.includes("_up_") ||
    /_up\b/.test(msg) ||
    msg.includes("ebusy") ||
    msg.includes("eperm") ||
    /\block(?:ed|s|ing)?\b/.test(msg) ||
    msg.includes("in use") ||
    msg.includes("being used") ||
    msg.includes("access is denied") ||
    msg.includes("os error 5") ||
    msg.includes("opening file for writing") ||
    (msg.includes("remove") && msg.includes("directory"))
  );
}

/**
 * Install with retries across the file-lock window. Each retry re-stops the
 * sidecar and backs off, so a transient `_up` lock never strands the user
 * on the old version. There is no Rust watchdog that respawns Node, so the
 * re-stop is purely defensive (covers a user manually relaunching the
 * backend between attempts).
 *
 * Exported for unit tests with an injectable `stopSidecar` (defaults to the
 * real stopSidecarForUpdate in production).
 */
export async function installWithRetries(
  install: () => Promise<void>,
  onAttempt: (attempt: number) => void,
  stopSidecar: () => Promise<void> = stopSidecarForUpdate,
  opts: Pick<UpdateProgressOpts, "quiet"> = {},
): Promise<void> {
  const MAX_ATTEMPTS = 4;
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    onAttempt(attempt);
    try {
      await install();
      return;
    } catch (e) {
      lastError = e;
      if (!isFileLockError(e) || attempt === MAX_ATTEMPTS) throw e;
      console.warn(
        `[updater] install attempt ${attempt}/${MAX_ATTEMPTS} hit a file lock, retrying:`,
        e,
      );
      if (!opts.quiet) {
        toast.loading(
          tx("update_retry_wait", { attempt, max: MAX_ATTEMPTS }),
          { id: "app-update-progress" },
        );
      }
      // Re-stop (defensive — see doc comment) before the next attempt.
      await stopSidecar();
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  throw lastError;
}

/**
 * Checks for updates across desktop and web environments.
 * In desktop mode: checks Tauri updater plugin and installs update if confirmed.
 * In web/dev mode: checks /api/version?checkRemote=true to notify of newer releases.
 *
 * `opts.quiet` suppresses all toasts (the persistent titlebar button owns
 * the UI instead); `onProgress`/`onStage` report download/install movement.
 * All user-visible strings go through `tx()` — never hardcoded English.
 */
export async function checkForUpdates(
  autoInstall = false,
  opts: UpdateProgressOpts = {},
): Promise<UpdateCheckResult> {
  const currentVersion = getAppVersion();

  // Shared /api/version?checkRemote=true plumbing (GitHub API backed, 6s
  // timeout). One signal builder + one payload parser; the two callers keep
  // their own error semantics (fallback: null on anything; web path:
  // up-to-date on !ok, error status on throw).
  const versionCheckSignal = (): AbortSignal | undefined =>
    typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(6000)
      : undefined;
  const parseVersionPayload = (data: {
    version?: string;
    update?: {
      hasUpdate: boolean;
      latestVersion: string;
      releaseName?: string;
      releaseNotes?: string;
      releaseUrl?: string;
    };
  }): UpdateCheckResult | null => {
    if (data?.update?.hasUpdate) {
      return {
        status: "available",
        currentVersion: data.version || currentVersion,
        latestVersion: data.update.latestVersion,
        releaseName: data.update.releaseName,
        releaseNotes: data.update.releaseNotes,
        releaseUrl: data.update.releaseUrl,
      };
    }
    return { status: "up-to-date", currentVersion: data?.version || currentVersion };
  };
  const queryRemoteFallback = async (): Promise<UpdateCheckResult | null> => {
    try {
      const res = await fetch("/api/version?checkRemote=true", {
        signal: versionCheckSignal(),
      });
      if (!res.ok) return null;
      return parseVersionPayload(await res.json());
    } catch {
      // ignore
    }
    return null;
  };

  if (isTauriDesktop()) {
    // CHECK PHASE (own try/catch): check/import/timeout failures degrade to
    // the GitHub-API fallback or an error status — they never throw.
    // DOWNLOAD + INSTALL below run OUTSIDE this try on purpose: their
    // failures must propagate to the caller (button failure state / retry),
    // never be downgraded into a misleading "up-to-date" by the fallback.
    let update: Awaited<ReturnType<typeof import("@tauri-apps/plugin-updater").check>> | null;
    try {
      const { check } = await import("@tauri-apps/plugin-updater");

      // Wrap Tauri check() in a strict 5-second timeout so it never hangs indefinitely
      const checkPromise = check();
      const timeoutPromise = new Promise<null>((_, reject) =>
        setTimeout(() => reject(new Error("Tauri updater check timed out")), 5000),
      );

      update = await Promise.race([checkPromise, timeoutPromise]);
    } catch (error) {
      if (!opts.quiet) toast.dismiss("app-update-progress");
      console.info("[updater] Tauri native check failed/timed out, trying GitHub API fallback:", error);
      const fallback = await queryRemoteFallback();
      if (fallback) return fallback;

      const message = error instanceof Error ? error.message : String(error);
      return { status: "error", message };
    }

    if (!update) {
      // Double check against remote GitHub API in case manifest format differs
      const remote = await queryRemoteFallback();
      return remote ?? { status: "up-to-date", currentVersion };
    }

    if (!autoInstall) {
      return {
        status: "available",
        currentVersion,
        latestVersion: update.version,
        releaseNotes: update.body || "",
      };
    }

    let downloadedBytes = 0;
    let totalBytes = 0;

    // NOTE: split download/install on purpose. The UI (and these toasts) is
    // served by our own Node sidecar, which holds locks on install-dir
    // files — NSIS cannot replace a running executable, so the sidecar must
    // die after the download and before install().
    try {
      await update.download((event: { event: string; data?: { contentLength?: number; chunkLength?: number } }) => {
        switch (event.event) {
          case "Started":
            totalBytes = event.data?.contentLength || 0;
            opts.onStage?.("downloading");
            opts.onProgress?.(0, totalBytes);
            if (!opts.quiet) {
              // A new attempt supersedes any pinned failure toast from a
              // previous try (blocked/install-failed share this id).
              toast.dismiss("app-update-failed");
              toast.loading(tx("update_downloading", { version: update.version }), {
                id: "app-update-progress",
              });
            }
            break;
          case "Progress":
            downloadedBytes += event.data?.chunkLength || 0;
            opts.onProgress?.(downloadedBytes, totalBytes);
            if (!opts.quiet && totalBytes > 0) {
              const percent = Math.round((downloadedBytes / totalBytes) * 100);
              const mb = (downloadedBytes / (1024 * 1024)).toFixed(1);
              const totalMb = (totalBytes / (1024 * 1024)).toFixed(1);
              toast.loading(
                tx("update_downloading_progress", {
                  version: update.version,
                  percent,
                  downloaded: mb,
                  total: totalMb,
                }),
                { id: "app-update-progress" },
              );
            }
            break;
          case "Finished":
            if (!opts.quiet) {
              toast.loading(tx("update_download_complete"), {
                id: "app-update-progress",
              });
            }
            break;
        }
      });
    } catch (downloadError) {
      // Never leave an indefinite loading spinner, and never strand the
      // user — pin a manual fallback so a failed auto-install is always
      // recoverable in one click. Quiet (titlebar-button) callers render
      // their own failure state instead.
      if (!opts.quiet) {
        toast.dismiss("app-update-progress");
        toast.error(tx("update_download_failed"), {
          id: "app-update-failed",
          duration: 60000,
          description: tx("update_download_failed_desc"),
          action: {
            label: tx("update_install_manually"),
            onClick: () => openReleaseTag(update.version),
          },
        });
      }
      throw downloadError;
    }

    // Point of no return on Windows: install() spawns the installer and the
    // process self-terminates, so NOTHING below runs there. Record first so
    // the next boot can verify the install actually applied.
    recordPendingUpdate(currentVersion, update.version);
    await stopSidecarForUpdate();
    const stillLocked = await checkInstallLocks();
    if (stillLocked && stillLocked.length > 0) {
      // Locks survived the kill (orphan Node, a second app instance, an AV
      // handle…). Running install() now would drive straight into NSIS
      // "Error opening file for writing" dialogs with Abort/Retry/Ignore —
      // the exact dead end in the community reports. Abort BEFORE the
      // installer spawns: undo the pending record (nothing was staged by
      // us) and hand the user the actual fix — quit fully, then retry.
      // No uninstall is ever needed; the NSIS installer upgrades in place
      // over a clean (fully-quit) tree.
      clearPendingUpdate();
      const files = stillLocked
        .map((p) => p.split(/[/\\]/).pop() || p)
        .slice(0, 5)
        .join(", ");
      const blockedMessage = tx("update_blocked_by_lock_desc", { files });
      if (!opts.quiet) {
        toast.dismiss("app-update-progress");
        toast.error(tx("update_blocked_by_lock"), {
          id: "app-update-failed",
          duration: Infinity,
          description: blockedMessage,
          action: { label: tx("update_quit_now"), onClick: () => quitAppNow() },
          cancel: {
            label: tx("update_install_manually"),
            onClick: () => openReleaseTag(update.version),
          },
        });
      }
      throw new InstallBlockedError(blockedMessage, stillLocked);
    }
    opts.onStage?.("installing");
    if (!opts.quiet) {
      toast.loading(tx("update_installing"), {
        id: "app-update-progress",
      });
    }

    try {
      await installWithRetries(
        () => update.install(),
        (attempt) => {
          if (attempt > 1 && !opts.quiet) {
            toast.loading(
              tx("update_retry_wait", { attempt, max: 4 }),
              { id: "app-update-progress" },
            );
          }
        },
        stopSidecarForUpdate,
        { quiet: opts.quiet },
      );
    } catch (installError) {
      // Definitive (non-lock) failures will fail identically on every
      // retry AND every reboot — drop the pending record so the next boot
      // doesn't re-nag with a stale "didn't apply" notice for an update
      // that can never apply this way. Lock-exhaustion keeps the record:
      // a reboot may genuinely release the files. Either way the next
      // auto-check re-reports `available` fresh when appropriate.
      if (!isFileLockError(installError)) clearPendingUpdate();
      if (!opts.quiet) {
        toast.dismiss("app-update-progress");
        toast.error(tx("update_install_failed"), {
          id: "app-update-failed",
          duration: 60000,
          description: tx("update_install_failed_desc"),
          action: {
            label: tx("update_install_manually"),
            onClick: () => openReleaseTag(update.version),
          },
        });
      }
      throw installError;
    }

    // macOS/Linux path only — on Windows the process is already gone here.
    // The installer runs as part of downloadAndInstall; relaunch only moves
    // us into the new version. If relaunch throws, the previous code fell
    // into the outer catch which surfaced NOTHING visible — the app just sat
    // on the old version. Pin a restart prompt instead.
    // The progress toast has served its purpose either way — dismiss it so
    // a stale "Installing…" spinner never survives a successful install.
    // Quiet callers render the restart state in the titlebar button instead.
    // (Gated: the id is shared across flows, so a quiet flow must not kill
    // a concurrent non-quiet flow's spinner.)
    if (!opts.quiet) {
      toast.dismiss("app-update-progress");
      // Success clears any stale Infinity failure toast (blocked/failed) so
      // it cannot linger over the new version.
      toast.dismiss("app-update-failed");
    }
    try {
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (relaunchError) {
      console.warn("[updater] relaunch failed after staged update:", relaunchError);
      if (!opts.quiet) {
        toast.warning(tx("update_ready_restart"), {
          id: "app-update-restart",
          duration: Infinity,
          description: tx("update_ready_restart_desc"),
          action: {
            label: tx("update_restart_now"),
            onClick: () => {
              import("@tauri-apps/plugin-process").then(({ relaunch }) => relaunch()).catch(() => {
                openReleaseTag(update.version);
              });
            },
          },
        });
      }
    }
    return { status: "downloaded", version: update.version };
  }

  // Web / Server / Dev environment check via /api/version.
  try {
    const res = await fetch("/api/version?checkRemote=true", {
      signal: versionCheckSignal(),
    });
    if (!res.ok) {
      return { status: 'up-to-date', currentVersion };
    }
    return (
      parseVersionPayload(await res.json()) ?? { status: 'up-to-date', currentVersion }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: 'error', message };
  }
}