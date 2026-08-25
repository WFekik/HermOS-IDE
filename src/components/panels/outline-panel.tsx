"use client";

import * as React from "react";
import { SymbolOutline } from "@/components/workspace/symbol-outline";
import { useAppStore } from "@/stores/app-store";

/* -------------------------------------------------------------------------- *
 * Outline panel — the right-panel tab container that renders the symbol
 * outline for the currently-active file tab.
 *
 * Wraps the SymbolOutline component in a card-shaped container that fills
 * the right panel's tab content area. Reads the active file path from the
 * store so the outline auto-refreshes when the user switches tabs.
 * -------------------------------------------------------------------------- */

export function OutlinePanel() {
  const activeFileTab = useAppStore((s) => s.activeFileTab);
  const setRightPanelTab = useAppStore((s) => s.setRightPanelTab);

  // When no file is open, show a subtle hint that points the user to the
  // Files tab to open one (rather than just an empty void).
  const showOpenHint = !activeFileTab;

  return (
    <div className="flex h-full flex-col bg-card">
      {showOpenHint ? (
        <div className="flex h-full items-center justify-center p-6">
          <div className="text-center">
            <p className="text-xs font-medium">No file open</p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              Open a file in the Files tab to see its outline.
            </p>
            <button
              type="button"
              onClick={() => setRightPanelTab("files")}
              className="mt-3 inline-flex items-center gap-1 rounded-md border border-border/60 bg-background px-2 py-1 text-[11px] text-foreground/90 transition-colors hover:bg-accent"
            >
              Go to Files
            </button>
          </div>
        </div>
      ) : (
        <SymbolOutline className="flex-1 min-h-0" />
      )}
    </div>
  );
}
