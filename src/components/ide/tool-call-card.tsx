"use client";

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  ChevronRight,
  Loader2,
  CheckCircle2,
  XCircle,
  FileText,
  Terminal as TerminalIcon,
  Globe,
  Plug,
  Wrench,
  Copy,
  Check,
  FilePlus2,
  Trash2,
  Folder,
  Search,
  ExternalLink,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";

import { cn, parsePartialJson } from "@/lib/utils";
import { FILE_OP_TOOLS, computeDiffStats, fileTypeIconMeta, formatBytes } from "@/lib/tool-ui-shared";
import { DiffViewer } from "@/components/ide/diff-viewer";
import { CodeBlock } from "@/components/ide/code-block";
import { useAppStore, type LiveToolCall } from "@/stores/app-store";

interface ToolCallCardProps {
  tc: LiveToolCall;
  /** Default expanded state — caller can override based on result size. */
  defaultOpen?: boolean;
}

/** Tool names that carry a shell command. */
const SHELL_OP_TOOLS = new Set(["run_command", "run_terminal", "terminal", "command_run"]);

/**
 * Polished, collapsible tool-call card rendered inline in assistant messages.
 *
 * The card appears IMMEDIATELY when `tool_call_start` fires (status="running")
 * — it does not wait for the result. While running it shows a spinner + the
 * tool name + a one-line argument summary. When the result lands it expands
 * to show the diff (for file ops), stdout/stderr (for run_command), or a
 * generic JSON result (for everything else).
 *
 * File operations get a dedicated file-path row with a Copy-path button.
 * run_command gets a terminal-style command header. The card is always
 * visible (no overflow:hidden on the outer container, no z-index tricks).
 */
export function ToolCallCard({ tc, defaultOpen }: ToolCallCardProps) {
  const activeWorkspace = useAppStore((s) => s.activeWorkspace);
  const wsName = activeWorkspace?.name || "workspace";

  const args = React.useMemo(
    () => tc.parsedArgs ?? safeParse(tc.args),
    [tc.parsedArgs, tc.args],
  );

  // Collapsed by default. The user can expand to see details.
  const initialOpen = defaultOpen ?? false;

  const [open, setOpen] = React.useState(initialOpen);

  const summary = React.useMemo(() => makeArgsSummary(tc.name, args, wsName), [tc.name, args, wsName]);
  const status = tc.status;
  const durationLabel = React.useMemo(() => maybeDuration(args), [args]);

  const isDirOp = tc.name === "list_directory" || tc.name === "list_dir";
  const isFileOp = FILE_OP_TOOLS.has(tc.name) || isDirOp;
  const isShellOp = SHELL_OP_TOOLS.has(tc.name);

  // The file path for file ops (used for the dedicated path row + copy button).
  const filePath = isFileOp && args ? extractFilePath(args) : null;

  // The shell command for run_command (shown in a terminal-style header).
  const shellCommand = isShellOp && args ? extractCommand(args) : null;

  // Compute diff stats from old/new content directly (consistent with DiffViewer).
  // Falls back to tool arguments (works for both running & done states, and streaming args).
  // Memoized: countDiffLines is O(n*m) — running it on every re-render of a
  // large file diff would burn CPU while the parent list re-renders.
  const diffStats = React.useMemo(
    () => computeDiffStats(tc.name, tc.result, args),
    [tc.name, tc.result, args],
  );

  // "Created" badge for write_file on a new file.
  const isCreatedFile =
    tc.name === "write_file" &&
    tc.result !== undefined &&
    typeof tc.result === "object" &&
    tc.result !== null &&
    (tc.result as { created?: boolean }).created === true;

  const compactArgs = React.useMemo(
    () => (args ? formatArgsCompact(tc.name, args) : ""),
    [tc.name, args]
  );

  return (
    <div
      className={cn(
        "group/tc relative rounded border border-border/40 bg-zinc-500/5 hover:bg-zinc-500/10 text-zinc-800 dark:text-zinc-200 transition-colors my-0.5",
        status === "error" && "border-red-500/40 bg-red-500/5",
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-xs transition-colors"
      >
        <ToolStatusIcon status={status} />
        <ToolIcon name={tc.name} className="size-3.5 text-brand shrink-0" />
        <span className="font-mono text-[11px] font-medium text-foreground shrink-0">{formatToolDisplayName(tc.name)}</span>
        {isCreatedFile && (
          <Badge
            variant="outline"
            className="h-3.5 px-1 text-[8px] font-mono border-0 bg-emerald-500/15 text-emerald-400 shrink-0"
          >
            <FilePlus2 className="size-2 mr-0.5" />
            NEW
          </Badge>
        )}
        {summary && (
          <span className="font-mono text-[11px] text-foreground/90 truncate min-w-0 flex-1">
            <span className="text-foreground/40 mx-1">·</span>
            {summary}
          </span>
        )}
        {diffStats && (
          <span className="flex items-center gap-1 shrink-0 font-mono text-[10px]">
            <span className="text-emerald-500 dark:text-emerald-400">+{diffStats.add}</span>
            <span className="text-red-500 dark:text-red-400">-{diffStats.del}</span>
          </span>
        )}
        <span className="ml-auto flex items-center gap-1.5 shrink-0">
          {durationLabel && (
            <span className="font-mono text-[10px] text-foreground font-medium">
              {durationLabel}
            </span>
          )}
          <ChevronRight
            className={cn(
              "size-3 text-foreground/80 transition-transform",
              open && "rotate-90",
            )}
          />
        </span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
            className="overflow-hidden"
          >
            <div className="border-t border-white/10 px-2.5 py-2 space-y-2">
              {/* File/dir path row — shows the full path with copy button. */}
              {filePath && !isDirOp && (
                <FilePathRow path={filePath} isDir={isDirOp} />
              )}
              {/* Terminal-style command header for run_command. */}
              {shellCommand && (
                <CommandHeader command={shellCommand} />
              )}
              {/* Compact args display (omits path/command/keys shown above). */}
              {compactArgs.length > 0 && (
                <pre className="font-mono text-[11px] whitespace-pre-wrap break-words text-zinc-500 dark:text-zinc-400 bg-black/5 dark:bg-black/30 rounded px-2 py-1.5">
                  {compactArgs}
                </pre>
              )}
              <ToolResultBody tc={tc} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** File-type icon based on extension. */
export function FileTypeIcon({ ext, className }: { ext: string; className?: string }) {
  const meta = React.useMemo(() => fileTypeIconMeta(ext), [ext]);
  const Icon = meta.icon;
  return <Icon className={cn(meta.color, className)} />;
}

/** Open file in editor and reveal in workspace panel. */
function handleOpenFile(filePath: string, line?: number) {
  if (!filePath) return;
  const store = useAppStore.getState();
  if (/\.(pptx|docx|pdf)$/i.test(filePath)) {
    store.openFileTab(filePath);
    store.setRightPanelTab("office");
    store.setRightPanelOpen(true);
    return;
  }
  store.openFileTab(filePath);
  store.setRightPanelTab("files");
  store.setRightPanelOpen(true);
  if (typeof line === "number") {
    window.dispatchEvent(
      new CustomEvent("hermos:open-file", {
        detail: { path: filePath, line, column: 1, side: "left" },
      })
    );
  }
}

/* ----------------------------- File path row ----------------------------- */

function FilePathRow({ path, isDir }: { path: string; isDir?: boolean }) {
  const [copied, setCopied] = React.useState(false);
  const ext = React.useMemo(() => {
    const parts = path.split(".");
    return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : "";
  }, [path]);

  const onCopy = React.useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(path);
      setCopied(true);
      toast.success("Path copied");
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Copy failed");
    }
  }, [path]);

  return (
    <div className="flex items-center gap-1.5 rounded bg-black/5 dark:bg-black/40 border border-black/10 dark:border-white/5 px-2 py-1">
      {isDir ? (
        <Folder className="size-3.5 text-amber-500/90 dark:text-amber-400/90 shrink-0" />
      ) : (
        <FileTypeIcon ext={ext} className="size-3.5 shrink-0" />
      )}
      <code className="font-mono text-[11px] text-zinc-700 dark:text-zinc-300 truncate min-w-0 flex-1">
        {path}
      </code>
      <button
        type="button"
        onClick={onCopy}
        title="Copy path"
        aria-label="Copy path"
        className="shrink-0 rounded p-1 text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
      >
        {copied ? (
          <Check className="size-3 text-brand" />
        ) : (
          <Copy className="size-3" />
        )}
      </button>
    </div>
  );
}

/* --------------------------- Command header --------------------------- */

function CommandHeader({ command }: { command: string }) {
  const [copied, setCopied] = React.useState(false);
  const onCopy = React.useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      toast.success("Command copied");
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Copy failed");
    }
  }, [command]);

  return (
    <div className="flex items-start gap-1.5 rounded bg-black/5 dark:bg-black/60 border border-black/10 dark:border-white/5 px-2 py-1.5">
      <TerminalIcon className="size-3.5 text-zinc-500 dark:text-zinc-400 shrink-0 mt-0.5" />
      <code className="font-mono text-[11px] text-foreground whitespace-pre-wrap break-words min-w-0 flex-1">
        <span className="text-brand font-bold select-none">$ </span>
        {command}
      </code>
      <button
        type="button"
        onClick={onCopy}
        title="Copy command"
        aria-label="Copy command"
        className="shrink-0 rounded p-1 text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
      >
        {copied ? (
          <Check className="size-3 text-brand" />
        ) : (
          <Copy className="size-3" />
        )}
      </button>
    </div>
  );
}

/* ----------------------------- Result Views ----------------------------- */

export interface NormalizedDirEntry {
  name: string;
  path: string;
  type: "dir" | "file";
  size?: number;
}

export function DirectoryListingView({
  entries,
  basePath,
  totalFiles,
  totalDirs,
}: {
  entries: NormalizedDirEntry[];
  basePath?: string;
  totalFiles?: number;
  totalDirs?: number;
}) {
  const [copiedPath, setCopiedPath] = React.useState<string | null>(null);

  const handleCopy = async (path: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(path);
      setCopiedPath(path);
      toast.success("Path copied");
      setTimeout(() => setCopiedPath(null), 1500);
    } catch {
      toast.error("Copy failed");
    }
  };

  if (!entries || entries.length === 0) {
    return (
      <div className="rounded bg-black/5 dark:bg-black/30 border border-black/5 dark:border-white/5 px-3 py-2 text-xs text-muted-foreground italic font-mono">
        Empty directory
        {basePath && (
          <span className="block truncate font-mono not-italic" title={basePath}>
            {basePath}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <div className="rounded bg-black/5 dark:bg-black/30 border border-black/5 dark:border-white/5 p-1 max-h-72 overflow-y-auto space-y-0.5 font-mono text-[11px]">
        {entries.map((entry) => {
          const ext = entry.type === "file" && entry.name.includes(".") ? entry.name.split(".").pop()?.toLowerCase() || "" : "";
          const isDir = entry.type === "dir";

          return (
            <div
              key={entry.path || entry.name}
              onClick={() => {
                if (!isDir && entry.path) {
                  handleOpenFile(entry.path);
                }
              }}
              className={cn(
                "flex items-center gap-2 px-2 py-1 rounded transition-colors group/item select-none",
                !isDir ? "cursor-pointer hover:bg-black/5 dark:hover:bg-white/5" : "hover:bg-black/5 dark:hover:bg-white/5"
              )}
            >
              {isDir ? (
                <Folder className="size-3.5 text-amber-500/90 dark:text-amber-400/90 shrink-0" />
              ) : (
                <FileTypeIcon ext={ext} className="size-3.5 shrink-0" />
              )}
              <span
                className={cn(
                  "truncate min-w-0 flex-1",
                  isDir ? "font-medium text-foreground" : "text-zinc-700 dark:text-zinc-300 group-hover/item:text-foreground"
                )}
                title={entry.name}
              >
                {entry.name}
              </span>
              {typeof entry.size === "number" && entry.size >= 0 && (
                <span className="text-[10px] text-muted-foreground shrink-0 opacity-70">
                  {formatBytes(entry.size)}
                </span>
              )}
              {entry.path && (
                <button
                  type="button"
                  onClick={(e) => handleCopy(entry.path, e)}
                  title="Copy path"
                  className="opacity-0 group-hover/item:opacity-100 transition-opacity p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10 text-muted-foreground hover:text-foreground shrink-0"
                >
                  {copiedPath === entry.path ? (
                    <Check className="size-3 text-brand" />
                  ) : (
                    <Copy className="size-3" />
                  )}
                </button>
              )}
            </div>
          );
        })}
      </div>
      {(totalDirs !== undefined || totalFiles !== undefined) && (
        <div className="flex items-center justify-between px-1 text-[10px] font-mono text-muted-foreground">
          <span>
            {totalDirs !== undefined ? `${totalDirs} ${totalDirs === 1 ? "folder" : "folders"}` : ""}
            {totalDirs !== undefined && totalFiles !== undefined ? ", " : ""}
            {totalFiles !== undefined ? `${totalFiles} ${totalFiles === 1 ? "file" : "files"}` : ""}
          </span>
          {basePath && <span className="truncate max-w-[200px]" title={basePath}>{basePath}</span>}
        </div>
      )}
    </div>
  );
}

export function GlobResultView({
  matches,
  pattern,
  basePath,
}: {
  matches: string[];
  pattern?: string;
  basePath?: string;
}) {
  const [copiedPath, setCopiedPath] = React.useState<string | null>(null);

  const handleCopy = async (path: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(path);
      setCopiedPath(path);
      toast.success("Path copied");
      setTimeout(() => setCopiedPath(null), 1500);
    } catch {
      toast.error("Copy failed");
    }
  };

  if (!matches || matches.length === 0) {
    return (
      <div className="rounded bg-black/5 dark:bg-black/30 border border-black/5 dark:border-white/5 px-3 py-2 text-xs text-muted-foreground italic font-mono">
        No files matched {pattern ? `pattern "${pattern}"` : "query"}
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <div className="rounded bg-black/5 dark:bg-black/30 border border-black/5 dark:border-white/5 p-1 max-h-72 overflow-y-auto space-y-0.5 font-mono text-[11px]">
        {matches.map((filePath) => {
          const ext = filePath.includes(".") ? filePath.split(".").pop()?.toLowerCase() || "" : "";
          return (
            <div
              key={filePath}
              onClick={() => handleOpenFile(filePath)}
              className="flex items-center gap-2 px-2 py-1 rounded transition-colors group/item cursor-pointer hover:bg-black/5 dark:hover:bg-white/5 select-none"
            >
              <FileTypeIcon ext={ext} className="size-3.5 shrink-0" />
              <span className="truncate min-w-0 flex-1 text-zinc-700 dark:text-zinc-300 group-hover/item:text-foreground" title={filePath}>
                {filePath}
              </span>
              <button
                type="button"
                onClick={(e) => handleCopy(filePath, e)}
                title="Copy path"
                className="opacity-0 group-hover/item:opacity-100 transition-opacity p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10 text-muted-foreground hover:text-foreground shrink-0"
              >
                {copiedPath === filePath ? (
                  <Check className="size-3 text-brand" />
                ) : (
                  <Copy className="size-3" />
                )}
              </button>
            </div>
          );
        })}
      </div>
      <div className="flex items-center justify-between px-1 text-[10px] font-mono text-muted-foreground">
        <span>{matches.length} matched {matches.length === 1 ? "file" : "files"}</span>
        {pattern && <Badge variant="outline" className="text-[9px] h-3.5 font-mono border-0 bg-black/5 dark:bg-white/5">{pattern}</Badge>}
      </div>
    </div>
  );
}

export interface GrepMatchItem {
  file: string;
  line: number;
  text: string;
}

export function GrepResultView({
  matches,
  pattern,
}: {
  matches: GrepMatchItem[];
  pattern?: string;
}) {
  // Group by file
  const grouped = React.useMemo(() => {
    const map = new Map<string, GrepMatchItem[]>();
    for (const m of matches) {
      const list = map.get(m.file) || [];
      list.push(m);
      map.set(m.file, list);
    }
    return Array.from(map.entries());
  }, [matches]);

  if (!matches || matches.length === 0) {
    return (
      <div className="rounded bg-black/5 dark:bg-black/30 border border-black/5 dark:border-white/5 px-3 py-2 text-xs text-muted-foreground italic font-mono">
        No matches found {pattern ? `for "${pattern}"` : ""}
      </div>
    );
  }

  return (
    <div className="space-y-1.5 font-mono text-[11px]">
      <div className="space-y-2 max-h-80 overflow-y-auto pr-0.5">
        {grouped.map(([file, items]) => {
          const ext = file.includes(".") ? file.split(".").pop()?.toLowerCase() || "" : "";
          return (
            <div key={file} className="rounded bg-black/5 dark:bg-black/30 border border-black/5 dark:border-white/5 overflow-hidden">
              <div
                onClick={() => handleOpenFile(file, items[0]?.line)}
                className="flex items-center gap-1.5 px-2 py-1 bg-black/5 dark:bg-black/40 border-b border-black/5 dark:border-white/5 cursor-pointer hover:bg-black/10 dark:hover:bg-white/10 transition-colors select-none"
              >
                <FileTypeIcon ext={ext} className="size-3.5 shrink-0" />
                <span className="font-semibold text-foreground truncate min-w-0 flex-1">{file}</span>
                <span className="text-[10px] text-muted-foreground shrink-0">{items.length} {items.length === 1 ? "match" : "matches"}</span>
              </div>
              <div className="divide-y divide-black/5 dark:divide-white/5">
                {items.map((item, idx) => (
                  <div
                    key={`${file}-${item.line}-${idx}`}
                    onClick={() => handleOpenFile(file, item.line)}
                    className="flex items-start gap-2 px-2 py-1 hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer transition-colors"
                  >
                    <span className="text-[10px] text-muted-foreground shrink-0 select-none pt-0.5 min-w-[32px] text-right font-medium">
                      L{item.line}
                    </span>
                    <code className="text-zinc-700 dark:text-zinc-300 text-[11px] whitespace-pre-wrap break-words min-w-0 flex-1 font-mono">
                      {item.text}
                    </code>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex items-center justify-between px-1 text-[10px] font-mono text-muted-foreground">
        <span>{matches.length} total matches in {grouped.length} files</span>
        {pattern && <Badge variant="outline" className="text-[9px] h-3.5 font-mono border-0 bg-black/5 dark:bg-white/5">{pattern}</Badge>}
      </div>
    </div>
  );
}

export interface WebSearchResultItem {
  title: string;
  url: string;
  snippet?: string;
}

export function WebSearchResultView({
  results,
  query,
}: {
  results: WebSearchResultItem[];
  query?: string;
}) {
  if (!results || results.length === 0) {
    return (
      <div className="rounded bg-black/5 dark:bg-black/30 border border-black/5 dark:border-white/5 px-3 py-2 text-xs text-muted-foreground italic font-mono">
        No web results found
      </div>
    );
  }

  return (
    <div className="space-y-1.5 font-mono text-[11px]">
      <div className="space-y-1.5 max-h-80 overflow-y-auto pr-0.5">
        {results.map((r, i) => {
          let hostname = "";
          try {
            hostname = new URL(r.url).hostname;
          } catch {
            hostname = r.url;
          }
          return (
            <div key={i} className="rounded bg-black/5 dark:bg-black/30 border border-black/5 dark:border-white/5 p-2 space-y-1">
              <div className="flex items-center gap-1.5">
                <Globe className="size-3.5 text-sky-500 shrink-0" />
                <a
                  href={r.url}
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-foreground hover:underline truncate min-w-0 flex-1 flex items-center gap-1"
                >
                  <span className="truncate">{r.title || r.url}</span>
                  <ExternalLink className="size-2.5 opacity-60 shrink-0" />
                </a>
                <span className="text-[10px] text-muted-foreground shrink-0">{hostname}</span>
              </div>
              {r.snippet && (
                <p className="text-[11px] text-zinc-600 dark:text-zinc-400 font-sans leading-relaxed line-clamp-3">
                  {r.snippet}
                </p>
              )}
            </div>
          );
        })}
      </div>
      <div className="px-1 text-[10px] font-mono text-muted-foreground">
        {results.length} web search {results.length === 1 ? "result" : "results"}
      </div>
    </div>
  );
}

export function HttpFetchResultView({
  url,
  status,
  text,
}: {
  url: string;
  status?: number;
  text?: string;
}) {
  const isOk = !status || (status >= 200 && status < 300);
  let lang = "text";
  let formattedText = text || "";

  if (text) {
    const trimmed = text.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        formattedText = JSON.stringify(JSON.parse(trimmed), null, 2);
        lang = "json";
      } catch {}
    } else if (trimmed.startsWith("<")) {
      lang = "html";
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        {status !== undefined && (
          <Badge
            variant="outline"
            className={cn(
              "text-[10px] h-4 font-mono border-0",
              isOk
                ? "text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border-emerald-500/20"
                : "text-rose-500 dark:text-rose-400 bg-rose-500/10 border-rose-500/20"
            )}
          >
            {status}
          </Badge>
        )}
        <span className="font-mono text-[11px] text-foreground truncate flex-1">{url}</span>
      </div>
      {formattedText && (
        <div className="max-h-80 overflow-y-auto rounded border border-border/40">
          <CodeBlock language={lang} value={formattedText} />
        </div>
      )}
    </div>
  );
}

export function StructuredObjectView({
  data,
}: {
  data: Record<string, unknown>;
}) {
  const [showRaw, setShowRaw] = React.useState(false);
  const entries = Object.entries(data);

  if (entries.length === 0) {
    return (
      <div className="rounded bg-black/5 dark:bg-black/30 border border-black/5 dark:border-white/5 px-2.5 py-1.5 text-xs font-mono text-muted-foreground">
        Success (no output)
      </div>
    );
  }

  if (showRaw) {
    return (
      <div className="space-y-1">
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => setShowRaw(false)}
            className="text-[10px] font-mono text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
          >
            Show formatted view
          </button>
        </div>
        <pre className="font-mono text-[11px] whitespace-pre-wrap break-words rounded px-2 py-1.5 max-h-96 overflow-y-auto text-zinc-500 dark:text-zinc-400 bg-black/5 dark:bg-black/30">
          {formatResult(data)}
        </pre>
      </div>
    );
  }

  return (
    <div className="space-y-1.5 font-mono text-[11px]">
      <div className="rounded bg-black/5 dark:bg-black/30 border border-black/5 dark:border-white/5 divide-y divide-black/5 dark:divide-white/5">
        {entries.map(([key, val]) => {
          let renderedVal: React.ReactNode;
          if (typeof val === "boolean") {
            renderedVal = (
              <span className={val ? "text-emerald-500 dark:text-emerald-400 font-medium" : "text-rose-500 dark:text-rose-400 font-medium"}>
                {val ? "true" : "false"}
              </span>
            );
          } else if (typeof val === "number") {
            renderedVal = <span className="text-blue-500 dark:text-blue-400">{val}</span>;
          } else if (typeof val === "string") {
            renderedVal = <span className="text-foreground whitespace-pre-wrap break-words">{val}</span>;
          } else if (val === null || val === undefined) {
            renderedVal = <span className="text-muted-foreground italic">null</span>;
          } else {
            renderedVal = <span className="text-muted-foreground">{JSON.stringify(val)}</span>;
          }

          return (
            <div key={key} className="flex items-start gap-2 px-2.5 py-1 text-xs">
              <span className="text-muted-foreground shrink-0 min-w-[80px] select-none font-medium">{key}:</span>
              <div className="min-w-0 flex-1">{renderedVal}</div>
            </div>
          );
        })}
      </div>
      <div className="flex justify-end px-1">
        <button
          type="button"
          onClick={() => setShowRaw(true)}
          className="text-[10px] font-mono text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
        >
          View raw JSON
        </button>
      </div>
    </div>
  );
}

/* ----------------------------- ANSI helpers ----------------------------- */

/** Mozilla/Windows console box-drawing mojibake mapping (cp437 -> unicode). */
const BOX_DRAWING_MAP: Record<string, string> = {
  "\u00b3": "│", // ³ -> │
  "\u00c3": "├", // Ã -> ├
  "\u00c4": "─", // Ä -> ─
  "\u00c0": "└", // À -> └
  "\u00c2": "┬", // Â -> ┬
  "\u00c1": "┴", // Á -> ┴
  "\u00c5": "┼", // Å -> ┼
  "\u00b4": "┤", // ´ -> ┤
};

function parseAnsi(text: string): React.ReactNode {
  // Translate box drawing characters first
  const fixedText = text.replace(/[\u00b3\u00c3\u00c4\u00c0\u00c2\u00c1\u00c5\u00b4]/g, (c) => BOX_DRAWING_MAP[c] || c);
  // Strip non-color/style ANSI codes
  const cleanText = fixedText.replace(/\u001b\[[0-9;]*[A-ln-z]/g, "");

  const parts = cleanText.split(/\u001b\[([0-9;]*)m/);
  if (parts.length === 1) return cleanText;

  const elements: React.ReactNode[] = [];
  const currentClasses = new Set<string>();

  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      const content = parts[i];
      if (content) {
        if (currentClasses.size > 0) {
          elements.push(
            <span key={i} className={Array.from(currentClasses).join(" ")}>
              {content}
            </span>
          );
        } else {
          elements.push(content);
        }
      }
    } else {
      const code = parts[i];
      if (!code || code === "0") {
        currentClasses.clear();
      } else {
        const subcodes = code.split(";");
        for (const sc of subcodes) {
          if (sc === "1") {
            currentClasses.add("font-bold");
          } else if (sc === "2" || sc === "22") {
            currentClasses.delete("font-bold");
            currentClasses.add("font-normal");
          } else if (sc === "30") {
            currentClasses.add("text-zinc-800 dark:text-zinc-300 font-semibold");
          } else if (sc === "31") {
            currentClasses.add("text-red-500 dark:text-red-400 font-semibold");
          } else if (sc === "32") {
            currentClasses.add("text-emerald-500 dark:text-emerald-400 font-semibold");
          } else if (sc === "33") {
            currentClasses.add("text-yellow-500 dark:text-yellow-400 font-semibold");
          } else if (sc === "34") {
            currentClasses.add("text-blue-500 dark:text-blue-400 font-semibold");
          } else if (sc === "35") {
            currentClasses.add("text-fuchsia-500 dark:text-fuchsia-400 font-semibold");
          } else if (sc === "36") {
            currentClasses.add("text-cyan-500 dark:text-cyan-400 font-semibold");
          } else if (sc === "37") {
            currentClasses.add("text-zinc-500 dark:text-zinc-400 font-semibold");
          } else if (sc === "90") {
            currentClasses.add("text-zinc-400 dark:text-zinc-500 font-semibold");
          } else if (sc === "91") {
            currentClasses.add("text-red-400 dark:text-red-300 font-semibold");
          } else if (sc === "92") {
            currentClasses.add("text-emerald-400 dark:text-emerald-300 font-semibold");
          } else if (sc === "93") {
            currentClasses.add("text-yellow-400 dark:text-yellow-300 font-semibold");
          } else if (sc === "94") {
            currentClasses.add("text-blue-400 dark:text-blue-300 font-semibold");
          } else if (sc === "95") {
            currentClasses.add("text-fuchsia-400 dark:text-fuchsia-300 font-semibold");
          } else if (sc === "96") {
            currentClasses.add("text-cyan-400 dark:text-cyan-300 font-semibold");
          } else if (sc === "97") {
            currentClasses.add("text-zinc-700 dark:text-zinc-200 font-semibold");
          } else if (sc === "39" || sc === "49") {
            currentClasses.delete("text-zinc-800 dark:text-zinc-300 font-semibold");
            currentClasses.delete("text-red-500 dark:text-red-400 font-semibold");
            currentClasses.delete("text-emerald-500 dark:text-emerald-400 font-semibold");
            currentClasses.delete("text-yellow-500 dark:text-yellow-400 font-semibold");
            currentClasses.delete("text-blue-500 dark:text-blue-400 font-semibold");
            currentClasses.delete("text-fuchsia-500 dark:text-fuchsia-400 font-semibold");
            currentClasses.delete("text-cyan-500 dark:text-cyan-400 font-semibold");
            currentClasses.delete("text-zinc-500 dark:text-zinc-400 font-semibold");
            currentClasses.delete("text-zinc-400 dark:text-zinc-500 font-semibold");
            currentClasses.delete("text-red-400 dark:text-red-300 font-semibold");
            currentClasses.delete("text-emerald-400 dark:text-emerald-300 font-semibold");
            currentClasses.delete("text-yellow-400 dark:text-yellow-300 font-semibold");
            currentClasses.delete("text-blue-400 dark:text-blue-300 font-semibold");
            currentClasses.delete("text-fuchsia-400 dark:text-fuchsia-300 font-semibold");
            currentClasses.delete("text-cyan-400 dark:text-cyan-300 font-semibold");
            currentClasses.delete("text-zinc-700 dark:text-zinc-200 font-semibold");
          }
        }
      }
    }
  }

  return <>{elements}</>;
}

/** A labeled, copyable stdout/stderr block. */
function CopyableOutput({
  label,
  text,
  className,
}: {
  label: string;
  text: string;
  className?: string;
}) {
  const [copied, setCopied] = React.useState(false);
  const onCopy = React.useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      toast.success(`${label} copied`);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Copy failed");
    }
  }, [text, label]);

  const truncated = text.length > 4000 ? text.slice(0, 4000) + "\n…[truncated]" : text;

  return (
    <div className="relative">
      <div className="flex items-center justify-between mb-0.5">
        <span className="text-[9px] font-mono uppercase tracking-wider text-zinc-500">
          {label}
        </span>
        <button
          type="button"
          onClick={onCopy}
          title={`Copy ${label}`}
          aria-label={`Copy ${label}`}
          className="rounded p-0.5 text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
        >
          {copied ? (
            <Check className="size-3 text-brand" />
          ) : (
            <Copy className="size-3" />
          )}
        </button>
      </div>
      <pre
        className={cn(
          "font-mono text-[11px] whitespace-pre-wrap break-words bg-black/5 dark:bg-black/40 rounded px-2 py-1.5 max-h-96 overflow-y-auto",
          className,
        )}
      >
        {parseAnsi(truncated)}
      </pre>
    </div>
  );
}

/* ----------------------------- Result body ----------------------------- */

export function ToolResultBody({ tc }: { tc: LiveToolCall }) {
  // Live command output — show a progress terminal while the command runs.
  if (tc.name === "run_command" && tc.liveOutput && tc.liveOutput.length > 0) {
    return (
      <div className="space-y-1">
        {tc.status === "running" && (
          <div className="flex items-center gap-1.5 mb-1">
            <Loader2 className="size-3 animate-spin text-brand" />
            <span className="text-[11px] text-muted-foreground">Running…</span>
          </div>
        )}
        <pre className="font-mono text-[11px] whitespace-pre-wrap break-words bg-black/5 dark:bg-black/40 rounded px-2 py-1.5 max-h-64 overflow-y-auto text-foreground">
          {tc.liveOutput.length > 4000
            ? parseAnsi("…" + tc.liveOutput.slice(-4000))
            : parseAnsi(tc.liveOutput)}
        </pre>
      </div>
    );
  }

  if (tc.status === "running") {
    // For running file-op tools with partial args, show a live preview.
    const args = tc.parsedArgs ?? safeParse(tc.args);
    if (
      (tc.name === "write_file" || tc.name === "write_to_file" || tc.name === "create_artifact") &&
      args &&
      typeof args === "object"
    ) {
      const content =
        typeof args.content === "string"
          ? args.content
          : typeof args.CodeContent === "string"
          ? args.CodeContent
          : typeof args.codeContent === "string"
          ? args.codeContent
          : "";
      if (content.length > 0) {
        const path =
          typeof args.path === "string"
            ? args.path
            : typeof args.TargetFile === "string"
            ? args.TargetFile
            : typeof args.targetFile === "string"
            ? args.targetFile
            : "file";
        const lineCount = content.split("\n").length;
        const ext = path.includes(".") ? path.split(".").pop()?.toLowerCase() || "" : "";
        return (
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <span className="relative flex size-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75"></span>
                <span className="relative inline-flex rounded-full size-2 bg-primary"></span>
              </span>
              <span className="text-[11px] font-mono text-primary font-medium">
                Streaming {path} ({lineCount} lines)…
              </span>
            </div>
            <div className="max-h-64 overflow-y-auto rounded border border-border/60">
              <CodeBlock language={ext} value={content} />
            </div>
          </div>
        );
      }
    }
    if (tc.name === "edit_file" && args && typeof args.find === "string" && args.find.length > 0) {
      const path = typeof args.path === "string" ? args.path : "file";
      const replaceText = typeof args.replace === "string" ? args.replace : "";
      return (
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Loader2 className="size-3 animate-spin text-brand" />
            <span className="text-[11px] text-muted-foreground">
              Editing {path}…
            </span>
          </div>
          <div className="rounded border border-border/50 bg-muted/40 p-2 space-y-2 select-none">
            {args.find && (
              <div>
                <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">Find</span>
                <pre className="font-mono text-[11px] whitespace-pre-wrap break-words mt-0.5 bg-red-500/5 rounded px-2 py-1 max-h-24 overflow-y-auto">
                  {args.find.split("\n").map((line, i) => (
                    <div key={i} className="text-red-700 dark:text-red-400 bg-red-500/10 px-1 font-mono">
                      - {line}
                    </div>
                  ))}
                </pre>
              </div>
            )}
            <div>
              <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">Replace</span>
              <pre className="font-mono text-[11px] whitespace-pre-wrap break-words mt-0.5 bg-emerald-500/5 rounded px-2 py-1 max-h-24 overflow-y-auto">
                {replaceText.split("\n").map((line, i) => (
                  <div key={i} className="text-emerald-700 dark:text-emerald-400 bg-emerald-500/10 px-1 font-mono">
                    + {line}
                  </div>
                ))}
              </pre>
            </div>
          </div>
        </div>
      );
    }
    return (
      <div className="text-muted-foreground italic text-[11px] flex items-center gap-1.5">
        <Loader2 className="size-3 animate-spin text-brand" />
        Running…
      </div>
    );
  }
  if (tc.result === undefined) {
    return null;
  }

  // Try to render a diff for edit_file / write_file / multi_edit if the
  // result exposes old + new content (or the args themselves carry content).
  const diff = tryExtractDiff(tc);
  if (diff) {
    return <DiffViewer path={diff.path} oldContent={diff.old} newContent={diff.new} />;
  }

  const args = tc.parsedArgs ?? safeParse(tc.args);

  // run_command: split stdout/stderr if present.
  if (tc.name === "run_command" && typeof tc.result === "object" && tc.result !== null) {
    const r = tc.result as {
      stdout?: string;
      stderr?: string;
      exitCode?: number;
      ok?: boolean;
      status?: string;
    };
    const isRunning = r.status === "running";
    return (
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          {isRunning ? (
            <Badge variant="outline" className="text-[10px] h-4 font-mono border-0 text-brand bg-brand/10 animate-pulse">
              running…
            </Badge>
          ) : (
            <Badge
              variant="outline"
              className={cn(
                "text-[10px] h-4 font-mono border-0",
                r.exitCode === 0
                  ? "text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border-emerald-500/20"
                  : "text-red-500 dark:text-red-400 bg-red-500/10 border-red-500/20",
              )}
            >
              exit {r.exitCode ?? (tc.ok === false ? 1 : 0)}
            </Badge>
          )}
        </div>
        {r.stdout && r.stdout.trim().length > 0 && (
          <CopyableOutput
            label="stdout"
            text={r.stdout}
            className="text-foreground/90"
          />
        )}
        {r.stderr && r.stderr.trim().length > 0 && (
          <CopyableOutput
            label="stderr"
            text={r.stderr}
            className="text-amber-400/90"
          />
        )}
        {(!r.stdout || r.stdout.trim().length === 0) &&
          (!r.stderr || r.stderr.trim().length === 0) && (
            <pre className="font-mono text-[11px] whitespace-pre-wrap break-words text-zinc-500 dark:text-zinc-400 bg-black/5 dark:bg-black/30 rounded px-2 py-1.5 max-h-96 overflow-y-auto">
              {formatResult(tc.result)}
            </pre>
          )}
      </div>
    );
  }

  // Directory listing (list_directory / list_dir)
  if (tc.name === "list_directory" || tc.name === "list_dir") {
    const dirResult = parseDirectoryResult(tc.result, args);
    if (dirResult) {
      return (
        <DirectoryListingView
          entries={dirResult.entries}
          basePath={dirResult.basePath}
          totalFiles={dirResult.totalFiles}
          totalDirs={dirResult.totalDirs}
        />
      );
    }
  }

  // Glob / file pattern search
  if (tc.name === "glob") {
    const globResult = parseGlobResult(tc.result, args);
    if (globResult) {
      return (
        <GlobResultView
          matches={globResult.matches}
          pattern={globResult.pattern}
          basePath={globResult.basePath}
        />
      );
    }
  }

  // Grep / code search
  if (tc.name === "grep" || tc.name === "grep_search") {
    const grepResult = parseGrepResult(tc.result, args);
    if (grepResult) {
      return <GrepResultView matches={grepResult.matches} pattern={grepResult.pattern} />;
    }
  }

  // Web search
  if (tc.name === "web_search") {
    const webResult = parseWebSearchResult(tc.result, args);
    if (webResult) {
      return <WebSearchResultView results={webResult.results} query={webResult.query} />;
    }
  }

  // Http fetch
  if (tc.name === "http_fetch") {
    const fetchResult = parseHttpFetchResult(tc.result, args);
    if (fetchResult) {
      return <HttpFetchResultView url={fetchResult.url} status={fetchResult.status} text={fetchResult.text} />;
    }
  }

  // read_file / view_file: render content as code
  if (
    (tc.name === "read_file" || tc.name === "view_file") &&
    typeof tc.result === "object" &&
    tc.result !== null
  ) {
    const r = tc.result as { content?: string; text?: string; startLine?: number; endLine?: number; lines?: number; totalLines?: number };
    const content =
      (typeof r.content === "string" && r.content) ||
      (typeof r.text === "string" && r.text) ||
      "";
    if (content && content.length > 0) {
      const startLine = r.startLine ?? 1;
      const endLine = r.endLine ?? r.totalLines ?? r.lines ?? content.split("\n").length;
      return (
        <CodeBlock
          language={guessLangFromPath(
            typeof tc.parsedArgs?.path === "string" ? tc.parsedArgs.path : "",
          )}
          value={content}
          startLine={startLine}
          endLine={endLine}
        />
      );
    }
  }

  // write_file on a NEW file (no diff possible — there's no old content).
  if (
    (tc.name === "write_file" || tc.name === "write_to_file") &&
    typeof tc.result === "object" &&
    tc.result !== null
  ) {
    const r = tc.result as { created?: boolean; newContent?: string; path?: string };
    if (r.created && typeof r.newContent === "string" && r.newContent.length > 0) {
      return (
        <CodeBlock
          language={guessLangFromPath(
            typeof r.path === "string"
              ? r.path
              : typeof tc.parsedArgs?.path === "string"
                ? tc.parsedArgs.path
                : "",
          )}
          value={r.newContent}
        />
      );
    }
  }

  // Generic structured object fallback (if result is an object with properties)
  if (typeof tc.result === "object" && tc.result !== null && !Array.isArray(tc.result)) {
    // Only sniff known result shapes for tools that plausibly produce them —
    // arbitrary tools (mcp_call, todo_write, …) must not be misrendered.
    if (
      tc.name === "list_directory" ||
      tc.name === "list_dir" ||
      tc.name === "glob" ||
      tc.name === "grep" ||
      tc.name === "grep_search" ||
      tc.name === "web_search" ||
      tc.name === "http_fetch"
    ) {
      // Check if result has directory-like structure
      const asDir = parseDirectoryResult(tc.result, args);
      if (asDir && asDir.entries.length > 0) {
        return (
          <DirectoryListingView
            entries={asDir.entries}
            basePath={asDir.basePath}
            totalFiles={asDir.totalFiles}
            totalDirs={asDir.totalDirs}
          />
        );
      }
      // Check if result has grep-like structure
      const asGrep = parseGrepResult(tc.result, args);
      if (asGrep && asGrep.matches.length > 0) {
        return <GrepResultView matches={asGrep.matches} pattern={asGrep.pattern} />;
      }
      // Check if result has web search structure
      const asWeb = parseWebSearchResult(tc.result, args);
      if (asWeb && asWeb.results.length > 0) {
        return <WebSearchResultView results={asWeb.results} query={asWeb.query} />;
      }
    }

    if (tc.ok === false) {
      return (
        <pre className="font-mono text-[11px] whitespace-pre-wrap break-words rounded px-2 py-1.5 max-h-96 overflow-y-auto text-red-400 bg-red-500/5">
          {formatResult(tc.result)}
        </pre>
      );
    }

    return <StructuredObjectView data={tc.result as Record<string, unknown>} />;
  }

  // Generic JSON result — terminal-style fallback.
  const resultText = formatResult(tc.result);
  return (
    <div>
      <pre
        className={cn(
          "font-mono text-[11px] whitespace-pre-wrap break-words rounded px-2 py-1.5 max-h-96 overflow-y-auto",
          tc.ok === false
            ? "text-red-400 bg-red-500/5"
            : "text-zinc-500 dark:text-zinc-400 bg-black/5 dark:bg-black/30",
        )}
      >
        {typeof resultText === "string" && /\u001b\[/.test(resultText) ? parseAnsi(resultText) : resultText}
      </pre>
    </div>
  );
}

/* ----------------------------- Parsers ----------------------------- */

export function parseDirectoryResult(result: unknown, args?: Record<string, unknown>): {
  basePath?: string;
  entries: NormalizedDirEntry[];
  totalFiles?: number;
  totalDirs?: number;
} | null {
  if (!result) return null;
  let data = result;
  if (typeof data === "string") {
    const parsed = safeParse(data);
    if (parsed) data = parsed;
  }
  if (typeof data === "object" && data !== null) {
    const obj = data as Record<string, unknown>;
    const rawEntries =
      Array.isArray(obj.entries)
        ? obj.entries
        : Array.isArray(obj.files && typeof obj.files === "object" ? obj.files : null)
        ? (obj.files as unknown[])
        : Array.isArray(obj.items)
        ? obj.items
        : Array.isArray(data)
        ? (data as unknown[])
        : null;

    if (rawEntries) {
      const basePath =
        typeof obj.path === "string"
          ? obj.path
          : typeof args?.path === "string"
          ? args.path
          : typeof args?.DirectoryPath === "string"
          ? args.DirectoryPath
          : "";

      const entries: NormalizedDirEntry[] = [];
      let countDirs = 0;
      let countFiles = 0;

      for (const item of rawEntries) {
        if (!item) continue;
        if (typeof item === "string") {
          const isDir = item.endsWith("/") || item.endsWith("\\");
          const cleanName = item.replace(/[/\\]$/, "").split(/[/\\]/).pop() || item;
          if (isDir) countDirs++;
          else countFiles++;
          entries.push({
            name: cleanName,
            path: item,
            type: isDir ? "dir" : "file",
          });
          continue;
        }
        if (typeof item === "object") {
          const it = item as Record<string, unknown>;
          const rawName =
            typeof it.name === "string"
              ? it.name
              : typeof it.path === "string"
              ? it.path.split(/[/\\]/).pop() || ""
              : typeof it.relative_path === "string"
              ? it.relative_path.split(/[/\\]/).pop() || ""
              : typeof it.Filename === "string"
              ? it.Filename.split(/[/\\]/).pop() || ""
              : "";
          if (!rawName) continue;

          const isDir =
            it.type === "dir" ||
            it.type === "directory" ||
            it.is_dir === true ||
            it.isDirectory === true ||
            Boolean(it.children);

          const fullPath =
            typeof it.path === "string"
              ? it.path
              : typeof it.relative_path === "string"
              ? (basePath ? `${basePath.replace(/[/\\]$/, "")}/${it.relative_path}` : it.relative_path)
              : typeof it.Filename === "string"
              ? it.Filename
              : rawName;

          const size = typeof it.size === "number" ? it.size : undefined;

          if (isDir) countDirs++;
          else countFiles++;

          entries.push({
            name: rawName,
            path: fullPath,
            type: isDir ? "dir" : "file",
            size,
          });
        }
      }

      entries.sort((a, b) => {
        if (a.type !== b.type) {
          return a.type === "dir" ? -1 : 1;
        }
        return a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
      });

      return {
        basePath,
        entries,
        totalFiles: typeof obj.files === "number" ? obj.files : countFiles,
        totalDirs: typeof obj.dirs === "number" ? obj.dirs : countDirs,
      };
    }
  }
  return null;
}

export function parseGlobResult(result: unknown, args?: Record<string, unknown>): {
  matches: string[];
  pattern?: string;
  basePath?: string;
} | null {
  if (!result) return null;
  let data = result;
  if (typeof data === "string") {
    const parsed = safeParse(data);
    if (parsed) data = parsed;
  }
  const pattern =
    typeof args?.pattern === "string"
      ? args.pattern
      : typeof (data as any)?.pattern === "string"
      ? (data as any).pattern
      : undefined;
  const basePath =
    typeof args?.path === "string"
      ? args.path
      : typeof (data as any)?.path === "string"
      ? (data as any).path
      : undefined;

  if (Array.isArray(data)) {
    const matches = data.filter((x): x is string => typeof x === "string");
    return { matches, pattern, basePath };
  }
  if (typeof data === "object" && data !== null) {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj.matches)) {
      const matches = obj.matches.filter((x): x is string => typeof x === "string");
      return { matches, pattern, basePath };
    }
  }
  return null;
}

export function parseGrepResult(result: unknown, args?: Record<string, unknown>): {
  matches: GrepMatchItem[];
  pattern?: string;
} | null {
  if (!result) return null;
  let data = result;
  if (typeof data === "string") {
    const parsed = safeParse(data);
    if (parsed) data = parsed;
  }
  const pattern =
    typeof args?.pattern === "string"
      ? args.pattern
      : typeof args?.query === "string"
      ? args.query
      : typeof args?.Query === "string"
      ? args.Query
      : typeof (data as any)?.pattern === "string"
      ? (data as any).pattern
      : typeof (data as any)?.query === "string"
      ? (data as any).query
      : typeof (data as any)?.Query === "string"
      ? (data as any).Query
      : undefined;

  const rawMatches =
    Array.isArray(data)
      ? data
      : typeof data === "object" && data !== null && Array.isArray((data as Record<string, unknown>).matches)
      ? ((data as Record<string, unknown>).matches as unknown[])
      : null;

  if (rawMatches) {
    const matches: GrepMatchItem[] = [];
    for (const m of rawMatches) {
      if (!m || typeof m !== "object") continue;
      const it = m as Record<string, unknown>;
      const file = String(it.file || it.filename || it.Filename || it.path || "");
      const line = Number(it.line || it.lineNumber || it.LineNumber || 1);
      const text = String(it.preview || it.text || it.lineContent || it.LineContent || it.content || "");
      if (file) {
        matches.push({ file, line: isNaN(line) ? 1 : line, text });
      }
    }
    return { matches, pattern };
  }
  return null;
}

export function parseWebSearchResult(result: unknown, args?: Record<string, unknown>): {
  results: WebSearchResultItem[];
  query?: string;
} | null {
  if (!result) return null;
  let data = result;
  if (typeof data === "string") {
    const parsed = safeParse(data);
    if (parsed) data = parsed;
  }
  const query =
    typeof args?.query === "string"
      ? args.query
      : typeof (data as any)?.query === "string"
      ? (data as any).query
      : undefined;

  const rawResults =
    Array.isArray(data)
      ? data
      : typeof data === "object" && data !== null && Array.isArray((data as Record<string, unknown>).results)
      ? ((data as Record<string, unknown>).results as unknown[])
      : null;

  if (rawResults) {
    const results: WebSearchResultItem[] = [];
    for (const r of rawResults) {
      if (!r || typeof r !== "object") continue;
      const it = r as Record<string, unknown>;
      const title = String(it.title || it.name || it.url || "");
      const url = String(it.url || it.link || "");
      const snippet = String(it.snippet || it.description || it.text || "");
      if (url || title) {
        results.push({ title, url, snippet });
      }
    }
    return { results, query };
  }
  return null;
}

export function parseHttpFetchResult(result: unknown, args?: Record<string, unknown>): {
  url: string;
  status?: number;
  text?: string;
} | null {
  if (!result) return null;
  let data = result;
  if (typeof data === "string") {
    const parsed = safeParse(data);
    if (parsed) data = parsed;
  }
  if (typeof data === "object" && data !== null) {
    const obj = data as Record<string, unknown>;
    const url = typeof obj.url === "string" ? obj.url : typeof args?.url === "string" ? args.url : typeof args?.Url === "string" ? args.Url : "";
    if (url) {
      const status = typeof obj.status === "number" ? obj.status : typeof obj.statusCode === "number" ? obj.statusCode : undefined;
      const text = typeof obj.text === "string" ? obj.text : typeof obj.content === "string" ? obj.content : typeof obj.body === "string" ? obj.body : undefined;
      return { url, status, text };
    }
  }
  return null;
}

/* ------------------------------ helpers ------------------------------ */

function ToolStatusIcon({ status }: { status: LiveToolCall["status"] }) {
  if (status === "running") {
    return <Loader2 className="size-3 animate-spin text-brand shrink-0" />;
  }
  if (status === "done") {
    return <CheckCircle2 className="size-3 text-brand shrink-0" />;
  }
  return <XCircle className="size-3 text-rose-500 shrink-0" />;
}

function ToolIcon({ name, className }: { name: string; className?: string }) {
  const Cmp = pickToolIcon(name);
  return React.createElement(Cmp, { className });
}

function pickToolIcon(name: string): React.ElementType {
  if (name === "remove_file" || name === "delete") {
    return Trash2;
  }
  if (name === "list_directory" || name === "list_dir") {
    return Folder;
  }
  if (name === "read_file" || name === "write_file" || name === "edit_file" || name === "multi_edit") {
    return FileText;
  }
  if (name === "run_command" || name === "run_terminal") return TerminalIcon;
  if (name === "web_search" || name === "http_fetch" || name.startsWith("browser_")) {
    return Globe;
  }
  if (name === "grep" || name === "grep_search" || name === "glob") {
    return Search;
  }
  if (name === "mcp_call") return Plug;
  return Wrench;
}

function formatToolDisplayName(name: string): string {
  if (name === "list_directory" || name === "list_dir") return "Analyzed";
  if (name === "read_file" || name === "view_file") return "Read";
  if (name === "write_file" || name === "write_to_file") return "Created";
  if (name === "edit_file" || name === "replace_file_content") return "Edited";
  if (name === "multi_edit" || name === "multi_replace_file_content") return "Multi-edited";
  if (name === "remove_file" || name === "delete") return "Deleted";
  if (name === "run_command" || name === "run_terminal") return "Executed";
  if (name === "grep" || name === "grep_search" || name === "glob") return "Searched";
  if (name === "web_search") return "Searched web";
  if (name === "http_fetch") return "Fetched";
  return name;
}

function makeArgsSummary(
  name: string,
  args: Record<string, unknown> | undefined,
  wsName: string = "workspace",
): string {
  if (!args) return "";
  if (name === "list_directory" || name === "list_dir") {
    const rawPath = typeof args.path === "string" ? args.path : typeof args.DirectoryPath === "string" ? args.DirectoryPath : "";
    if (!rawPath || rawPath === "." || rawPath === "./") return wsName;
    return rawPath;
  }
  if (FILE_OP_TOOLS.has(name)) {
    const path = extractFilePath(args) || "";
    if ((name === "multi_edit" || name === "multi_replace_file_content") && Array.isArray(args.edits || args.ReplacementChunks)) {
      const edits = (args.edits || args.ReplacementChunks) as unknown[];
      return `${edits.length} edit${edits.length === 1 ? "" : "s"}`;
    }
    return path;
  }
  if (name === "run_command" || name === "run_terminal") {
    const cmd = extractCommand(args) || (typeof args?.CommandLine === "string" ? args.CommandLine : "");
    if (!cmd) return "";
    return cmd.length > 70 ? `${cmd.slice(0, 67)}…` : cmd;
  }
  if (name === "grep" || name === "grep_search" || name === "glob") {
    const q = typeof args.pattern === "string" ? args.pattern : typeof args.query === "string" ? args.query : typeof args.Query === "string" ? args.Query : "";
    if (q) return q.length > 60 ? `${q.slice(0, 57)}…` : q;
  }
  if (name === "web_search") {
    const q = typeof args.query === "string" ? args.query : "";
    if (q) return q.length > 60 ? `${q.slice(0, 57)}…` : q;
  }
  if (name === "http_fetch") {
    const u = typeof args.url === "string" ? args.url : typeof args.Url === "string" ? args.Url : "";
    if (u) return u.length > 60 ? `${u.slice(0, 57)}…` : u;
  }
  const firstVal = pickFirstArg(args);
  if (!firstVal) return "";
  const truncated = firstVal.length > 60 ? `${firstVal.slice(0, 57)}…` : firstVal;
  return truncated;
}

function pickFirstArg(args: Record<string, unknown>): string {
  const order = [
    "pattern",
    "path",
    "DirectoryPath",
    "command",
    "CommandLine",
    "query",
    "Query",
    "Includes",
    "SearchPath",
    "TargetFile",
    "AbsolutePath",
    "url",
    "Url",
    "expression",
    "tool",
    "ref",
    "text",
  ];
  for (const k of order) {
    const v = args[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  for (const [k, v] of Object.entries(args)) {
    if (k.startsWith("_") || k === "toolAction" || k === "toolSummary") continue;
    if (typeof v === "string" && v.length > 0) return v;
  }
  return "";
}

/** Extract the file/dir path from a tool's args. */
export function extractFilePath(args: Record<string, unknown>): string | null {
  const p =
    args.path ??
    args.DirectoryPath ??
    args.dirPath ??
    args.targetPath ??
    args.TargetFile ??
    args.targetFile ??
    args.AbsolutePath ??
    args.file;
  if (typeof p === "string" && p.length > 0) return p;
  return null;
}

/** Extract the shell command from a run_command tool's args. */
function extractCommand(args: Record<string, unknown>): string | null {
  const c = args.command ?? args.CommandLine ?? args.cmd ?? args.Command;
  if (typeof c === "string" && c.trim().length > 0) return c.trim();
  if (c && typeof c === "object" && !Array.isArray(c)) {
    const inner = (c as Record<string, unknown>).command ?? (c as Record<string, unknown>).CommandLine ?? (c as Record<string, unknown>).cmd ?? (c as Record<string, unknown>).Command;
    if (typeof inner === "string" && inner.trim().length > 0) return inner.trim();
  }
  return null;
}

/** Guess a language tag for CodeBlock from a file path. */
function guessLangFromPath(path: string): string {
  if (!path) return "text";
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    json: "json",
    css: "css",
    scss: "scss",
    html: "html",
    md: "markdown",
    py: "python",
    sh: "bash",
    bash: "bash",
    sql: "sql",
    yml: "yaml",
    yaml: "yaml",
    xml: "xml",
    txt: "text",
    go: "go",
    rs: "rust",
    java: "java",
    c: "c",
    cpp: "cpp",
    rb: "ruby",
    php: "php",
    toml: "toml",
  };
  return map[ext] ?? "text";
}

function maybeDuration(args: Record<string, unknown> | undefined): string | null {
  if (!args) return null;
  const d = (args as { _durationMs?: unknown })._durationMs;
  if (typeof d === "number" && d > 0) {
    return d < 1000 ? `${d}ms` : `${(d / 1000).toFixed(1)}s`;
  }
  return null;
}

function tryExtractDiff(
  tc: LiveToolCall,
): { path: string; old: string; new: string } | null {
  if (tc.name !== "edit_file" && tc.name !== "write_file" && tc.name !== "multi_edit") return null;
  const args = tc.parsedArgs ?? safeParse(tc.args);
  if (!args) return null;
  const path = typeof args.path === "string" ? args.path : "file";

  if (tc.name === "multi_edit") {
    const result = tc.result as {
      oldContent?: string;
      newContent?: string;
    } | undefined;
    if (
      result &&
      typeof result.oldContent === "string" &&
      typeof result.newContent === "string"
    ) {
      return { path, old: result.oldContent, new: result.newContent };
    }
    return null;
  }

  if (tc.name === "write_file" && typeof args.content === "string") {
    const result = tc.result as { oldContent?: string; before?: string; previous?: string; created?: boolean } | undefined;
    if (result && result.created) return null;
    const oldContent =
      (result && typeof result.oldContent === "string" && result.oldContent) ||
      (result && typeof result.before === "string" && result.before) ||
      (result && typeof result.previous === "string" && result.previous) ||
      "";
    if (!oldContent) return null;
    return { path, old: oldContent, new: args.content };
  }
  if (tc.name === "edit_file") {
    const find = typeof args.find === "string" ? args.find : "";
    const replace = typeof args.replace === "string" ? args.replace : "";
    if (!find) return null;
    const result = tc.result as {
      oldContent?: string;
      newContent?: string;
      before?: string;
      after?: string;
    } | undefined;
    const oldContent =
      (result && typeof result.oldContent === "string" && result.oldContent) ||
      (result && typeof result.before === "string" && result.before) ||
      find;
    const newContent =
      (result && typeof result.newContent === "string" && result.newContent) ||
      (result && typeof result.after === "string" && result.after) ||
      replace;
    return { path, old: oldContent, new: newContent };
  }
  return null;
}

function formatArgsCompact(toolName: string, args: Record<string, unknown>): string {
  const skip = new Set<string>([
    "path",
    "command",
    "DirectoryPath",
    "SearchPath",
    "CommandLine",
    "TargetFile",
    "targetFile",
    "AbsolutePath",
    "file",
    "toolAction",
    "toolSummary",
    "WaitMsBeforeAsync",
    "IsDaemon",
    "_durationMs",
  ]);
  if (toolName === "write_file" || toolName === "write_to_file") {
    skip.add("content");
    skip.add("CodeContent");
  }
  if (toolName === "edit_file" || toolName === "replace_file_content") {
    skip.add("find");
    skip.add("replace");
    skip.add("TargetContent");
    skip.add("ReplacementContent");
  }
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (skip.has(k) || k.startsWith("_")) continue;
    if (typeof v === "string") {
      const val = v.length > 80 ? v.slice(0, 80) + "…" : v;
      parts.push(`${k}="${val}"`);
    } else if (typeof v === "number" || typeof v === "boolean") {
      parts.push(`${k}=${v}`);
    } else if (Array.isArray(v)) {
      parts.push(`${k}=[${v.length} items]`);
    } else if (v && typeof v === "object") {
      parts.push(`${k}={…}`);
    }
  }
  if (parts.length === 0) return "";
  return parts.join(" ");
}

function formatResult(r: unknown): string {
  if (typeof r === "string") return r;
  try {
    return JSON.stringify(r, null, 2);
  } catch {
    return String(r);
  }
}

export function safeParse(raw: string): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    return parsePartialJson(raw);
  } catch {
    return undefined;
  }
}
