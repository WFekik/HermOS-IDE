"use client";

import * as React from "react";
import { Download, Loader2, RotateCcw, ExternalLink, Power } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useUpdateStore, shouldShowUpdateButton } from "@/stores/update-store";
import { checkForUpdates, isTauriDesktop, releaseTagUrl, InstallBlockedError } from "@/lib/updater";
import { useTranslation } from "@/hooks/use-translation";

function formatMb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

/**
 * Persistent titlebar update affordance (sits with the window controls, like
 * a browser's download button). It NEVER auto-dismisses: once an update is
 * known it stays until the user updates, restarts, or explicitly defers
 * ("Not now") — downloading is always the user's choice.
 *
 * Styling is theme-aware (muted/accent/foreground tokens only, no hardcoded
 * colors) so it follows light/dark/system automatically. Hovering shows the
 * "Update to v{version}" tooltip with the exact pending version.
 */
export function UpdateButton() {
  const { t } = useTranslation();
  const status = useUpdateStore((s) => s.status);
  const currentVersion = useUpdateStore((s) => s.currentVersion);
  const latestVersion = useUpdateStore((s) => s.latestVersion);
  const releaseName = useUpdateStore((s) => s.releaseName);
  const releaseNotes = useUpdateStore((s) => s.releaseNotes);
  const releaseUrl = useUpdateStore((s) => s.releaseUrl);
  const downloadedBytes = useUpdateStore((s) => s.downloadedBytes);
  const totalBytes = useUpdateStore((s) => s.totalBytes);
  const error = useUpdateStore((s) => s.error);
  const visible = useUpdateStore(shouldShowUpdateButton);
  const markAvailable = useUpdateStore((s) => s.markAvailable);
  const markDownloading = useUpdateStore((s) => s.markDownloading);
  const markInstalling = useUpdateStore((s) => s.markInstalling);
  const markReadyRestart = useUpdateStore((s) => s.markReadyRestart);
  const markFailed = useUpdateStore((s) => s.markFailed);
  const dismiss = useUpdateStore((s) => s.dismiss);
  const reset = useUpdateStore((s) => s.reset);

  const [busy, setBusy] = React.useState(false);
  // True only when the last failure was lock-blocked (InstallBlockedError):
  // quitting helps there (quit fully, then retry/manual-install), but not
  // for signature/download failures — so the Quit button must not ride on
  // the generic `failed` status. Reset on every new attempt.
  const [quitOffer, setQuitOffer] = React.useState(false);
  // Single desktop detector (same one the installer flow branches on) —
  // styling and flow must never disagree about the environment.
  const tauriDesktop = isTauriDesktop();

  const percent =
    totalBytes > 0 ? Math.min(100, Math.round((downloadedBytes / totalBytes) * 100)) : null;

  const tooltipText =
    status === "downloading"
      ? percent !== null
        ? t("update_downloading_progress", {
            version: latestVersion,
            percent,
            downloaded: formatMb(downloadedBytes),
            total: formatMb(totalBytes),
          })
        : t("update_downloading", { version: latestVersion })
      : status === "installing"
        ? t("update_installing")
        : status === "ready-restart"
          ? t("update_ready_restart")
          : status === "failed"
            ? (error ?? t("update_failed"))
            : t("update_to_version", { version: latestVersion });

  const openExternal = React.useCallback((url: string) => {
    import("@/lib/open-external")
      .then(({ openExternalUrl }) => openExternalUrl(url))
      .catch(() => false)
      .then((ok) => {
        if (!ok) window.open(url, "_blank", "noopener");
      });
  }, []);

  const manualUrl = React.useMemo(
    () => releaseUrl ?? releaseTagUrl(latestVersion),
    [releaseUrl, latestVersion],
  );

  // Ref-based in-flight lock: `busy` state only flips after re-render, so
  // two clicks in the same tick would both pass a state guard and start two
  // concurrent update.install() flows racing for file locks (with a possible
  // success-overwritten-by-failure end state). The ref flips synchronously.
  const inflightRef = React.useRef(false);
  const handleUpdateNow = React.useCallback(async () => {
    if (inflightRef.current || status === "downloading" || status === "installing") return;
    // Web/dev builds have no in-app installer — the release page is the flow.
    if (!isTauriDesktop()) {
      openExternal(manualUrl);
      return;
    }
    inflightRef.current = true;
    setBusy(true);
    setQuitOffer(false);
    try {
      const result = await checkForUpdates(true, {
        quiet: true,
        onProgress: (d, total) => markDownloading(d, total),
        onStage: (stage) => {
          if (stage === "installing") markInstalling();
        },
      });
      if (result.status === "downloaded") {
        // Windows self-terminated into the installer; macOS/Linux lands here
        // and either relaunched already or needs the restart prompt.
        markReadyRestart();
      } else if (result.status === "available") {
        // Native check blipped but the remote confirms an update exists —
        // keep the button on the CONFIRMED version, never vanish silently.
        markAvailable({
          currentVersion: result.currentVersion,
          latestVersion: result.latestVersion,
          releaseName: result.releaseName,
          releaseNotes: result.releaseNotes,
          releaseUrl: result.releaseUrl,
        });
      } else if (result.status === "error") {
        markFailed(result.message);
      } else {
        // Genuinely up-to-date race — nothing to show.
        reset();
      }
    } catch (e) {
      setQuitOffer(e instanceof InstallBlockedError);
      markFailed(e instanceof Error ? e.message : String(e));
    } finally {
      inflightRef.current = false;
      setBusy(false);
    }
  }, [status, manualUrl, openExternal, markAvailable, markDownloading, markInstalling, markReadyRestart, markFailed, reset]);

  const handleRestartNow = React.useCallback(() => {
    import("@tauri-apps/plugin-process")
      .then(({ relaunch }) => relaunch())
      .catch(() => {
        openExternal(manualUrl);
      });
  }, [manualUrl, openExternal]);

  // One-click quit for the locked-files failure state: the guidance tells
  // the user to quit fully (all windows) before retrying/installing
  // manually, so offer it as a button next to Retry. Needs the
  // `process:allow-exit` capability; without it the click is a no-op and
  // the user quits via the OS.
  const handleQuitNow = React.useCallback(() => {
    import("@tauri-apps/plugin-process")
      .then(({ exit }) => exit(0))
      .catch(() => {
        /* capability missing — user quits via the OS */
      });
  }, []);

  if (!visible) return null;

  // Defensive: no caller drives markFailed before markAvailable today, but a
  // version-less state must never render "Update to v" or a ".../tag/v"
  // garbage link — degrade to the error text and hide version actions.
  const hasVersion = latestVersion !== "";
  const inFlight = status === "downloading" || status === "installing" || busy;
  const Icon = inFlight ? Loader2 : status === "failed" ? RotateCcw : Download;

  return (
    <div
      data-tauri-drag-region="false"
      style={tauriDesktop ? ({ WebkitAppRegion: "no-drag" } as React.CSSProperties) : undefined}
      className="shrink-0"
    >
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-8 relative inline-flex items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                aria-label={tooltipText}
              >
                <Icon className={`size-3.5 ${inFlight ? "animate-spin" : ""}`} strokeWidth={1.8} />
                {status === "available" && (
                  <span
                    aria-hidden
                    className="absolute top-1 right-1 size-1.5 rounded-full bg-emerald-500"
                  />
                )}
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>{tooltipText}</TooltipContent>
        </Tooltip>

        <DropdownMenuContent align="end" className="w-80 p-0" sideOffset={8}>
          <div className="px-3 pt-3 pb-2">
            <p className="text-sm font-semibold">
              {hasVersion
                ? t("update_to_version", { version: latestVersion })
                : (error ?? t("update_failed"))}
            </p>
            {hasVersion && (
              <p className="text-xs text-muted-foreground mt-0.5">
                {releaseName || `v${currentVersion} → v${latestVersion}`}
              </p>
            )}
            {releaseNotes && (
              <p className="text-xs text-muted-foreground mt-2 max-h-24 overflow-y-auto whitespace-pre-wrap break-words">
                {releaseNotes.slice(0, 600)}
              </p>
            )}
          </div>

          {(status === "downloading") && (
            <div className="px-3 pb-2">
              <div
                className="h-1.5 w-full overflow-hidden rounded-full bg-secondary"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent ?? undefined}
                aria-label={t("update_downloading", { version: latestVersion })}
              >
                {percent !== null ? (
                  <div className="h-full bg-brand transition-[width]" style={{ width: `${percent}%` }} />
                ) : (
                  <div className="h-full w-1/3 animate-pulse bg-brand" />
                )}
              </div>
              <p className="text-xs text-muted-foreground mt-1.5 tabular-nums">
                {percent !== null
                  ? t("update_downloading_progress", {
                      version: latestVersion,
                      percent,
                      downloaded: formatMb(downloadedBytes),
                      total: formatMb(totalBytes),
                    })
                  : t("update_downloading", { version: latestVersion })}
              </p>
            </div>
          )}

          {status === "installing" && (
            <div className="px-3 pb-2 flex items-center gap-2">
              <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
              <p className="text-xs text-muted-foreground">{t("update_installing")}</p>
            </div>
          )}

          {status === "failed" && (
            <div className="px-3 pb-2">
              <p className="text-xs text-destructive break-words">{error ?? t("update_failed")}</p>
            </div>
          )}

          {status === "ready-restart" && (
            <div className="px-3 pb-2">
              <p className="text-xs text-muted-foreground">{t("update_ready_restart_desc")}</p>
            </div>
          )}

          <DropdownMenuSeparator />

          <div className="flex flex-col gap-1 p-2">
            {(status === "available" || status === "failed") && (
              <Button
                size="sm"
                className="w-full justify-start gap-2"
                disabled={inFlight}
                onClick={() => void handleUpdateNow()}
              >
                <Download className="size-3.5" />
                {status === "failed" ? t("update_retry_update") : t("update_now")}
              </Button>
            )}
            {status === "failed" && quitOffer && tauriDesktop && (
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start gap-2"
                onClick={handleQuitNow}
              >
                <Power className="size-3.5" />
                {t("update_quit_now")}
              </Button>
            )}
            {status === "ready-restart" && tauriDesktop && (
              <Button size="sm" className="w-full justify-start gap-2" onClick={handleRestartNow}>
                <RotateCcw className="size-3.5" />
                {t("update_restart_now")}
              </Button>
            )}
            {hasVersion && (
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start gap-2"
                onClick={() => openExternal(manualUrl)}
              >
                <ExternalLink className="size-3.5" />
                {releaseUrl ? t("update_view_release") : t("update_install_manually")}
              </Button>
            )}
            {(status === "available" || status === "failed") && (
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start text-muted-foreground"
                onClick={dismiss}
              >
                {t("update_not_now")}
              </Button>
            )}
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
