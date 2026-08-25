"use client";

import * as React from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  React.useEffect(() => {
    console.error("[Root Error Boundary Catch]:", error);
  }, [error]);

  return (
    <div className="flex h-screen w-screen flex-col items-center justify-center bg-background p-6 text-foreground">
      <div className="flex max-w-md flex-col items-center text-center space-y-4 rounded-xl border bg-card p-6 shadow-lg">
        <div className="rounded-full bg-destructive/10 p-3 text-destructive">
          <AlertTriangle className="size-8" />
        </div>
        <div className="space-y-1">
          <h2 className="text-lg font-semibold tracking-tight">Something went wrong</h2>
          <p className="text-xs text-muted-foreground leading-relaxed">
            An unexpected application error occurred. You can attempt to recover by refreshing the page or clicking below.
          </p>
        </div>
        {error?.digest && (
          <p className="font-mono text-[10px] text-muted-foreground/70 bg-muted px-2 py-1 rounded">
            Error digest: {error.digest}
          </p>
        )}
        <div className="flex items-center gap-2 pt-2">
          <Button
            variant="default"
            size="sm"
            onClick={() => reset()}
            className="gap-2 text-xs"
          >
            <RefreshCw className="size-3.5" />
            Try again
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => window.location.reload()}
            className="text-xs"
          >
            Reload application
          </Button>
        </div>
      </div>
    </div>
  );
}
