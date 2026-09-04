import { toast } from 'sonner';
import { getAppVersion } from '@/lib/version';

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
    openExternalUrl(url);
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

/** Best-effort stop of our own Node sidecar so the installer can replace install-dir files. */
async function stopSidecarForUpdate(): Promise<void> {
  if (!isTauriDesktop()) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("stop_node_sidecar");
  } catch (e) {
    console.warn("[updater] stop_node_sidecar failed (continuing anyway):", e);
  }
}

/**
 * Checks for updates across desktop and web environments.
 * In desktop mode: checks Tauri updater plugin and installs update if confirmed.
 * In web/dev mode: checks /api/version?checkRemote=true to notify of newer releases.
 */
export async function checkForUpdates(autoInstall = false): Promise<UpdateCheckResult> {
  const currentVersion = getAppVersion();

  // Helper to query our internal /api/version?checkRemote=true route (GitHub API backed)
  const queryRemoteFallback = async (): Promise<UpdateCheckResult | null> => {
    try {
      const res = await fetch("/api/version?checkRemote=true", {
        signal: AbortSignal.timeout(6000),
      });
      if (res.ok) {
        const data = (await res.json()) as {
          version?: string;
          update?: {
            hasUpdate: boolean;
            latestVersion: string;
            releaseName?: string;
            releaseNotes?: string;
            releaseUrl?: string;
          };
        };
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
      }
    } catch {
      // ignore
    }
    return null;
  };

  if (isTauriDesktop()) {
    try {
      const { check } = await import("@tauri-apps/plugin-updater");

      // Wrap Tauri check() in a strict 5-second timeout so it never hangs indefinitely
      const checkPromise = check();
      const timeoutPromise = new Promise<null>((_, reject) =>
        setTimeout(() => reject(new Error("Tauri updater check timed out")), 5000),
      );

      const update = await Promise.race([checkPromise, timeoutPromise]);

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
              toast.loading(`Downloading HermOS IDE v${update.version}...`, {
                id: "app-update-progress",
              });
              break;
            case "Progress":
              downloadedBytes += event.data?.chunkLength || 0;
              if (totalBytes > 0) {
                const percent = Math.round((downloadedBytes / totalBytes) * 100);
                const mb = (downloadedBytes / (1024 * 1024)).toFixed(1);
                const totalMb = (totalBytes / (1024 * 1024)).toFixed(1);
                toast.loading(`Downloading update v${update.version}: ${percent}% (${mb}/${totalMb} MB)...`, {
                  id: "app-update-progress",
                });
              }
              break;
            case "Finished":
              toast.loading("Download complete. Installing update...", {
                id: "app-update-progress",
              });
              break;
          }
        });
      } catch (downloadError) {
        // Company-grade: never leave an indefinite loading spinner, and never
        // strand the user with a 6s toast they might miss — pin a manual
        // fallback so a failed auto-install is always recoverable in one click.
        toast.dismiss("app-update-progress");
        toast.error("Update download failed.", {
          id: "app-update-failed",
          duration: 60000,
          description: "Check your connection and retry — or install manually from the release page.",
          action: {
            label: "Install manually",
            onClick: () => openReleaseTag(update.version),
          },
        });
        throw downloadError;
      }

      // Point of no return on Windows: install() spawns the installer and the
      // process self-terminates, so NOTHING below runs there. Record first so
      // the next boot can verify the install actually applied.
      recordPendingUpdate(currentVersion, update.version);
      await stopSidecarForUpdate();

      try {
        await update.install();
      } catch (installError) {
        toast.dismiss("app-update-progress");
        toast.error("Update install failed.", {
          id: "app-update-failed",
          duration: 60000,
          description: "The download is fine — the installer could not apply it. Retry, or install manually.",
          action: {
            label: "Install manually",
            onClick: () => openReleaseTag(update.version),
          },
        });
        throw installError;
      }

      // macOS/Linux path only — on Windows the process is already gone here.
      // The installer runs as part of downloadAndInstall; relaunch only moves
      // us into the new version. If relaunch throws, the previous code fell
      // into the outer catch which surfaced NOTHING visible — the app just sat
      // on the old version. Pin a restart prompt instead.
      try {
        const { relaunch } = await import("@tauri-apps/plugin-process");
        await relaunch();
      } catch (relaunchError) {
        console.warn("[updater] relaunch failed after staged update:", relaunchError);
        toast.warning("Update downloaded — restart to finish install.", {
          id: "app-update-restart",
          duration: Infinity,
          description: "The new version is staged. Restart the app to apply it.",
          action: {
            label: "Restart now",
            onClick: () => {
              import("@tauri-apps/plugin-process").then(({ relaunch }) => relaunch()).catch(() => {
                openReleaseTag(update.version);
              });
            },
          },
        });
      }
      return { status: "downloaded", version: update.version };
    } catch (error) {
      // Ensure no stale progress toast survives a failed download/check.
      toast.dismiss("app-update-progress");
      console.info("[updater] Tauri native check failed/timed out, trying GitHub API fallback:", error);
      const fallback = await queryRemoteFallback();
      if (fallback) return fallback;

      const message = error instanceof Error ? error.message : String(error);
      return { status: "error", message };
    }
  }

  // Web / Server / Dev environment check via /api/version
  try {
    const res = await fetch("/api/version?checkRemote=true");
    if (!res.ok) {
      return { status: 'up-to-date', currentVersion };
    }
    const data = (await res.json()) as {
      version: string;
      update?: {
        latestVersion: string;
        hasUpdate: boolean;
        releaseName?: string;
        releaseNotes?: string;
        releaseUrl?: string;
      } | null;
    };

    if (data?.update?.hasUpdate) {
      return {
        status: 'available',
        currentVersion: data.version || currentVersion,
        latestVersion: data.update.latestVersion,
        releaseName: data.update.releaseName,
        releaseNotes: data.update.releaseNotes,
        releaseUrl: data.update.releaseUrl,
      };
    }

    return { status: 'up-to-date', currentVersion: data?.version || currentVersion };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: 'error', message };
  }
}