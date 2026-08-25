"use client";

import * as React from "react";
import { IdeShell } from "@/components/ide/ide-shell";
import { ErrorBoundary } from "@/components/ide/error-boundary";
import { useAppStore } from "@/stores/app-store";

/** Root entry point — boots directly into the IDE. No auth, no redirect. */
export default function Home() {
  const hydrate = useAppStore((s) => s.hydrate);

  React.useEffect(() => {
    void hydrate();
  }, [hydrate]);

  return (
    <ErrorBoundary fallbackTitle="HermOS IDE encountered an unexpected error">
      <IdeShell />
    </ErrorBoundary>
  );
}
