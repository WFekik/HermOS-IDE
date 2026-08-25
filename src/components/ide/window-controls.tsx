"use client";

import * as React from "react";
import { Minus, Square, X } from "lucide-react";
import { isTauri } from "@/lib/tauri";

/** Standard Windows "restore down" icon — two overlapping rectangles. */
function RestoreIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 10 10"
      fill="none"
      stroke="currentColor"
      strokeWidth={1}
      className={className}
    >
      {/* back (upper-right) rectangle */}
      <rect x="3" y="0.5" width="6.5" height="6.5" rx="0.5" />
      {/* front (lower-left) rectangle */}
      <rect x="0.5" y="3" width="6.5" height="6.5" rx="0.5" fill="var(--background, #000)" />
      <rect x="0.5" y="3" width="6.5" height="6.5" rx="0.5" />
    </svg>
  );
}

export function WindowControls() {
  const [isMaximized, setIsMaximized] = React.useState(false);
  const tauri = isTauri();

  React.useEffect(() => {
    if (!tauri) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    import("@tauri-apps/api/window")
      .then(async ({ getCurrentWindow }) => {
        if (cancelled) return;
        const win = getCurrentWindow();
        try {
          setIsMaximized(await win.isMaximized());
        } catch {
          /* ignore — window API not ready (dev/browser) */
        }
        try {
          const fn = await win.onResized(async () => {
            try {
              setIsMaximized(await win.isMaximized());
            } catch {
              /* ignore */
            }
          });
          unlisten = fn;
        } catch {
          /* ignore */
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [tauri]);

  if (!tauri) return null;

  const handleMinimize = async () => {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().minimize();
    } catch {}
  };

  const handleMaximize = async () => {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      if (await win.isMaximized()) await win.unmaximize();
      else await win.maximize();
    } catch {}
  };

  const handleClose = async () => {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().close();
    } catch {}
  };

  return (
    <div className="flex items-center shrink-0">
      <button
        type="button"
        onClick={handleMinimize}
        aria-label="Minimize"
        className="inline-flex size-8 items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
      >
        <Minus className="size-3.5" strokeWidth={1.6} />
      </button>
      <button
        type="button"
        onClick={handleMaximize}
        aria-label={isMaximized ? "Restore" : "Maximize"}
        className="inline-flex size-8 items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
      >
        {isMaximized ? <RestoreIcon className="size-3" /> : <Square className="size-3" strokeWidth={1.6} />}
      </button>
      <button
        type="button"
        onClick={handleClose}
        aria-label="Close"
        className="inline-flex size-8 items-center justify-center text-muted-foreground hover:bg-red-600 hover:text-white transition-colors"
      >
        <X className="size-3.5" strokeWidth={1.6} />
      </button>
    </div>
  );
}
