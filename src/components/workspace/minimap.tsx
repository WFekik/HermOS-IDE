"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/* -------------------------------------------------------------------------- *
 * Minimap
 *
 * A VS Code-style minimap for the file editor — a tiny zoomed-out view of
 * the file content rendered as 1–2px-tall rows on the right side of the
 * editor body. Each line becomes a row whose width is proportional to the
 * line's length (capped so very long lines don't fill the whole minimap).
 *
 * Clicking the minimap scrolls the editor to that line (calls onScrollTo).
 * A translucent emerald-tinted "viewport" rectangle shows the currently
 * visible portion of the file. The active line (cursor / go-to-line target)
 * is highlighted with a thin emerald bar.
 *
 * The minimap is purely visual — it does not render the actual characters
 * (text is too small to read at ~3px). Instead each line is a thin colored
 * bar; the relative density gives the user a structural overview.
 *
 * Props:
 *  - content:    the file content (lines joined by \n).
 *  - onScrollTo: called with a 1-based line number when the user clicks.
 *  - activeLine: 1-based line number of the current cursor / highlight
 *                (or null when none).
 *  - viewport:   { startLine, endLine } describing the currently-visible
 *                range (1-based, inclusive). Used to draw the viewport
 *                rectangle. Optional — when omitted, no rect is drawn.
 *  - className:  optional extra classes for the root element.
 *
 * The component is designed to fill its parent (absolute right edge of the
 * editor body). The parent must be `position: relative`.
 * -------------------------------------------------------------------------- */

export interface MinimapViewport {
  startLine: number;
  endLine: number;
}

export interface MinimapProps {
  content: string;
  onScrollTo: (line: number) => void;
  activeLine?: number | null;
  viewport?: MinimapViewport | null;
  className?: string;
}

/** Cap the rendered width of a single line (in % of minimap width). */
const MAX_LINE_WIDTH_PCT = 100;
/** Min width % so empty lines are still visible as a faint dot. */
const MIN_LINE_WIDTH_PCT = 6;
/** Approximate characters-per-line at the minimap's scale. */
const CHARS_PER_FULL_WIDTH = 80;

export function Minimap({
  content,
  onScrollTo,
  activeLine,
  viewport,
  className,
}: MinimapProps) {
  const lines = React.useMemo(() => content.split("\n"), [content]);
  const lineCount = lines.length;

  // Refs for click-to-scroll math.
  const rootRef = React.useRef<HTMLDivElement | null>(null);

  // Pre-compute per-line width percentages so the render is cheap.
  const linePcts = React.useMemo(() => {
    return lines.map((line) => {
      // Strip leading whitespace so the visible bar reflects content
      // density, not indentation (otherwise deeply-nested code looks
      // sparser than it is).
      const trimmed = line.replace(/^\s+/, "");
      const len = trimmed.length;
      if (len === 0) return MIN_LINE_WIDTH_PCT;
      const pct = Math.min(MAX_LINE_WIDTH_PCT, (len / CHARS_PER_FULL_WIDTH) * 100);
      return Math.max(MIN_LINE_WIDTH_PCT, pct);
    });
  }, [lines]);

  const handleClick = React.useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const root = rootRef.current;
      if (!root || lineCount === 0) return;
      const rect = root.getBoundingClientRect();
      // The click's Y position relative to the minimap content area.
      // We ignore the 4px top padding (matches the editor's line-number
      // padding) so the first line is at the very top.
      const y = e.clientY - rect.top - 2;
      const usableH = rect.height - 4;
      if (usableH <= 0) return;
      const ratio = Math.max(0, Math.min(1, y / usableH));
      // Map the ratio to a 1-based line number. We center the click a
      // little so the user lands on the line they clicked, not the one
      // below.
      const line = Math.max(1, Math.min(lineCount, Math.round(ratio * (lineCount - 1)) + 1));
      onScrollTo(line);
    },
    [lineCount, onScrollTo],
  );

  // Viewport rectangle position (in % of minimap height).
  const viewportStyle = React.useMemo<React.CSSProperties | null>(() => {
    if (!viewport || lineCount === 0) return null;
    const { startLine, endLine } = viewport;
    const topPct = ((Math.max(1, startLine) - 1) / lineCount) * 100;
    const heightPct = ((Math.max(1, endLine) - Math.max(1, startLine) + 1) / lineCount) * 100;
    return {
      top: `${topPct}%`,
      height: `max(${heightPct}%, 6px)`,
    };
  }, [viewport, lineCount]);

  return (
    <div
      ref={rootRef}
      role="slider"
      aria-label="Minimap — click to scroll the editor"
      aria-valuemin={1}
      aria-valuemax={Math.max(1, lineCount)}
      aria-valuenow={activeLine ?? undefined}
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={(e) => {
        // Allow keyboard activation: Up/Down moves the active line,
        // Enter / Space scrolls to it.
        if (!activeLine) return;
        if (e.key === "ArrowDown") {
          e.preventDefault();
          onScrollTo(Math.min(lineCount, activeLine + 1));
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          onScrollTo(Math.max(1, activeLine - 1));
        } else if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onScrollTo(activeLine);
        }
      }}
      className={cn(
        "absolute right-0 top-0 z-10 h-full w-[60px] cursor-pointer select-none border-l border-border/60 bg-muted/20",
        "px-1 py-0.5",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand/40",
        className,
      )}
      aria-hidden={false}
    >
      {/* Line bars — render as flexbox column so they fill the height.
          Each line is a thin bar whose width is the precomputed %. We
          cap the visible line count at 600 for performance on very large
          files (the minimap is structural, not a precise map). */}
      <div className="flex h-full flex-col justify-start gap-px overflow-hidden">
        {linePcts.slice(0, 600).map((pct, i) => {
          const lineNo = i + 1;
          const isActive = activeLine != null && lineNo === activeLine;
          return (
            <div
              key={i}
              className={cn(
                "h-px shrink-0 rounded-full",
                isActive
                  ? "bg-brand/80"
                  : "bg-muted-foreground/45",
              )}
              style={{ width: `${pct}%`, minWidth: "2px" }}
            />
          );
        })}
      </div>

      {/* Viewport indicator — translucent emerald rectangle showing the
          currently visible portion of the file. Pointer-events disabled so
          clicks pass through to the underlying click handler. */}
      {viewportStyle && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 rounded-sm border border-brand/30 bg-brand/10"
          style={viewportStyle}
        />
      )}
    </div>
  );
}
