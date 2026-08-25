"use client";

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Check, Copy, FilePen, FileCheck2, Minus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { DiffRow, type SharedDiffLine } from "@/components/ui/diff-row";

interface DiffViewerProps {
  path: string;
  oldContent: string;
  newContent: string;
  /** Optional handler called when the user clicks "Apply". */
  onApply?: () => void;
  /** Disable the Apply button (e.g. while a request is in flight). */
  applyBusy?: boolean;
  /** Hide the Apply button entirely (read-only view). */
  hideApply?: boolean;
  className?: string;
}

type DiffLine = SharedDiffLine;

/**
 * Unified-diff viewer for file edit / write tool results.
 *
 * Computes a line-based longest-common-subsequence diff client-side and
 * renders a scrollable gutter with old/new line numbers, +/- markers, and
 * emerald/red row tints for additions/deletions. Includes a "Copy new"
 * button (copies the post-edit content) and an optional "Apply" button.
 *
 * Behaviour:
 *  - Collapsed by default: shows only changed lines (+/-) with 1 line of
 *    context above/below. Expands to the full file diff on click.
 *  - If there are no changes (identical old/new), shows a muted
 *    "No changes" note instead of an empty diff.
 *  - Expand/collapse cross-fades via Framer Motion.
 */
export function DiffViewer({
  path,
  oldContent,
  newContent,
  onApply,
  applyBusy,
  hideApply,
  className,
}: DiffViewerProps) {
  const allLines = React.useMemo(
    () => computeUnifiedDiff(oldContent ?? "", newContent ?? ""),
    [oldContent, newContent],
  );

  // Antigravity-style: collapsed by default, showing only changed lines (+/-)
  // with 1 line of context above/below. Expand to see the full file diff.
  const [expanded, setExpanded] = React.useState(false);

  const lines = React.useMemo(() => {
    if (expanded) return allLines;
    // Collapsed: show only hunks containing changes, with 1 line of context.
    return collapseToChanged(allLines, 1);
  }, [allLines, expanded]);

  const additions = allLines.filter((l) => l.type === "add").length;
  const deletions = allLines.filter((l) => l.type === "del").length;
  const hasChanges = additions > 0 || deletions > 0;
  const hiddenLines = allLines.length - lines.length;

  const [copied, setCopied] = React.useState(false);
  const copyNew = async () => {
    try {
      await navigator.clipboard.writeText(newContent ?? "");
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      // ignore
    }
  };

  return (
    <div className={cn("rounded-md border bg-card", className)}>
      <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-1.5">
        <FilePen className="size-3.5 text-muted-foreground shrink-0" />
        <span className="font-mono text-[11px] text-foreground/90 truncate flex-1 min-w-0">
          {path}
        </span>
        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[10px] leading-none text-emerald-600 dark:text-emerald-400">
          +{additions}
        </span>
        <span className="inline-flex items-center gap-1 rounded-full bg-red-500/10 px-1.5 py-0.5 font-mono text-[10px] leading-none text-red-600 dark:text-red-400">
          −{deletions}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-[11px] gap-1.5"
          onClick={copyNew}
          aria-label="Copy new content"
        >
          {copied ? (
            <>
              <Check className="size-3 text-brand" /> Copied
            </>
          ) : (
            <>
              <Copy className="size-3" /> Copy new
            </>
          )}
        </Button>
        {!hideApply && onApply && (
          <Button
            variant="outline"
            size="sm"
            className="h-6 px-2 text-[11px] gap-1.5"
            onClick={onApply}
            disabled={applyBusy}
            aria-label="Apply edit"
          >
            <FileCheck2 className="size-3 text-brand" />
            {applyBusy ? "Applying…" : "Apply"}
          </Button>
        )}
      </div>

      {!hasChanges ? (
        <div className="flex items-center gap-2 px-3 py-2 text-[11px] text-muted-foreground italic">
          <Minus className="size-3" aria-hidden />
          No changes
        </div>
      ) : (
        <>
          {/* Cross-fade between collapsed / expanded views for a smoother
              expand/collapse transition. AnimatePresence + key on the
              expanded state lets Framer Motion handle the swap. */}
          <AnimatePresence initial={false} mode="wait">
            <motion.div
              key={expanded ? "expanded" : "collapsed"}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15, ease: "easeOut" }}
              className="max-h-[60vh] overflow-y-auto overflow-x-hidden"
            >
              <div className="font-mono text-[11px] leading-relaxed">
                {lines.map((line, i) => (
                  <DiffRow key={i} line={line} />
                ))}
              </div>
            </motion.div>
          </AnimatePresence>
          {hiddenLines > 0 && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="w-full border-t bg-muted/30 px-3 py-1.5 text-center text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
            >
              Show {hiddenLines} more unchanged {hiddenLines === 1 ? "line" : "lines"}
            </button>
          )}
          {expanded && allLines.length > 10 && (
            <button
              type="button"
              onClick={() => setExpanded(false)}
              className="w-full border-t bg-muted/30 px-3 py-1.5 text-center text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
            >
              Collapse to changes only
            </button>
          )}
        </>
      )}
    </div>
  );
}


/**
 * Collapse a full diff to only the changed lines (+/-) with `context` lines
 * of surrounding context. Hunk separators ("…") are inserted between non-
 * adjacent changed regions. This gives an Antigravity-style compact diff
 * that hides unchanged code unless the user expands.
 */
function collapseToChanged(lines: DiffLine[], context: number = 1): DiffLine[] {
  const result: DiffLine[] = [];
  const changedIdx: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].type === "add" || lines[i].type === "del") {
      changedIdx.push(i);
    }
  }
  if (changedIdx.length === 0) return lines.slice(0, 5);
  let lastEnd = -1;
  for (const idx of changedIdx) {
    const start = Math.max(0, idx - context);
    const end = Math.min(lines.length - 1, idx + context);
    if (lastEnd >= 0 && start > lastEnd + 1) {
      result.push({ type: "hunk", oldNo: null, newNo: null, text: "…" });
    }
    for (let i = Math.max(lastEnd + 1, start); i <= end; i++) {
      result.push(lines[i]);
    }
    lastEnd = end;
  }
  return result;
}

/**
 * Compute a unified line diff using a simple LCS dynamic-programming
 * approach. Produces context + add + del lines with old/new line numbers,
 * plus a single leading hunk header (small files only — fine for IDE tool
 * results which are typically small file edits).
 */
function computeUnifiedDiff(oldStr: string, newStr: string): DiffLine[] {
  const oldLines = oldStr.length === 0 ? [] : oldStr.split("\n");
  const newLines = newStr.length === 0 ? [] : newStr.split("\n");

  const m = oldLines.length;
  const n = newLines.length;

  // Build LCS length table.
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (oldLines[i] === newLines[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  // Backtrack to build the diff.
  type Raw = { type: "context" | "add" | "del"; oldIdx: number; newIdx: number; text: string };
  const raw: Raw[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) {
      raw.push({ type: "context", oldIdx: i, newIdx: j, text: oldLines[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      raw.push({ type: "del", oldIdx: i, newIdx: j, text: oldLines[i] });
      i++;
    } else {
      raw.push({ type: "add", oldIdx: i, newIdx: j, text: newLines[j] });
      j++;
    }
  }
  while (i < m) {
    raw.push({ type: "del", oldIdx: i, newIdx: j, text: oldLines[i] });
    i++;
  }
  while (j < n) {
    raw.push({ type: "add", oldIdx: i, newIdx: j, text: newLines[j] });
    j++;
  }

  // Convert to DiffLine with old/new line numbers (1-based for display).
  const out: DiffLine[] = [];
  // Single hunk header covering the whole file.
  out.push({
    type: "hunk",
    oldNo: null,
    newNo: null,
    text: `@@ -1,${m} +1,${n} @@`,
  });
  for (const r of raw) {
    out.push({
      type: r.type,
      oldNo: r.type === "del" || r.type === "context" ? r.oldIdx + 1 : null,
      newNo: r.type === "add" || r.type === "context" ? r.newIdx + 1 : null,
      text: r.text,
    });
  }
  return out;
}
