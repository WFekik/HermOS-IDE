import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { toast } from 'sonner';

/**
 * Typed result of an update check so the UI can surface failures instead of
 * silently swallowing them.
 */
export type UpdateCheckResult =
  | { status: 'up-to-date' }
  | { status: 'downloaded'; version: string }
  | { status: 'error'; message: string };

function isTauriDesktop(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * Checks for updates in Tauri desktop mode and installs them when found.
 * Returns a typed result: failures are reported, not swallowed.
 */
export async function checkForUpdates(): Promise<UpdateCheckResult> {
  if (!isTauriDesktop()) {
    return { status: 'error', message: 'Not running in the Tauri desktop shell.' };
  }

  try {
    const update = await check();
    if (!update) {
      return { status: 'up-to-date' };
    }

    toast.info(`Found new version ${update.version}. Downloading update...`, {
      duration: 8000,
    });

    await update.downloadAndInstall((event) => {
      switch (event.event) {
        case 'Started':
          // downloading started — toast already shown
          break;
        case 'Progress':
          // progress updates handled silently
          break;
        case 'Finished':
          toast.success("Download finished! Relaunching application...", {
            duration: 3000,
          });
          break;
      }
    });

    await relaunch();
    return { status: 'downloaded', version: update.version };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const lower = message.toLowerCase();
    const isNotFound =
      lower.includes("404") ||
      lower.includes("not_found") ||
      lower.includes("latest.json") ||
      lower.includes("no update");
    // Only silence known "not found" from the updater endpoint — generic
    // "cannot find"/"not found" from filesystem/config errors must surface.
    if (isNotFound) {
      console.info("[updater] No update available or release not found:", message);
      return { status: 'up-to-date' };
    }
    console.error("Tauri Auto-Updater failed:", error);
    return { status: 'error', message };
  }
}