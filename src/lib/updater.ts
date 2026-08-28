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

/**
 * Checks for updates across desktop and web environments.
 * In desktop mode: checks Tauri updater plugin and installs update if confirmed.
 * In web/dev mode: checks /api/version?checkRemote=true to notify of newer releases.
 */
export async function checkForUpdates(autoInstall = false): Promise<UpdateCheckResult> {
  const currentVersion = getAppVersion();

  if (isTauriDesktop()) {
    try {
      const { check } = await import('@tauri-apps/plugin-updater');
      const update = await check();

      if (!update) {
        return { status: 'up-to-date', currentVersion };
      }

      if (!autoInstall) {
        return {
          status: 'available',
          currentVersion,
          latestVersion: update.version,
          releaseNotes: update.body || '',
        };
      }

      let downloadedBytes = 0;
      let totalBytes = 0;

      await update.downloadAndInstall((event: { event: string; data?: { contentLength?: number; chunkLength?: number } }) => {
        switch (event.event) {
          case 'Started':
            totalBytes = event.data?.contentLength || 0;
            toast.loading(`Downloading HermOS IDE v${update.version}...`, {
              id: 'app-update-progress',
            });
            break;
          case 'Progress':
            downloadedBytes += event.data?.chunkLength || 0;
            if (totalBytes > 0) {
              const percent = Math.round((downloadedBytes / totalBytes) * 100);
              const mb = (downloadedBytes / (1024 * 1024)).toFixed(1);
              const totalMb = (totalBytes / (1024 * 1024)).toFixed(1);
              toast.loading(`Downloading update v${update.version}: ${percent}% (${mb}/${totalMb} MB)...`, {
                id: 'app-update-progress',
              });
            }
            break;
          case 'Finished':
            toast.success("Update downloaded! Relaunching HermOS IDE...", {
              id: 'app-update-progress',
              duration: 4000,
            });
            break;
        }
      });

      const { relaunch } = await import('@tauri-apps/plugin-process');
      await relaunch();
      return { status: 'downloaded', version: update.version };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const lower = message.toLowerCase();
      const isNotFound =
        lower.includes("404") ||
        lower.includes("not_found") ||
        lower.includes("latest.json") ||
        lower.includes("could not fetch a valid release json") ||
        lower.includes("release json") ||
        lower.includes("no update");

      if (isNotFound) {
        console.info("[updater] No update manifest available or release not found:", message);
        // Fall back to querying /api/version?checkRemote=true to check if there is a GitHub release
        try {
          const res = await fetch("/api/version?checkRemote=true");
          if (res.ok) {
            const data = (await res.json()) as { update?: { hasUpdate: boolean; latestVersion: string; releaseUrl?: string } };
            if (data?.update?.hasUpdate) {
              return {
                status: 'available',
                currentVersion,
                latestVersion: data.update.latestVersion,
                releaseUrl: data.update.releaseUrl,
              };
            }
          }
        } catch {
          /* ignore fallback error */
        }
        return { status: 'up-to-date', currentVersion };
      }
      console.error("Tauri Auto-Updater failed:", error);
      return { status: 'error', message };
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