"use client";

import * as React from "react";
import {
  FilePlus,
  FileMinus,
  FilePen,
  ArrowRightLeft,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { DiffRow, type SharedDiffLine } from "@/components/ui/diff-row";

/* ------------------------------------------------------------------ *
 * git-diff-view.tsx — renders a unified git diff (multiple files with
 * patches) inside a Dialog.
 *
 * The backend's `GET /api/git/status` returns a `diff` string in
 * unified-diff format:
 *
 *   diff --git a/foo.ts b/foo.ts
 *   index abc..def 100644
 *   --- a/foo.ts
 *   +++ b/foo.ts
 *   @@ -10,3 +10,4 @@
 *    context line
 *   -removed line
 *   +added line
 *
 * We parse it into per-file sections (split on `diff --git` headers)
 * and render each file with:
 *   - A header row: file path (mono, emerald for added / amber for
 *     modified / red for deleted) + additions/deletions count.
 *   - The unified patch body, reusing the DiffViewer's line-rendering
 *     style: green `+`, red `-`, line numbers from the hunk header.
 *
 * The whole thing lives inside a ScrollArea with max-h-[60vh] so
 * large diffs don't blow up the dialog.
 * ------------------------------------------------------------------ */

interface GitDiffViewProps {
  /** Raw unified-diff text. Empty when there are no changes. */
  diff: string;
  className?: string;
}

interface ParsedFile {
  /** Old path (from `--- a/...`). */
  oldPath: string;
  /** New path (from `+++ b/...`). */
  newPath: string;
  /** Display path (newPath when present, else oldPath). */
  displayPath: string;
  /** Change kind inferred from the diff headers. */
  kind: "added" | "modified" | "deleted" | "renamed";
  /** Raw patch body (everything after the +++ line). */
  body: string;
  additions: number;
  deletions: number;
}

type DiffLine = SharedDiffLine;

export function GitDiffView({ diff, className }: GitDiffViewProps) {
  const files = React.useMemo(() => parseUnifiedDiff(diff), [diff]);
  const [expandAll, setExpandAll] = React.useState(true);

  if (files.length === 0) {
    return (
      <div
        className={cn(
          "flex items-center justify-center rounded-md border bg-card p-8 text-center text-xs text-muted-foreground",
          className,
        )}
      >
        No changes to display.
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col h-full min-h-0 rounded-md border bg-card overflow-hidden", className)}>
      <div className="flex items-center justify-between border-b bg-muted/40 px-3 py-1.5 shrink-0 text-xs">
        <span className="font-mono text-[11px] text-muted-foreground">
          {files.length} file{files.length === 1 ? "" : "s"} changed
        </span>
        <button
          type="button"
          onClick={() => setExpandAll((v) => !v)}
          className="text-[11px] font-medium text-brand hover:underline"
        >
          {expandAll ? "Collapse all" : "Expand all"}
        </button>
      </div>
      <ScrollArea className="flex-1 min-h-0 w-full overflow-auto">
        <div className="divide-y divide-border min-w-full">
          {files.map((f, i) => (
            <FileDiff key={`${f.displayPath}-${i}`} file={f} forceOpen={expandAll} />
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}

/* ------------------------------ File diff ------------------------------ */

function FileDiff({ file, forceOpen }: { file: ParsedFile; forceOpen?: boolean }) {
  const lines = React.useMemo(() => parsePatchBody(file.body), [file.body]);
  const [open, setOpen] = React.useState(true);

  React.useEffect(() => {
    if (forceOpen !== undefined) {
      setOpen(forceOpen);
    }
  }, [forceOpen]);

  const headerColor =
    file.kind === "added"
      ? "text-emerald-700 dark:text-emerald-400"
      : file.kind === "deleted"
        ? "text-red-700 dark:text-red-400"
        : file.kind === "renamed"
          ? "text-amber-700 dark:text-amber-400"
          : "text-amber-700 dark:text-amber-400";

  const KindIcon =
    file.kind === "added"
      ? FilePlus
      : file.kind === "deleted"
        ? FileMinus
        : file.kind === "renamed"
          ? ArrowRightLeft
          : FilePen;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="w-full">
        <div className="flex items-center gap-2 bg-muted/40 px-3 py-1.5 hover:bg-muted/60 transition-colors cursor-pointer select-none">
          {open ? (
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <KindIcon className={cn("size-3.5 shrink-0", headerColor)} />
          <span
            className={cn(
              "flex-1 min-w-0 truncate font-mono text-[11px] text-left",
              headerColor,
            )}
            title={file.displayPath}
          >
            {file.displayPath}
            {file.kind === "renamed" && file.oldPath !== file.newPath && (
              <span className="text-muted-foreground">
                {" "}
                (from {file.oldPath})
              </span>
            )}
          </span>
          <span className="font-mono text-[10px] text-emerald-600 dark:text-emerald-400 tabular-nums">
            +{file.additions}
          </span>
          <span className="font-mono text-[10px] text-red-600 dark:text-red-400 tabular-nums">
            −{file.deletions}
          </span>
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="font-mono text-[11px] leading-relaxed">
          {lines.map((line, i) => (
            <DiffRow key={i} line={line} />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}


/* ------------------------------ Parsing ------------------------------ */

/**
 * Split a unified-diff string into per-file sections. Each section
 * starts at a `diff --git` line and includes the headers (index, ---,
 * +++) and the patch body (hunks).
 *
 * Returns an empty array when the input is empty or doesn't look like
 * a unified diff (e.g. the backend returned an error string).
 */
function parseUnifiedDiff(diff: string): ParsedFile[] {
  if (!diff || !diff.trim()) return [];
  // Split on `diff --git` boundaries. Keep the delimiter.
  const chunks = diff.split(/^(?=diff --git )/m);
  const files: ParsedFile[] = [];
  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    if (!chunk.startsWith("diff --git ")) continue;
    const parsed = parseFileChunk(chunk);
    if (parsed) files.push(parsed);
  }
  return files;
}

function parseFileChunk(chunk: string): ParsedFile | null {
  // Detect rename: `rename from foo` / `rename to bar` lines, or the
  // `--- a/` / `+++ b/` paths differ. Also detect new/deleted files
  // via `new file mode` / `deleted file mode` headers.
  const oldPathMatch = chunk.match(/^---\s+(?:a\/)?(.+)$/m);
  const newPathMatch = chunk.match(/^\+\+\+\s+(?:b\/)?(.+)$/m);
  const oldPath = oldPathMatch?.[1]?.trim() ?? "";
  const newPath = newPathMatch?.[1]?.trim() ?? "";

  // `/dev/null` indicates a creation or deletion.
  const isNew = oldPath === "/dev/null" || chunk.includes("new file mode");
  const isDeleted = newPath === "/dev/null" || chunk.includes("deleted file mode");
  const isRenamed =
    !isNew &&
    !isDeleted &&
    oldPath !== "" &&
    newPath !== "" &&
    oldPath !== newPath;

  const displayPath = newPath && newPath !== "/dev/null" ? newPath : oldPath;
  if (!displayPath) return null;

  const kind: ParsedFile["kind"] = isNew
    ? "added"
    : isDeleted
      ? "deleted"
      : isRenamed
        ? "renamed"
        : "modified";

  // Body = everything from the first `@@` hunk header onwards.
  const hunkIdx = chunk.indexOf("@@");
  const body = hunkIdx >= 0 ? chunk.slice(hunkIdx) : "";

  let additions = 0;
  let deletions = 0;
  for (const line of body.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
  }

  return {
    oldPath,
    newPath,
    displayPath,
    kind,
    body,
    additions,
    deletions,
  };
}

/**
 * Parse the patch body (hunks + content lines) into renderable
 * DiffLines with old/new line numbers. The hunk header
 * `@@ -start,len +start,len @@` carries the starting line numbers;
 * we walk the body tracking them.
 */
function parsePatchBody(body: string): DiffLine[] {
  if (!body) return [];
  const out: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  const lines = body.split("\n");
  for (const line of lines) {
    if (line.startsWith("@@")) {
      // Hunk header: `@@ -oldStart,oldLen +newStart,newLen @@`
      const m = line.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
      if (m) {
        oldNo = parseInt(m[1], 10);
        newNo = parseInt(m[2], 10);
      }
      out.push({ type: "hunk", text: line, oldNo: null, newNo: null });
      continue;
    }
    if (
      line.startsWith("diff --git") ||
      line.startsWith("index ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ") ||
      line.startsWith("new file mode") ||
      line.startsWith("deleted file mode") ||
      line.startsWith("old mode") ||
      line.startsWith("new mode") ||
      line.startsWith("rename from") ||
      line.startsWith("rename to") ||
      line.startsWith("similarity index") ||
      line.startsWith("copy from") ||
      line.startsWith("copy to")
    ) {
      out.push({ type: "meta", text: line, oldNo: null, newNo: null });
      continue;
    }
    if (line.startsWith("+")) {
      out.push({
        type: "add",
        text: line.slice(1),
        oldNo: null,
        newNo: newNo || null,
      });
      newNo++;
    } else if (line.startsWith("-")) {
      out.push({
        type: "del",
        text: line.slice(1),
        oldNo: oldNo || null,
        newNo: null,
      });
      oldNo++;
    } else if (line.startsWith("\\")) {
      // `\ No newline at end of file` marker — render as meta.
      out.push({ type: "meta", text: line, oldNo: null, newNo: null });
    } else {
      // Context line (may start with a space or be empty).
      const text = line.startsWith(" ") ? line.slice(1) : line;
      out.push({
        type: "context",
        text,
        oldNo: oldNo || null,
        newNo: newNo || null,
      });
      oldNo++;
      newNo++;
    }
  }
  return out;
}
