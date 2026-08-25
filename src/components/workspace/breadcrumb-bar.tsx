"use client";

import * as React from "react";
import {
  Folder,
  FileText,
  ChevronRight,
  Copy,
  Check,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/* -------------------------------------------------------------------------- *
 * BreadcrumbBar
 *
 * VS Code-style breadcrumb path bar shown above the file editor content.
 * Renders the file path split by `/` as clickable segments separated by
 * `ChevronRight` icons. Each segment is a button — clicking a directory
 * segment dispatches `hermos:open-folder` (which the workspace panel
 * listens for to switch to the Files tab and expand that directory); the
 * final filename segment is rendered in emerald + bold and does nothing
 * on click (it's the current file).
 *
 * A trailing "Copy path" button copies the full relative path to the
 * clipboard and shows a brief "Path copied" toast.
 *
 * When `path` is empty/null, the bar renders nothing — the editor's own
 * empty state takes care of the no-file case.
 * -------------------------------------------------------------------------- */

export interface BreadcrumbBarProps {
  /** Workspace-relative path, e.g. "src/components/math.ts". */
  path: string;
  /**
   * Called when the user clicks a directory segment. Receives the
   * directory's relative path (e.g. "src/components"). The bar
   * dispatches `hermos:open-folder` itself; this callback lets the
   * parent do anything extra (e.g. focus the file tree).
   */
  onSegmentClick?: (dirPath: string) => void;
  className?: string;
}

export function BreadcrumbBar({ path, onSegmentClick, className }: BreadcrumbBarProps) {
  const [copied, setCopied] = React.useState(false);
  const copyTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    return () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    };
  }, []);

  // Reset the copied flag when the path changes (so the next copy shows
  // the brief emerald checkmark again).
  React.useEffect(() => {
    setCopied(false);
  }, [path]);

  if (!path) return null;

  const segments = path.split("/").filter(Boolean);
  if (segments.length === 0) return null;

  // Pre-compute the cumulative path for each segment so clicking a
  // directory segment can pass the full directory path (not just the
  // segment name) to onSegmentClick. We use reduce to avoid reassigning
  // a closure variable (which trips the react-hooks/immutability lint).
  const segmentPaths = segments.reduce<string[]>((acc, seg, idx) => {
    const prev = idx > 0 ? acc[idx - 1] : "";
    acc.push(prev ? `${prev}/${seg}` : seg);
    return acc;
  }, []);

  const handleSegmentClick = (idx: number) => {
    // The last segment is the filename — no-op (it's the current file).
    if (idx === segments.length - 1) return;
    const dirPath = segmentPaths[idx];
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent<string>("hermos:open-folder", { detail: dirPath }),
      );
    }
    onSegmentClick?.(dirPath);
  };

  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(path);
      setCopied(true);
      toast.success("Path copied");
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 1400);
    } catch {
      toast.error("Could not copy path");
    }
  };

  return (
    <div
      className={cn(
        "flex h-7 shrink-0 items-stretch border-b bg-muted/20",
        className,
      )}
      role="navigation"
      aria-label="File path"
    >
      <div
        className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto px-2 hermos-breadcrumb-scroll"
        // Hide the scrollbar but keep scrolling. The CSS class adds the
        // webkit + firefox scrollbar-width: none rules.
        aria-label={`Path: ${path}`}
      >
        <Folder className="size-3 shrink-0 text-muted-foreground/70" aria-hidden />
        {segments.map((seg, idx) => {
          const isLast = idx === segments.length - 1;
          const isDir = !isLast;
          return (
            <React.Fragment key={`${seg}-${idx}`}>
              {idx > 0 && (
                <ChevronRight
                  className="size-3 shrink-0 text-muted-foreground/50"
                  aria-hidden
                />
              )}
              <button
                type="button"
                onClick={() => handleSegmentClick(idx)}
                disabled={isLast}
                title={isLast ? path : `Reveal ${segmentPaths[idx]} in file tree`}
                aria-current={isLast ? "page" : undefined}
                aria-label={isLast ? `File: ${seg}` : `Reveal ${seg} directory`}
                className={cn(
                  "flex shrink-0 items-center rounded px-1 py-0.5 text-xs font-mono transition-colors",
                  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand/40",
                  isLast
                    ? "cursor-default font-semibold text-brand"
                    : "text-foreground/70 hover:bg-accent hover:text-foreground",
                )}
              >
                {isLast && (
                  <FileText className="mr-1 size-3 shrink-0 text-brand/80" aria-hidden />
                )}
                {seg}
              </button>
            </React.Fragment>
          );
        })}
      </div>
      <div className="flex shrink-0 items-center pr-1 pl-0.5 border-l bg-background/40">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="size-6 p-0"
              onClick={() => void copyPath()}
              aria-label="Copy path"
            >
              {copied ? (
                <Check className="size-3 text-brand" />
              ) : (
                <Copy className="size-3 text-muted-foreground" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Copy path</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
