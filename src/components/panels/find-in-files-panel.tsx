"use client";

import * as React from "react";
import {
  Search,
  Loader2,
  FileText,
  ChevronDown,
  ChevronRight,
  X,
  AlertCircle,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAppStore } from "@/stores/app-store";
import { apiGet, ApiRequestError } from "@/lib/api-client";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ *
 * FindInFilesPanel
 *
 * VS Code-style "Find in Files" overlay. Triggered by ⌘⇧F (or via
 * the command palette "Find in files"). Renders a centered Dialog
 * (max-w-2xl, max-h-[80vh]) with a search bar, file-pattern input,
 * max-results select, and results grouped by file.
 *
 * Uses GET /api/workspace/grep?q=<query>&filePattern=<glob>&maxResults=<n>&regex=<0|1>.
 * The `.*` toggle next to
 * the query input switches between literal substring search and regex search
 * (same semantics as the agent's `grep` tool). The grep endpoint
 * returns { matches: GrepMatch[], query, workspace: { name } } where
 * each match has { path, line (1-based), column, preview, matchStart,
 * matchEnd }.
 *
 * Clicking a file header or a match row dispatches `hermos:open-file`
 * (with the path) and switches the right panel to the Files tab so the
 * workspace panel can open the file. The line/column are passed in the
 * event detail so a future listener can scroll to the match.
 * ------------------------------------------------------------------ */

interface GrepMatch {
  path: string;
  line: number;
  column: number;
  preview: string;
  matchStart: number;
  matchEnd: number;
}

interface GrepResponse {
  matches: GrepMatch[];
  query: string;
  workspace: { name: string };
}

const MAX_RESULTS_OPTIONS = [50, 100, 200] as const;
const DEBOUNCE_MS = 300;
const PREVIEW_PER_FILE = 5;

/** Event detail for `hermos:open-file`. Adds optional line/column so a
 *  listener can scroll to the match. */
interface OpenFileDetail {
  path: string;
  line?: number;
  column?: number;
}

function dispatchOpenFile(detail: OpenFileDetail) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<OpenFileDetail>("hermos:open-file", { detail }),
  );
}

interface FileGroup {
  path: string;
  matches: GrepMatch[];
}

function groupByPath(matches: GrepMatch[]): FileGroup[] {
  const map = new Map<string, GrepMatch[]>();
  for (const m of matches) {
    let arr = map.get(m.path);
    if (!arr) {
      arr = [];
      map.set(m.path, arr);
    }
    arr.push(m);
  }
  // Stable order — preserve first-appearance order across files.
  return Array.from(map.entries()).map(([path, list]) => ({ path, matches: list }));
}

export function FindInFilesPanel() {
  const open = useAppStore((s) => s.findInFilesOpen);
  const setOpen = useAppStore((s) => s.setFindInFilesOpen);
  const setRightPanelTab = useAppStore((s) => s.setRightPanelTab);

  const [query, setQuery] = React.useState("");
  const [useRegex, setUseRegex] = React.useState(false);
  const [filePattern, setFilePattern] = React.useState("");
  const [maxResults, setMaxResults] = React.useState<number>(100);

  const [results, setResults] = React.useState<GrepMatch[] | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Reset state when the dialog closes so the next open starts fresh.
  React.useEffect(() => {
    if (!open) {
      // Keep the query (so re-opening mid-search resumes) but clear
      // stale results/errors.
      setError(null);
    }
  }, [open]);

  // Debounced search. Triggered by query / filePattern / maxResults.
  React.useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (!q) {
      setResults(null);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    const t = setTimeout(() => {
      const params: Record<string, unknown> = {
        q,
        maxResults,
      };
      if (useRegex) params.regex = "1";
      if (filePattern.trim()) params.filePattern = filePattern.trim();
      apiGet<GrepResponse>("/api/workspace/grep", {
        query: params,
        timeoutMs: 5 * 60_000,
      })
        .then((res) => {
          if (cancelled) return;
          setResults(res?.matches ?? []);
        })
        .catch((e: unknown) => {
          if (cancelled) return;
          setResults([]);
          if (e instanceof ApiRequestError && (e.status === 404 || e.status === 405)) {
            setError("Workspace search is not available.");
          } else if (e instanceof ApiRequestError) {
            setError(e.message || "Search failed.");
          } else {
            setError("Search failed.");
          }
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, useRegex, filePattern, maxResults, open]);

  // Keyboard: Esc is handled by Dialog. ⌘F inside the dialog focuses the
  // search input (browser default for ⌘F is hijacked to prevent clashing
  // with the in-page find bar while our modal is open).
  const searchInputRef = React.useRef<HTMLInputElement | null>(null);
  React.useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => searchInputRef.current?.focus(), 60);
    return () => clearTimeout(t);
  }, [open]);

  const handleOpenFile = React.useCallback(
    (path: string, line?: number, column?: number) => {
      setRightPanelTab("files");
      dispatchOpenFile({ path, line, column });
    },
    [setRightPanelTab],
  );

  const groups = React.useMemo(
    () => (results ? groupByPath(results) : []),
    [results],
  );
  const totalFiles = groups.length;
  const totalMatches = results?.length ?? 0;
  const hasQuery = query.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        className="sm:max-w-2xl p-0 gap-0 overflow-hidden max-h-[80vh] flex flex-col"
        showCloseButton={false}
      >
        <DialogHeader className="px-4 pt-4 pb-3 border-b shrink-0">
          <DialogTitle className="text-sm font-semibold flex items-center gap-2">
            <Search className="size-3.5 text-brand" />
            Find in files
          </DialogTitle>
          <DialogDescription className="text-xs">
            Search across every file in the active workspace. Click a result
            to open it in the editor.
          </DialogDescription>
        </DialogHeader>

        {/* Search bar */}
        <div className="flex flex-col sm:flex-row gap-2 px-4 py-3 border-b shrink-0 bg-muted/30">
          <div className="relative flex-1 min-w-0">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              ref={searchInputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search in files…"
              className="h-8 pl-8 text-sm"
              spellCheck={false}
              autoComplete="off"
              aria-label="Search query"
            />
            <button
              type="button"
              onClick={() => setUseRegex((v) => !v)}
              aria-label={
                useRegex ? "Search using a regular expression (on)" : "Search using a regular expression (off)"
              }
              aria-pressed={useRegex}
              title={useRegex ? "Regex: on — special characters are pattern syntax" : "Regex: off — literal text search"}
              className={cn(
                "absolute right-8 top-1/2 -translate-y-1/2 rounded-sm px-1 py-0.5 font-mono text-[11px] leading-none transition-colors",
                useRegex
                  ? "bg-brand/15 text-brand hover:bg-brand/25"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              .*
            </button>
            {query && (
              <button
                type="button"
                onClick={() => {
                  setQuery("");
                  searchInputRef.current?.focus();
                }}
                aria-label="Clear search"
                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
          <div className="flex gap-2 shrink-0">
            <Input
              value={filePattern}
              onChange={(e) => setFilePattern(e.target.value)}
              placeholder="*.ts"
              className="h-8 w-28 sm:w-32 text-xs font-mono"
              spellCheck={false}
              autoComplete="off"
              aria-label="File pattern (glob)"
            />
            <Select
              value={String(maxResults)}
              onValueChange={(v) => setMaxResults(Number(v))}
            >
              <SelectTrigger
                size="sm"
                className="h-8 w-[5.5rem] text-xs"
                aria-label="Max results"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MAX_RESULTS_OPTIONS.map((n) => (
                  <SelectItem key={n} value={String(n)} className="text-xs">
                    {n}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Results */}
        <div className="min-h-0 flex-1 bg-background">
          <ScrollArea className="h-full">
            <div className="min-h-full">
              {!hasQuery ? (
                <EmptyState
                  icon={<Search className="size-7 text-muted-foreground/40" />}
                  title="Type to search"
                  description="Search across your workspace files."
                />
              ) : loading ? (
                <ResultsSkeleton />
              ) : error ? (
                <EmptyState
                  icon={<AlertCircle className="size-7 text-amber-500" />}
                  title="Search unavailable"
                  description={error}
                />
              ) : groups.length === 0 ? (
                <EmptyState
                  icon={<Search className="size-7 text-muted-foreground/40" />}
                  title="No results found"
                  description={
                    <>
                      No matches for{" "}
                      <code className="font-mono text-[11px] bg-muted px-1 py-0.5 rounded">
                        {query.trim()}
                      </code>
                      {filePattern.trim() && (
                        <>
                          {" "}in{" "}
                          <code className="font-mono text-[11px] bg-muted px-1 py-0.5 rounded">
                            {filePattern.trim()}
                          </code>
                        </>
                      )}
                      .
                    </>
                  }
                />
              ) : (
                <ul className="divide-y divide-border/60">
                  {groups.map((g) => (
                    <li key={g.path}>
                      <FileGroupRow group={g} onOpenFile={handleOpenFile} />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </ScrollArea>
        </div>

        {/* Footer */}
        <DialogFooter className="px-4 py-2.5 border-t bg-muted/30 flex-row items-center justify-between sm:justify-between shrink-0">
          <span className="text-[11px] font-mono text-muted-foreground tabular-nums">
            {hasQuery && !loading && !error && results
              ? `${totalMatches} ${totalMatches === 1 ? "result" : "results"} in ${totalFiles} ${totalFiles === 1 ? "file" : "files"}`
              : "\u00A0"}
          </span>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={() => setOpen(false)}
          >
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ *
 * File group row — header (path + count, click opens the file) and
 * the list of match rows. Shows up to PREVIEW_PER_FILE by default
 * with a "Show N more" expand button.
 * ------------------------------------------------------------------ */

function FileGroupRow({
  group,
  onOpenFile,
}: {
  group: FileGroup;
  onOpenFile: (path: string, line?: number, column?: number) => void;
}) {
  const [expanded, setExpanded] = React.useState(false);
  const visible = expanded
    ? group.matches
    : group.matches.slice(0, PREVIEW_PER_FILE);
  const hiddenCount = group.matches.length - visible.length;

  return (
    <div className="px-2 py-1.5">
      <button
        type="button"
        onClick={() => onOpenFile(group.path)}
        className="group flex w-full items-center gap-1.5 rounded-md px-2 py-1 hover:bg-accent/60 transition-colors text-left"
        aria-label={`Open ${group.path}`}
      >
        <FileText className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="font-mono text-[11px] text-brand truncate min-w-0">
          {group.path}
        </span>
        <Badge
          variant="outline"
          className="ml-auto shrink-0 text-[9px] h-4 px-1 font-mono tabular-nums"
        >
          {group.matches.length}
        </Badge>
      </button>
      <ul className="mt-0.5 ml-5 space-y-0.5">
        {visible.map((m, i) => (
          <li key={`${m.path}:${m.line}:${i}`}>
            <MatchRow match={m} onOpenFile={onOpenFile} />
          </li>
        ))}
      </ul>
      {hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="ml-5 mt-0.5 inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors"
        >
          <ChevronRight className="size-3" />
          Show {hiddenCount} more
        </button>
      )}
      {expanded && group.matches.length > PREVIEW_PER_FILE && (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="ml-5 mt-0.5 inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors"
        >
          <ChevronDown className="size-3" />
          Collapse
        </button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Match row — line number (mono, muted, w-10, right-aligned,
 * tabular-nums) + the line preview with the match highlighted.
 * ------------------------------------------------------------------ */

function MatchRow({
  match,
  onOpenFile,
}: {
  match: GrepMatch;
  onOpenFile: (path: string, line?: number, column?: number) => void;
}) {
  const before = match.preview.slice(0, match.matchStart);
  const hit = match.preview.slice(match.matchStart, match.matchEnd);
  const after = match.preview.slice(match.matchEnd);

  return (
    <button
      type="button"
      onClick={() => onOpenFile(match.path, match.line, match.column)}
      className="group flex w-full items-start gap-2 rounded-md px-2 py-1 hover:bg-accent/60 transition-colors text-left"
      aria-label={`Open ${match.path} at line ${match.line}`}
    >
      <span className="font-mono text-[10px] text-muted-foreground/80 w-10 shrink-0 text-right pt-px tabular-nums select-none">
        {match.line}
      </span>
      <span className="font-mono text-[11px] leading-snug min-w-0 flex-1 whitespace-pre-wrap break-all">
        {before}
        <mark className="bg-brand/20 text-brand rounded px-0.5">
          {hit}
        </mark>
        {after}
      </span>
    </button>
  );
}

/* ------------------------------------------------------------------ *
 * States
 * ------------------------------------------------------------------ */

function EmptyState({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center text-center px-6 py-16">
      {icon}
      <p className="mt-3 text-sm font-medium text-foreground">{title}</p>
      <p className="mt-1 text-xs text-muted-foreground max-w-sm">{description}</p>
    </div>
  );
}

function ResultsSkeleton() {
  return (
    <div className="px-2 py-2 space-y-3">
      {Array.from({ length: 4 }).map((_, gi) => (
        <div key={gi} className="space-y-1.5">
          <div className="flex items-center gap-2 px-2">
            <Skeleton className="size-3.5 rounded" />
            <Skeleton className="h-3 w-40" />
            <Skeleton className="h-4 w-6 ml-auto" />
          </div>
          <div className="ml-5 space-y-1">
            {Array.from({ length: 3 }).map((_, ri) => (
              <div
                key={ri}
                className="flex items-start gap-2 px-2"
              >
                <Skeleton className="h-3 w-8 shrink-0" />
                <Skeleton
                  className="h-3"
                  style={{ width: `${60 + ((ri * 17) % 30)}%` }}
                />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * LoaderGlyph — small re-export for callers that want a tiny inline
 * spinner (e.g. embedding the search state in a tooltip).
 * ------------------------------------------------------------------ */
export function FindInFilesSpinner({ className }: { className?: string }) {
  return <Loader2 className={cn("size-3 animate-spin", className)} />;
}

/** Re-exported for callers that want to dispatch open-file events with
 *  line/column metadata (kept here so the event shape is owned by the
 *  panel that originally introduced it). */
export function dispatchFindInFilesOpenFile(detail: OpenFileDetail) {
  dispatchOpenFile(detail);
}

/** Re-exported so tooltips elsewhere (e.g. top-bar) can describe the
 *  panel without re-importing internal types. */
export type { OpenFileDetail as FindInFilesOpenFileDetail };

/** A tooltip helper for buttons that trigger the find-in-files overlay.
 *  Renders a short label with the ⌘⇧F shortcut. */
export function FindInFilesTriggerTooltip({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="bottom" className="text-[11px]">
        Find in files (⌘⇧F)
      </TooltipContent>
    </Tooltip>
  );
}
