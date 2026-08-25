"use client";

import * as React from "react";
import { MousePointerClick, Keyboard } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { parseSnapshot, type SnapshotLine } from "@/components/browser/types";

/* ------------------------------------------------------------------ *
 * SnapshotView — renders the accessibility-tree snapshot returned by
 * the backend. Each line prefixed with `@eN` is an interactive ref;
 * clicking a ref row selects it and reveals small Click / Type actions.
 * ------------------------------------------------------------------ */

export function SnapshotView({
  snapshot,
  selectedRef,
  onSelectRef,
  onQuickClick,
  onQuickType,
  busyRef,
}: {
  snapshot: string;
  selectedRef: string | null;
  onSelectRef: (ref: string | null) => void;
  onQuickClick: (ref: string) => void;
  onQuickType: (ref: string) => void;
  busyRef: string | null;
}) {
  const lines = React.useMemo(
    () => parseSnapshot(snapshot),
    [snapshot],
  );

  if (lines.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center text-xs text-muted-foreground">
        Empty snapshot.
      </div>
    );
  }

  return (
    <div className="h-full w-full p-2 font-mono text-xs leading-relaxed">
      {lines.map((line, i) => (
        <SnapshotRow
          key={i}
          line={line}
          selected={!!line.ref && line.ref === selectedRef}
          busy={!!line.ref && line.ref === busyRef}
          onSelect={() => onSelectRef(line.ref ?? null)}
          onQuickClick={() => line.ref && onQuickClick(line.ref)}
          onQuickType={() => line.ref && onQuickType(line.ref)}
        />
      ))}
    </div>
  );
}

function SnapshotRow({
  line,
  selected,
  busy,
  onSelect,
  onQuickClick,
  onQuickType,
}: {
  line: SnapshotLine;
  selected: boolean;
  busy: boolean;
  onSelect: () => void;
  onQuickClick: () => void;
  onQuickType: () => void;
}) {
  const isRef = !!line.ref;
  return (
    <div
      className={cn(
        "group flex items-start gap-1.5 rounded-sm px-1 py-0.5",
        isRef && "cursor-pointer hover:bg-accent/60",
        selected && "bg-accent",
      )}
      onClick={isRef ? onSelect : undefined}
      role={isRef ? "button" : undefined}
      tabIndex={isRef ? 0 : undefined}
      onKeyDown={
        isRef
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect();
              }
            }
          : undefined
      }
      style={{ paddingLeft: `${0.25 + line.indent * 0.75}rem` }}
    >
      {isRef ? (
        <Badge
          variant="outline"
          className="shrink-0 bg-brand/10 font-mono text-[10px] text-brand border-brand/30 px-1 py-0"
        >
          {line.ref}
        </Badge>
      ) : (
        <span className="w-[2.25rem] shrink-0" aria-hidden />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
          {line.role && (
            <span className="rounded-sm bg-muted px-1 py-px text-[10px] text-muted-foreground">
              {line.role}
            </span>
          )}
          <span
            className={cn(
              "break-words text-foreground/90",
              !line.role && !line.label && "text-muted-foreground italic",
            )}
          >
            {line.label
              ? `"${line.label}"`
              : line.body || line.raw || ""}
          </span>
          {busy && (
            <span className="ml-1 inline-flex items-center text-[10px] text-brand">
              working…
            </span>
          )}
        </div>
        {selected && isRef && (
          <div className="mt-1 flex items-center gap-1">
            <Button
              size="sm"
              variant="outline"
              className="h-6 gap-1 px-2 text-[11px]"
              onClick={(e) => {
                e.stopPropagation();
                onQuickClick();
              }}
              disabled={busy}
              aria-label={`Click ${line.ref}`}
            >
              <MousePointerClick className="size-3" /> Click
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-6 gap-1 px-2 text-[11px]"
              onClick={(e) => {
                e.stopPropagation();
                onQuickType();
              }}
              disabled={busy}
              aria-label={`Type into ${line.ref}`}
            >
              <Keyboard className="size-3" /> Type…
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
