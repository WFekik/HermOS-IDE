"use client";

import * as React from "react";
import { Download, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

/* ------------------------------------------------------------------ *
 * ScreenshotDialog — shows the latest screenshot (a base64 PNG data URL)
 * fetched from /api/browser/screenshot. Includes a Download link.
 * ------------------------------------------------------------------ */

export function ScreenshotDialog({
  open,
  onOpenChange,
  dataUrl,
  loading,
  error,
  onRetry,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  dataUrl: string | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  const fileName = React.useMemo(() => {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return `hermos-screenshot-${stamp}.png`;
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl p-0 overflow-hidden gap-0">
        <DialogHeader className="px-4 py-3 border-b">
          <DialogTitle>Browser screenshot</DialogTitle>
          <DialogDescription className="text-xs">
            The most recent frame captured from the live browser session.
          </DialogDescription>
        </DialogHeader>

        <div className="relative max-h-[70vh] min-h-[200px] overflow-auto bg-muted/30">
          {loading && (
            <div className="flex h-[300px] items-center justify-center">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          )}
          {!loading && error && (
            <div className="flex h-[300px] flex-col items-center justify-center gap-2 p-6 text-center">
              <p className="text-xs text-amber-600 dark:text-amber-400">
                {error}
              </p>
              <Button size="sm" variant="outline" onClick={onRetry}>
                Retry
              </Button>
            </div>
          )}
          {!loading && !error && dataUrl && (
            <img
              src={dataUrl}
              alt="Browser screenshot"
              className="block h-auto w-full"
            />
          )}
          {!loading && !error && !dataUrl && (
            <div className="flex h-[200px] items-center justify-center text-xs text-muted-foreground">
              No screenshot available.
            </div>
          )}
        </div>

        <DialogFooter className="border-t px-4 py-2.5">
          {dataUrl && !error && (
            <a
              href={dataUrl}
              download={fileName}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-brand px-3 text-xs font-medium text-brand-foreground hover:bg-brand/90"
            >
              <Download className="size-3.5" /> Download
            </a>
          )}
          <Button
            variant="outline"
            size="sm"
            className="h-8"
            onClick={() => onOpenChange(false)}
          >
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
