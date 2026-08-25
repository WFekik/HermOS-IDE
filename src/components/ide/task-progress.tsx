"use client";

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Loader2,
  FileText,
  Bot,
  Save,
  ChevronDown,
  ChevronUp,
  X,
  Check,
  Clock,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAppStore } from "@/stores/app-store";
import type { Subagent } from "@/stores/app-store";

/* ------------------------------------------------------------------ *
 * task-progress.tsx — floating indicator for long-running tasks.
 *
 * Renders a small card pinned to the bottom-right corner of the IDE
 * shell, just above the status bar, when one or more long-running
 * background tasks are active:
 *
 *   - Office generation (POST /api/office/generate in flight)
 *   - Subagents running (any subagent in pending / running state)
 *   - Checkpoint creation (POST /api/checkpoints in flight)
 *
 * The card auto-hides when all tasks finish (the `visible` flag is
 * derived from `anyActive`). The X button temporarily dismisses the
 * card for the current "wave" of activity; the next fresh wave (after
 * everything goes quiet and a new task starts) clears the dismissal so
 * the card reappears. Clicking the card toggles an expanded panel with
 * details (which subagents are running, which file is being generated,
 * etc.).
 *
 * The component is mounted once in the IDE shell and reads its state
 * from the app store — it renders null when there are no active tasks.
 * ------------------------------------------------------------------ */

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

interface TaskBucket {
  /** Stable id used as the React key in the collapsed list. */
  id: string;
  /** Icon to render next to the label. */
  icon: React.ElementType;
  /** Short label, e.g. "Generating presentation…". */
  label: string;
  /** Optional secondary detail shown in the expanded panel. */
  detail?: string;
  /** Whether this task is still in flight. */
  running: boolean;
}

export function TaskProgress() {
  const officeRunning = useAppStore((s) => s.officeGenerating);
  const officeLastPath = useAppStore((s) => s.officeLastPath);
  const officeLastType = useAppStore((s) => s.officeLastType);
  const subagents = useAppStore((s) => s.subagents);
  const checkpointCreating = useAppStore((s) => s.checkpointCreating);
  const setRightPanelTab = useAppStore((s) => s.setRightPanelTab);

  const [expanded, setExpanded] = React.useState(false);
  // Tracks whether the user has dismissed the card for the current
  // "wave" of activity. Reset to false whenever activity transitions
  // from inactive → active (a new task starts after everything
  // finished). The X button sets this to true so the card stays hidden
  // for the remainder of the current wave.
  const [userDismissed, setUserDismissed] = React.useState(false);
  const prevActiveRef = React.useRef(false);

  const runningSubagents = subagents.filter(
    (s) => !TERMINAL_STATUSES.has(s.status),
  );
  const anySubagentRunning = runningSubagents.length > 0;
  const anyActive = officeRunning || anySubagentRunning || checkpointCreating;

  // Reset the user-dismissal flag whenever a fresh wave of activity
  // starts (inactive → active). When activity ends, do nothing — the
  // visible flag below naturally hides the card because `anyActive`
  // is false.
  React.useEffect(() => {
    if (anyActive && !prevActiveRef.current) {
      setUserDismissed(false);
    }
    prevActiveRef.current = anyActive;
  }, [anyActive]);

  const visible = anyActive && !userDismissed;

  // Build the task buckets. Each becomes a row in the expanded panel
  // and contributes to the collapsed summary count.
  const buckets: TaskBucket[] = React.useMemo(() => {
    const out: TaskBucket[] = [];
    if (officeRunning) {
      const label =
        officeLastType === "presentation"
          ? "Generating presentation…"
          : officeLastType === "pdf"
            ? "Generating PDF…"
            : officeLastType === "document"
              ? "Generating document…"
              : "Generating document…";
      out.push({
        id: "office",
        icon: FileText,
        label,
        detail: officeLastPath ?? undefined,
        running: true,
      });
    }
    if (checkpointCreating) {
      out.push({
        id: "checkpoint",
        icon: Save,
        label: "Creating checkpoint…",
        detail: "Snapshotting the workspace",
        running: true,
      });
    }
    if (anySubagentRunning) {
      out.push({
        id: "subagents",
        icon: Bot,
        label: `${runningSubagents.length} subagent${
          runningSubagents.length === 1 ? "" : "s"
        } running…`,
        detail: runningSubagents.map((s) => s.name).join(", "),
        running: true,
      });
    }
    return out;
  }, [
    officeRunning,
    officeLastType,
    officeLastPath,
    checkpointCreating,
    anySubagentRunning,
    runningSubagents,
  ]);

  const summaryLabel = React.useMemo(() => {
    if (buckets.length === 0) return "";
    if (buckets.length === 1) return buckets[0].label;
    // Multiple buckets — show a count summary.
    const runningCount = buckets.filter((b) => b.running).length;
    return `${runningCount} task${runningCount === 1 ? "" : "s"} running…`;
  }, [buckets]);

  const handleJumpToSubagents = () => {
    setRightPanelTab("subagents");
  };

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0, y: 12, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 12, scale: 0.97 }}
          transition={{ duration: 0.18, ease: "easeOut" }}
          className="fixed z-50 right-3 bottom-9 max-w-[320px] w-[calc(100vw-1.5rem)] sm:w-auto"
          role="status"
          aria-live="polite"
          aria-label={summaryLabel}
        >
          <div className="rounded-lg border bg-card shadow-lg overflow-hidden">
            {/* Collapsed summary row (always visible when the card is shown). */}
            <div
              className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-accent/40 transition-colors"
              onClick={() => setExpanded((v) => !v)}
              role="button"
              tabIndex={0}
              aria-expanded={expanded}
              aria-label={expanded ? "Collapse task details" : "Expand task details"}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setExpanded((v) => !v);
                }
              }}
            >
              <Spinner />
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium truncate">
                  {summaryLabel}
                </div>
                {buckets.length > 1 && (
                  <div className="text-[10px] text-muted-foreground font-mono">
                    {buckets.length} active
                  </div>
                )}
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="size-6 p-0 shrink-0"
                onClick={(e) => {
                  e.stopPropagation();
                  setExpanded((v) => !v);
                }}
                aria-label={expanded ? "Collapse" : "Expand"}
              >
                {expanded ? (
                  <ChevronDown className="size-3" />
                ) : (
                  <ChevronUp className="size-3" />
                )}
              </Button>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="size-6 p-0 shrink-0"
                    onClick={(e) => {
                      e.stopPropagation();
                      setUserDismissed(true);
                    }}
                    aria-label="Dismiss"
                  >
                    <X className="size-3" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="left">
                  Dismiss (reappears when a new task starts)
                </TooltipContent>
              </Tooltip>
            </div>

            {/* Expanded details panel. */}
            <AnimatePresence initial={false}>
              {expanded && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.15 }}
                  className="overflow-hidden border-t"
                >
                  <ul className="divide-y">
                    {buckets.map((b) => (
                      <li
                        key={b.id}
                        className="flex items-start gap-2 px-3 py-2"
                      >
                        <b.icon className="size-3.5 text-brand shrink-0 mt-0.5" />
                        <div className="flex-1 min-w-0">
                          <div className="text-[11px] font-medium truncate">
                            {b.label}
                          </div>
                          {b.detail && (
                            <div
                              className="text-[10px] text-muted-foreground font-mono truncate"
                              title={b.detail}
                            >
                              {b.detail}
                            </div>
                          )}
                        </div>
                        {b.id === "subagents" && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 px-2 text-[10px] gap-1 shrink-0"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleJumpToSubagents();
                            }}
                          >
                            View
                          </Button>
                        )}
                      </li>
                    ))}
                    {/* Subagent detail list (when subagents are running). */}
                    {anySubagentRunning && (
                      <li className="px-3 py-2 bg-muted/30">
                        <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
                          Subagents
                        </div>
                        <ul className="space-y-1 max-h-32 overflow-y-auto">
                          {runningSubagents.slice(0, 6).map((s) => (
                            <SubagentRow key={s.id} subagent={s} />
                          ))}
                          {runningSubagents.length > 6 && (
                            <li className="text-[10px] text-muted-foreground">
                              +{runningSubagents.length - 6} more…
                            </li>
                          )}
                        </ul>
                      </li>
                    )}
                  </ul>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function SubagentRow({ subagent }: { subagent: Subagent }) {
  return (
    <li className="flex items-center gap-1.5 text-[10px]">
      <Loader2 className="size-2.5 text-brand animate-spin shrink-0" />
      <span
        className="font-medium truncate flex-1 min-w-0"
        title={subagent.name}
      >
        {subagent.name}
      </span>
      <Badge
        variant="outline"
        className="text-[8px] h-3 px-1 font-mono capitalize text-brand border-brand/40"
      >
        {subagent.status}
      </Badge>
    </li>
  );
}

function Spinner() {
  return (
    <div className="relative size-4 shrink-0">
      <Loader2 className="size-4 text-brand animate-spin" />
    </div>
  );
}

