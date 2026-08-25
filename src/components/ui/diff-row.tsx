"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Shared diff row renderer used by both DiffViewer (tool-call LCS diffs)
 * and GitDiffView (git unified patch diffs).
 *
 * Supports line types:
 *  - "context" — unchanged line, muted foreground
 *  - "add"     — added line, emerald tint
 *  - "del"     — deleted line, red tint
 *  - "hunk"    — @@ hunk header, muted bg
 *  - "meta"    — git metadata lines (index, ---, +++, etc.), subtly muted
 */
export interface SharedDiffLine {
  type: "context" | "add" | "del" | "hunk" | "meta";
  oldNo: number | null;
  newNo: number | null;
  text: string;
}

export function DiffRow({ line }: { line: SharedDiffLine }) {
  if (line.type === "hunk") {
    return (
      <div className="bg-muted/60 px-3 py-0.5 text-muted-foreground">
        {line.text}
      </div>
    );
  }
  if (line.type === "meta") {
    return (
      <div className="px-3 py-0.5 text-muted-foreground/70 select-none">
        {line.text}
      </div>
    );
  }
  const marker = line.type === "add" ? "+" : line.type === "del" ? "−" : " ";
  return (
    <div
      className={cn(
        "flex items-stretch hover:bg-accent/30 transition-colors",
        line.type === "add" && "bg-emerald-500/10",
        line.type === "del" && "bg-red-500/10",
      )}
    >
      <span className="w-10 shrink-0 select-none border-r border-border/50 px-2 text-right tabular-nums text-muted-foreground/60">
        {line.oldNo ?? ""}
      </span>
      <span className="w-10 shrink-0 select-none border-r border-border/50 px-2 text-right tabular-nums text-muted-foreground/60">
        {line.newNo ?? ""}
      </span>
      <span
        className={cn(
          "w-5 shrink-0 select-none text-center",
          line.type === "add" && "text-emerald-700 dark:text-emerald-400",
          line.type === "del" && "text-red-700 dark:text-red-400",
          line.type === "context" && "text-muted-foreground/60",
        )}
      >
        {marker}
      </span>
      <span
        className={cn(
          "flex-1 min-w-0 whitespace-pre-wrap break-words pl-2 pr-3",
          line.type === "add" && "text-emerald-700 dark:text-emerald-400",
          line.type === "del" && "text-red-700 dark:text-red-400",
          line.type === "context" && "text-foreground/80",
        )}
      >
        {line.text === "" ? " " : line.text}
      </span>
    </div>
  );
}
