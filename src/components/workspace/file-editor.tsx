"use client";

import * as React from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark, oneLight } from "react-syntax-highlighter/dist/esm/styles/prism";
import { useTheme } from "@/components/theme/theme-provider";
import { toast } from "sonner";
import {
  FileText,
  Pencil,
  Save,
  Copy,
  Check,
  X,
  Loader2,
  AlertTriangle,
  RotateCw,
  Wand2,
  Hash,
  Eye,
  EyeOff,
  Columns2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  formatBytes,
  langFromPath,
  isFormattablePath,
  formatFile,
  type WorkspaceFile,
} from "@/components/workspace/types";
import { DiffViewer } from "@/components/ide/diff-viewer";
import { ApiRequestError } from "@/lib/api-client";
import { subscribeWatch } from "@/lib/watch-client";
import { Minimap, type MinimapViewport } from "@/components/workspace/minimap";
import { BreadcrumbBar } from "@/components/workspace/breadcrumb-bar";
import { InlineAiLens } from "@/components/ide/inline-ai-lens";
import { useAppStore } from "@/stores/app-store";

/** A line-range request. `null` = default read (full file). */
export interface FileRange {
  start: number;
  end: number;
}

/**
 * Which side of the split editor this FileEditor renders on.
 * - `"left"` (or `undefined`) — the primary editor. Renders the "Split
 *   editor" toggle button in its header.
 * - `"right"` — the secondary editor in a split. Renders a "Close split"
 *   X button instead of the split toggle.
 */
export type EditorSide = "left" | "right";

export interface FileEditorProps {
  path: string | null;
  file: WorkspaceFile | undefined;
  loading: boolean;
  error: Error | null;
  /** Current range being viewed (null = default read). */
  range: FileRange | null;
  onSave: (path: string, content: string) => Promise<void>;
  onRetry?: () => void;
  /** Load the full file by requesting the full line range. */
  onLoadFull: () => void;
  /** Load a specific line range. Capped at MAX_RANGE per request. */
  onLoadRange: (start: number, end: number) => void;
  /** Reset to the default full-file read (drops any active range). */
  onLoadDefault: () => void;
  /**
   * Called when the file-watch SSE reports that the open file changed on
   * disk. The container typically invalidates the file-content query so
   * the editor re-fetches the latest content. Only called when the editor
   * is NOT in edit mode (so the user's unsaved edits are never clobbered).
   */
  onExternalChange?: () => void;
  /**
   * Which side of the split editor this instance renders on. Defaults to
   * "left" (the primary, single-pane editor). When "right", the header
   * shows a "Close split" X button instead of the "Split editor" toggle.
   */
  side?: EditorSide;
  /**
   * Whether this editor is the active one (the one that should handle
   * global keyboard shortcuts like ⌘L go-to-line). In split mode, only
   * the focused side has this set to true. Defaults to true when not in
   * split mode (so the primary editor always handles shortcuts).
   */
  isActive?: boolean;
  /**
   * Called when the editor body receives focus (click / keyboard). The
   * parent uses this to track which side is active in split mode.
   */
  onFocusSide?: () => void;
  /**
   * Called when the user clicks the "Close split" X button on the right
   * editor. The parent closes the split (clears splitEditorOpen).
   */
  onCloseSplit?: () => void;
}

export function FileEditor({
  path,
  file,
  loading,
  error,
  range,
  onSave,
  onRetry,
  onLoadFull,
  onLoadRange,
  onLoadDefault,
  onExternalChange,
  side = "left",
  isActive = true,
  onFocusSide,
  onCloseSplit,
}: FileEditorProps) {
  const [mode, setMode] = React.useState<"view" | "edit">("view");
  const [draft, setDraft] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [copied, setCopied] = React.useState(false);

  const [formatBusy, setFormatBusy] = React.useState(false);
  const [formatResult, setFormatResult] = React.useState<{
    path: string;
    oldContent: string;
    newContent: string;
  } | null>(null);
  const [formatApplyBusy, setFormatApplyBusy] = React.useState(false);

  const [gotoOpen, setGotoOpen] = React.useState(false);
  const [gotoValue, setGotoValue] = React.useState("");
  const [gotoError, setGotoError] = React.useState<string | null>(null);

  const [lensOpen, setLensOpen] = React.useState(false);
  const [lensCode, setLensCode] = React.useState("");

  // Highlighted line (brief emerald flash after go-to-line)
  const [highlightedLine, setHighlightedLine] = React.useState<number | null>(null);
  const highlightTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // Minimap viewport — the currently-visible line range in the editor's
  // scroll area. Tracked via a scroll listener on the ScrollArea viewport.
  const [minimapViewport, setMinimapViewport] = React.useState<MinimapViewport | null>(null);

  // This instance's editor body container. All DOM lookups for scroll /
  // go-to-line are scoped through this ref — querying the document
  // globally would grab whichever editor (e.g. the other split pane)
  // happened to mount first.
  const editorBodyRef = React.useRef<HTMLDivElement | null>(null);

  // File-watch preference + connection state (store-backed so the status
  // bar can show a "watching" indicator).
  const fileWatchEnabled = useAppStore((s) => s.fileWatchEnabled);
  const toggleFileWatchEnabled = useAppStore((s) => s.toggleFileWatchEnabled);
  const setFileWatchConnected = useAppStore((s) => s.setFileWatchConnected);
  const closeFileTab = useAppStore((s) => s.closeFileTab);
  // Split editor — only the LEFT side renders the toggle button. The
  // RIGHT side renders a "Close split" X instead.
  const splitEditorOpen = useAppStore((s) => s.splitEditorOpen);
  const toggleSplitEditor = useAppStore((s) => s.toggleSplitEditor);

  React.useEffect(() => {
    setMode("view");
    setDraft("");
    setFormatResult(null);
    setGotoOpen(false);
    setGotoValue("");
    setGotoError(null);
    setHighlightedLine(null);
  }, [path]);

  // Clear the highlight timer on unmount.
  React.useEffect(() => {
    return () => {
      if (highlightTimer.current) clearTimeout(highlightTimer.current);
    };
  }, []);

  const dirty = mode === "edit" && file != null && draft !== file.content;

  const enterEdit = () => {
    if (!file) return;
    setDraft(file.content);
    setMode("edit");
  };

  const cancelEdit = () => {
    setMode("view");
    setDraft("");
  };

  const save = async () => {
    if (!path || !file) return;
    setSaving(true);
    try {
      await onSave(path, draft);
      setMode("view");
      setDraft("");
    } finally {
      setSaving(false);
    }
  };

  React.useEffect(() => {
    if (mode !== "edit") return;
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (!saving && dirty) void save();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [mode, saving, dirty, draft, path, file]);

  React.useEffect(() => {
    if (!isActive || !file) return;
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "i") {
        e.preventDefault();
        const sel = window.getSelection()?.toString() || file.content.slice(0, 1000);
        setLensCode(sel);
        setLensOpen(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isActive, file]);

  const copy = async () => {
    if (!file) return;
    try {
      await navigator.clipboard.writeText(file.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {}
  };

  const canFormat = !!path && isFormattablePath(path) && mode === "view" && !!file;

  const runFormat = async () => {
    if (!path) return;
    setFormatBusy(true);
    try {
      const res = await formatFile(path);
      if (res.unchanged) {
        toast.success("File is already formatted");
        return;
      }
      if (!res.ok) {
        toast.error(res.error ?? "Format failed", {
          description: res.detail,
        });
        return;
      }
      if (res.newContent === undefined || res.oldContent === undefined) {
        toast.error("Format failed: no content returned");
        return;
      }
      setFormatResult({
        path,
        oldContent: res.oldContent,
        newContent: res.newContent,
      });
    } catch (e) {
      const msg = e instanceof ApiRequestError ? e.message : "Format failed";
      toast.error(msg);
    } finally {
      setFormatBusy(false);
    }
  };

  const applyFormat = async () => {
    if (!formatResult || !path) return;
    setFormatApplyBusy(true);
    try {
      await onSave(path, formatResult.newContent);
      setFormatResult(null);
      toast.success("File formatted");
    } catch (e) {
      const msg = e instanceof ApiRequestError ? e.message : "Apply failed";
      toast.error(msg);
    } finally {
      setFormatApplyBusy(false);
    }
  };

  const totalLines = file?.totalLines ?? file?.content?.split("\n").length ?? 0;
  // Prefer the backend-reported startLine/endLine (which reflect actual
  // clamping) over the requested range; fall back to the content length
  // for default reads.
  const visibleStart = file?.startLine ?? range?.start ?? 1;
  const visibleEnd =
    file?.endLine ?? range?.end ?? file?.content?.split("\n").length ?? 0;
  const isRangeView = range !== null || file?.startLine !== undefined;

  // Whether to render the minimap. Hidden for:
  //  - files <30 lines (not useful at that scale)
  //  - edit mode (the Textarea owns the body)
  //  - loading / error states (no content to render)
  const contentLineCount = file?.content?.split("\n").length ?? 0;
  const showMinimap =
    mode === "view" &&
    !!file &&
    !loading &&
    !error &&
    contentLineCount >= 30;

  const openGoto = React.useCallback(() => {
    setGotoValue("");
    setGotoError(null);
    setGotoOpen(true);
  }, []);

  // Listen for the global `hermos:go-to-line` event (dispatched by the ⌘L
  // keyboard shortcut and the command palette). In split mode, the event
  // carries `detail.side` ("left" | "right") so only the focused editor
  // opens its dialog. Without a `side` (e.g. from the command palette
  // when no split is open), only the LEFT editor handles it.
  React.useEffect(() => {
    const handler = (e: Event) => {
      if (!isActive) return;
      const detail = (e as CustomEvent<{ side?: "left" | "right" }>).detail;
      if (detail && detail.side && detail.side !== side) return;
      if (path) openGoto();
    };
    window.addEventListener("hermos:go-to-line", handler);
    return () => window.removeEventListener("hermos:go-to-line", handler);
  }, [path, openGoto, isActive, side]);

  // Subscribe to the shared multiplexed file-watch SSE client on
  // /api/workspace/watch while a file is open and the user has watch
  // enabled. Every editor instance + the workspace panel share ONE
  // EventSource per URL (see @/lib/watch-client) instead of each owning
  // its own, which used to exhaust the browser's per-host connection cap
  // with several tabs open. On a "change" event for the active path, ask
  // the container to refetch (only when NOT in edit mode, so the user's
  // unsaved edits are never clobbered). On a "delete" event, close the
  // tab + toast. The endpoint may 404 if the backend hasn't shipped the
  // watch route yet — the client then reports "disconnected" (the editor
  // header shows an EyeOff state without spamming toasts).
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    if (!path || !fileWatchEnabled || mode !== "view") {
      setFileWatchConnected(false);
      return;
    }
    // Some browsers don't support EventSource (very old Safari). Guard.
    if (typeof EventSource === "undefined") {
      setFileWatchConnected(false);
      return;
    }
    let disposed = false;

    const unsubscribe = subscribeWatch(
      "/api/workspace/watch",
      (ev) => {
        if (disposed) return;
        // The endpoint emits `data: {json}` frames. Parse defensively —
        // any malformed frame is ignored (never crash the editor).
        let payload: { path?: string; event?: string } | null = null;
        try {
          payload = JSON.parse(ev.data) as { path?: string; event?: string };
        } catch {
          return;
        }
        if (!payload || typeof payload !== "object") return;
        const evtPath = typeof payload.path === "string" ? payload.path : null;
        const evtType = typeof payload.event === "string" ? payload.event : null;
        // Ignore events for other files — the watch is workspace-wide and
        // the backend may broadcast changes to files we don't have open.
        if (!evtPath || evtPath !== path) return;
        if (evtType === "delete") {
          closeFileTab(path);
          toast.warning("File was deleted", { description: path });
          return;
        }
        if (evtType === "change") {
          // Only refetch when not in edit mode (don't clobber user edits).
          // We re-read `mode` from a ref because the closure captures the
          // value at subscription time.
          if (modeRef.current !== "edit") {
            onExternalChange?.();
          }
        }
      },
      (connected) => {
        if (disposed) return;
        setFileWatchConnected(connected);
      },
    );

    return () => {
      disposed = true;
      unsubscribe();
      setFileWatchConnected(false);
    };
  }, [path, fileWatchEnabled, mode, closeFileTab, onExternalChange, setFileWatchConnected]);

  // Keep a ref of the current edit mode so the SSE onmessage handler
  // (which closes over `mode` at subscription time) can read the latest
  // value without re-subscribing on every mode change.
  const modeRef = React.useRef(mode);
  React.useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  // Attach a scroll listener to the editor's ScrollArea viewport so the
  // minimap can show a translucent rectangle over the currently-visible
  // line range. Best-effort — if the ScrollArea structure changes the
  // listener just never fires and the minimap renders without a viewport
  // indicator (still useful for click-to-scroll).
  React.useEffect(() => {
    if (mode !== "view") {
      setMinimapViewport(null);
      return;
    }
    const body = editorBodyRef.current;
    if (!body) return;
    // Radix ScrollArea exposes its scrollable element via the
    // `[data-radix-scroll-area-viewport]` attribute.
    const scroller = body.querySelector(
      "[data-radix-scroll-area-viewport]",
    ) as HTMLElement | null;
    if (!scroller) return;

    // The SyntaxHighlighter uses 12px font * 1.55 line-height ≈ 18.6px
    // per line, with 0.75rem (12px) top padding before the first line.
    const LINE_HEIGHT_PX = 18.6;
    const PADDING_TOP_PX = 12;

    const update = () => {
      const top = scroller.scrollTop;
      const h = scroller.clientHeight;
      if (h <= 0) return;
      const start = Math.max(1, Math.floor((top - PADDING_TOP_PX) / LINE_HEIGHT_PX) + 1);
      const end = Math.max(
        start,
        Math.floor((top + h - PADDING_TOP_PX) / LINE_HEIGHT_PX) + 1,
      );
      setMinimapViewport((prev) => {
        if (prev && prev.startLine === start && prev.endLine === end) return prev;
        return { startLine: start, endLine: end };
      });
    };
    update();
    scroller.addEventListener("scroll", update, { passive: true });
    // Also update on window resize (the editor body height changes).
    window.addEventListener("resize", update);
    return () => {
      scroller.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [mode, path, file, loading]);

  /**
   * Scroll the editor to a specific line number (1-based, absolute) and
   * briefly highlight it with an emerald tint. If the line is outside the
   * currently-visible range, the caller is expected to load that range
   * first; this function only handles the scroll + flash.
   */
  const scrollToLine = React.useCallback((lineNo: number) => {
    const container = editorBodyRef.current;
    if (!container) return;
    const el = container.querySelector(`[data-line="${CSS.escape(String(lineNo))}"]`) as HTMLElement | null;
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    setHighlightedLine(lineNo);
    if (highlightTimer.current) clearTimeout(highlightTimer.current);
    highlightTimer.current = setTimeout(() => setHighlightedLine(null), 1400);
  }, []);

  // Listen for `hermos:scroll-to-line` events (dispatched by the symbol
  // outline panel and the minimap click handler). Unlike `hermos:go-to-line`
  // (which opens the dialog), this immediately scrolls to the line. If the
  // target line is outside the loaded range, the range around it is loaded
  // first (mirrors the go-to-line dialog's logic).
  //
  // In split mode, the event carries `detail.side` so only the targeted
  // editor scrolls. Without a `side`, only the LEFT editor handles it.
  React.useEffect(() => {
    const handler = (e: Event) => {
      if (!isActive) return;
      const detail = (e as CustomEvent<{ line: number; side?: "left" | "right" }>).detail;
      if (!detail || typeof detail.line !== "number") return;
      if (detail.side && detail.side !== side) return;
      const n = detail.line;
      const needRangeLoad =
        !!path && (n < visibleStart || n > visibleEnd);
      if (needRangeLoad) {
        const newStart = Math.max(1, n - 20);
        const newEnd = totalLines > 0 ? Math.min(totalLines, n + 20) : n + 20;
        onLoadRange(newStart, newEnd);
        setTimeout(() => scrollToLine(n), 280);
        return;
      }
      scrollToLine(n);
    };
    window.addEventListener("hermos:scroll-to-line", handler as EventListener);
    return () =>
      window.removeEventListener("hermos:scroll-to-line", handler as EventListener);
  }, [path, visibleStart, visibleEnd, totalLines, onLoadRange, scrollToLine, isActive, side]);

  /**
   * Validate the go-to-line input and either scroll to the line (if it's in
   * the current view) or load the range around it first.
   */
  const submitGoto = async () => {
    if (!path) return;
    const trimmed = gotoValue.trim();
    const n = parseInt(trimmed, 10);
    if (!Number.isFinite(n) || n < 1) {
      setGotoError("Enter a positive line number");
      return;
    }
    if (totalLines > 0 && n > totalLines) {
      setGotoError(`Line number out of range (max ${totalLines})`);
      return;
    }
    setGotoOpen(false);

    // If the target line is outside the visible range, load the range
    // around it first (±20 lines, clamped).
    const needRangeLoad = n < visibleStart || n > visibleEnd;
    if (needRangeLoad) {
      const newStart = Math.max(1, n - 20);
      const newEnd = totalLines > 0 ? Math.min(totalLines, n + 20) : n + 20;
      onLoadRange(newStart, newEnd);
      // Defer the scroll until the new range renders. The exact timing is
      // not critical — the highlight is brief and the scrollIntoView call
      // will work once the line div is in the DOM.
      setTimeout(() => scrollToLine(n), 280);
      return;
    }
    scrollToLine(n);
  };

  // Empty state: no file selected. When the parent is the right side of
  // a split editor and no file has been picked yet, the parent renders
  // its own empty "pick a file" state instead of mounting a FileEditor
  // — so this branch is only hit for the primary (left) editor with no
  // open file.
  if (!path) {
    return (
      <div
        className="flex h-full items-center justify-center p-6"
        onMouseDown={onFocusSide}
        onFocus={onFocusSide}
      >
        <div className="text-center">
          <FileText className="mx-auto size-8 text-muted-foreground/40" />
          <p className="mt-2 text-xs text-muted-foreground">
            Select a file to view or edit
          </p>
        </div>
      </div>
    );
  }

  // Whether the "Split editor" toggle should render in the header. Only
  // the LEFT (primary) editor shows it, and only when there's a file
  // open and the editor is in view mode (the toggle is meaningless while
  // editing — the user should commit/discard their edits first).
  const showSplitToggle = side === "left" && !!file && mode === "view";
  const showCloseSplit = side === "right";

  return (
    <div
      className={cn(
        "flex h-full flex-col",
        // In split mode, paint a subtle focus ring around the active
        // editor so the user can see which side keyboard shortcuts will
        // target. The LEFT side gets the ring when splitEditorActive is
        // "left" (or when not in split mode at all); the RIGHT side gets
        // it when splitEditorActive is "right".
        side === "left" && !isActive && splitEditorOpen && "opacity-95",
        side === "right" && !isActive && "opacity-95",
      )}
      onMouseDown={onFocusSide}
      onFocus={onFocusSide}
    >
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span
            className="truncate font-mono text-xs text-foreground/80"
            title={path}
          >
            {path}
          </span>
          {dirty && (
            <span
              className="size-1.5 shrink-0 rounded-full bg-brand"
              aria-label="Unsaved changes"
            />
          )}
          {file && (
            <span className="shrink-0 text-[10px] text-muted-foreground font-mono">
              {formatBytes(file.size)}
            </span>
          )}
          {totalLines > 0 && (
            <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
              L{visibleStart}-L{visibleEnd}
            </span>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {mode === "view" ? (
            <>
              <HeaderIconButton
                label="Inline AI Lens (⌘I)"
                onClick={() => {
                  setLensCode(file?.content?.slice(0, 1000) || "");
                  setLensOpen((v) => !v);
                }}
                disabled={!file || loading}
              >
                <Wand2 className={cn("size-3", lensOpen ? "text-brand" : "")} />
              </HeaderIconButton>
              <HeaderIconButton
                label="Go to line (⌘L)"
                onClick={openGoto}
                disabled={!file || loading}
              >
                <Hash className="size-3" />
              </HeaderIconButton>
              <HeaderIconButton
                label="Format file"
                onClick={() => void runFormat()}
                disabled={!canFormat || formatBusy}
              >
                {formatBusy ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <Wand2 className="size-3" />
                )}
              </HeaderIconButton>
              <HeaderIconButton
                label={
                  fileWatchEnabled
                    ? "File watch on — auto-refresh open files when they change on disk"
                    : "File watch off — click to enable auto-refresh"
                }
                onClick={toggleFileWatchEnabled}
                disabled={!file}
              >
                {fileWatchEnabled ? (
                  <Eye className="size-3 text-brand" />
                ) : (
                  <EyeOff className="size-3 text-muted-foreground" />
                )}
              </HeaderIconButton>
              {showSplitToggle && (
                <HeaderIconButton
                  label={
                    splitEditorOpen
                      ? "Close split editor (⌘\\)"
                      : "Split editor (⌘\\)"
                  }
                  onClick={toggleSplitEditor}
                >
                  <Columns2
                    className={cn(
                      "size-3",
                      splitEditorOpen ? "text-brand" : "text-muted-foreground",
                    )}
                  />
                </HeaderIconButton>
              )}
              {showCloseSplit && (
                <HeaderIconButton
                  label="Close split (⌘\\)"
                  onClick={() => onCloseSplit?.()}
                >
                  <X className="size-3" />
                </HeaderIconButton>
              )}
              <Button
                size="sm"
                variant="ghost"
                className="h-6 gap-1 px-2 text-[11px]"
                onClick={copy}
                disabled={!file}
                aria-label="Copy file contents"
              >
                {copied ? (
                  <>
                    <Check className="size-3 text-brand" /> Copied
                  </>
                ) : (
                  <>
                    <Copy className="size-3" /> Copy
                  </>
                )}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 gap-1 px-2 text-[11px]"
                onClick={enterEdit}
                disabled={!file || loading}
              >
                <Pencil className="size-3" /> Edit
              </Button>
            </>
          ) : (
            <>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 gap-1 px-2 text-[11px]"
                onClick={cancelEdit}
                disabled={saving}
              >
                <X className="size-3" /> Cancel
              </Button>
              <Button
                size="sm"
                variant="default"
                className="h-6 gap-1 px-2 text-[11px] bg-brand text-brand-foreground hover:bg-brand/90"
                onClick={() => void save()}
                disabled={saving || !dirty}
              >
                {saving ? (
                  <>
                    <Loader2 className="size-3 animate-spin" /> Saving
                  </>
                ) : (
                  <>
                    <Save className="size-3" /> Save
                  </>
                )}
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Breadcrumb path bar — clickable segments + copy-path button.
          Hidden while loading or in error state (no path to show). */}
      {path && !loading && !error && (
        <BreadcrumbBar path={path} />
      )}

      {path && lensOpen && (
        <div className="px-3">
          <InlineAiLens
            path={path}
            selectedCode={lensCode || file?.content || ""}
            onAccept={(newCode) => {
              if (file) {
                setDraft(newCode);
                setMode("edit");
              }
            }}
            onClose={() => setLensOpen(false)}
          />
        </div>
      )}

      <div ref={editorBodyRef} className="relative min-h-0 flex-1" data-editor-body="true">
        {loading ? (
          <div className="space-y-2 p-4">
            <div className="h-3 w-1/3 rounded bg-muted/60 animate-pulse" />
            <div className="h-3 w-2/3 rounded bg-muted/60 animate-pulse" />
            <div className="h-3 w-1/2 rounded bg-muted/60 animate-pulse" />
            <div className="h-3 w-3/4 rounded bg-muted/60 animate-pulse" />
            <div className="h-3 w-2/5 rounded bg-muted/60 animate-pulse" />
          </div>
        ) : error ? (
          <div className="flex h-full items-center justify-center p-6">
            <div className="text-center">
              <AlertTriangle className="mx-auto size-7 text-amber-500" />
              <p className="mt-2 text-xs text-muted-foreground">
                Could not load file.
              </p>
              <p className="mt-1 text-[11px] text-muted-foreground/70 font-mono break-all">
                {error.message}
              </p>
              {onRetry && (
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-3 h-7 gap-1 text-xs"
                  onClick={onRetry}
                >
                  <RotateCw className="size-3" /> Retry
                </Button>
              )}
            </div>
          </div>
        ) : mode === "edit" ? (
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="h-full w-full resize-none rounded-none border-0 bg-transparent font-mono text-xs leading-relaxed focus-visible:ring-0 focus-visible:ring-offset-0"
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            aria-label="Edit file contents"
          />
        ) : file ? (
          <div className="relative h-full">
            <CodeView
              path={path}
              content={file.content}
              lineOffset={(file.startLine ?? 1) - 1}
              highlightedLine={highlightedLine}
              // Pad the right side so the code doesn't slide under the
              // minimap. The minimap is 60px wide.
              padRight={showMinimap}
            />
            {showMinimap && (
              <Minimap
                content={file.content}
                onScrollTo={(line) => {
                  const needRangeLoad = line < visibleStart || line > visibleEnd;
                  if (needRangeLoad) {
                    const newStart = Math.max(1, line - 20);
                    const newEnd = totalLines > 0 ? Math.min(totalLines, line + 20) : line + 20;
                    onLoadRange(newStart, newEnd);
                    setTimeout(() => scrollToLine(line), 280);
                    return;
                  }
                  scrollToLine(line);
                }}
                activeLine={highlightedLine}
                viewport={minimapViewport}
              />
            )}
          </div>
        ) : null}
      </div>

      <Dialog
        open={formatResult !== null}
        onOpenChange={(o) => {
          if (!o && !formatApplyBusy) setFormatResult(null);
        }}
      >
        <DialogContent className="sm:max-w-3xl p-0 gap-0 overflow-hidden">
          <DialogHeader className="px-4 py-3 border-b">
            <DialogTitle className="text-sm font-semibold flex items-center gap-2">
              <Wand2 className="size-4 text-brand" />
              Format preview
            </DialogTitle>
            <DialogDescription className="text-xs">
              Review the proposed formatting changes. Apply writes the new
              content to disk.
            </DialogDescription>
          </DialogHeader>
          <div className="p-3 max-h-[60vh] overflow-y-auto">
            {formatResult && (
              <DiffViewer
                path={formatResult.path}
                oldContent={formatResult.oldContent}
                newContent={formatResult.newContent}
                hideApply
                className="border-0 rounded-none"
              />
            )}
          </div>
          <DialogFooter className="px-4 py-3 border-t bg-muted/30">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setFormatResult(null)}
              disabled={formatApplyBusy}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => void applyFormat()}
              disabled={formatApplyBusy}
              className="gap-1 bg-brand text-brand-foreground hover:bg-brand/90"
            >
              {formatApplyBusy ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" /> Applying
                </>
              ) : (
                <>
                  <Check className="size-3.5" /> Apply
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={gotoOpen} onOpenChange={(o) => !o && setGotoOpen(false)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm font-semibold flex items-center gap-2">
              <Hash className="size-4 text-brand" />
              Go to line
            </DialogTitle>
            <DialogDescription className="text-xs">
              Enter a line number between 1 and {totalLines > 0 ? totalLines : "…"}.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="goto-line-input">Line number</Label>
            <Input
              id="goto-line-input"
              type="number"
              min={1}
              max={totalLines > 0 ? totalLines : undefined}
              placeholder="Line number"
              value={gotoValue}
              onChange={(e) => {
                setGotoValue(e.target.value);
                setGotoError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void submitGoto();
                }
              }}
              autoFocus
              spellCheck={false}
              autoComplete="off"
            />
            {gotoError && (
              <p className="text-[11px] text-destructive">{gotoError}</p>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setGotoOpen(false)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => void submitGoto()}
              disabled={!gotoValue.trim()}
              className="gap-1 bg-brand text-brand-foreground hover:bg-brand/90"
            >
              Go
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function HeaderIconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          className="size-6 p-0"
          onClick={onClick}
          disabled={disabled}
          aria-label={label}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

function CodeView({
  path,
  content,
  lineOffset,
  highlightedLine,
  padRight,
}: {
  path: string;
  content: string;
  lineOffset: number;
  highlightedLine: number | null;
  /** When true, reserve 60px on the right for the minimap overlay. */
  padRight?: boolean;
}) {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const lang = langFromPath(path);

  const lineCount = React.useMemo(() => (content ? content.split("\n").length : 0), [content]);
  // High-performance plain mode is reserved for massive files (>350 KB or >3500 lines)
  const isLargeFile = content.length > 350_000 || lineCount > 3500;

  return (
    <div className="h-full overflow-y-auto overflow-x-hidden">
      <div
        className="min-w-full bg-card"
        style={padRight ? { paddingRight: "60px" } : undefined}
      >
        <div className="flex">
          <LineNumbers
            lineCount={lineCount}
            lineOffset={lineOffset}
            highlightedLine={highlightedLine}
          />
          <div className="min-w-0 flex-1 overflow-x-auto">
            {isLargeFile ? (
              <pre
                className="m-0 p-3 font-mono text-xs leading-[1.55] whitespace-pre text-foreground/90 select-text"
                style={{
                  fontFamily:
                    "var(--font-mono)",
                }}
              >
                {content}
              </pre>
            ) : (
              <SyntaxHighlighter
                language={lang}
                style={isDark ? oneDark : oneLight}
                showLineNumbers={false}
                customStyle={{
                  margin: 0,
                  padding: "0.75rem 1rem 1.5rem 0.75rem",
                  background: "transparent",
                  fontSize: "12px",
                  lineHeight: "1.55",
                  fontFamily:
                    "var(--font-mono)",
                }}
                codeTagProps={{
                  style: {
                    fontFamily:
                      "var(--font-mono)",
                  },
                }}
                wrapLongLines={false}
              >
                {content}
              </SyntaxHighlighter>
            )}
          </div>
        </div>
      </div>
      <div className="flex items-center justify-between border-t bg-muted/30 px-3 py-1">
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-[10px] font-mono uppercase">
            {lang}
          </Badge>
          {isLargeFile && (
            <Badge variant="secondary" className="text-[9px] font-mono text-amber-600 dark:text-amber-400">
              ⚡ High-Performance Mode (Large File)
            </Badge>
          )}
        </div>
        <span className="text-[10px] text-muted-foreground font-mono">
          {lineOffset > 0
            ? `lines ${lineOffset + 1}–${lineOffset + lineCount}`
            : `${lineCount} lines`}
        </span>
      </div>
    </div>
  );
}

const LineNumbers = React.memo(function LineNumbers({
  lineCount,
  lineOffset,
  highlightedLine,
}: {
  lineCount: number;
  lineOffset: number;
  highlightedLine: number | null;
}) {
  const lineElements = React.useMemo(() => {
    const items = [];
    for (let i = 0; i < lineCount; i++) {
      const lineNo = i + 1 + lineOffset;
      const isHighlighted = highlightedLine === lineNo;
      items.push(
        <div
          key={i}
          data-line={String(lineNo)}
          className={cn(
            "px-1 -mx-1 transition-colors",
            isHighlighted && "bg-brand/20 text-brand rounded-sm",
          )}
        >
          {lineNo}
        </div>,
      );
    }
    return items;
  }, [lineCount, lineOffset, highlightedLine]);

  return (
    <div
      aria-hidden
      className="select-none border-r border-border/40 bg-muted/20 px-2 pt-3 pb-6 text-right font-mono text-[12px] leading-[1.55] text-muted-foreground/60"
      style={{ minWidth: "2.5rem" }}
    >
      {lineElements}
    </div>
  );
});
