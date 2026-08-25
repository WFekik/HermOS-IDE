"use client";

import * as React from "react";
import { motion } from "framer-motion";
import {
  Folder,
  FileText,
  HelpCircle,
  Sun,
  Moon,
  Monitor,
  Scissors,
} from "lucide-react";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAppStore } from "@/stores/app-store";
import { useThemeToggle } from "@/hooks/use-theme-toggle";
import { useShallow } from "zustand/react/shallow";
import { cn } from "@/lib/utils";
import { lookupContextWindow } from "@/lib/model-context-windows";
import { resolveEffectiveMaxInputBudget } from "@/lib/ai/context";
import { aggregateMessageStats } from "@/lib/message-stats";
import type { ProviderId } from "@/lib/types";
import { formatModelDisplayName } from "@/components/ide/model-selector";
import { ProviderLogo } from "@/components/brand/provider-logo";
import { DEFAULT_OPENAI_FALLBACK_MODEL } from "@/lib/ai/providers";

export function StatusBar() {
  const isStreaming = useAppStore((s) => s.isStreaming);
  const activeConversationId = useAppStore((s) => s.activeConversationId);
  const composerMode = useAppStore((s) => s.composerMode);
  const selectedProvider = useAppStore((s) => s.selectedProvider);
  const selectedModel = useAppStore((s) => s.selectedModel);
  const providers = useAppStore((s) => s.providers);
  const setRightPanelTab = useAppStore((s) => s.setRightPanelTab);
  const setSettingsTab = useAppStore((s) => s.setSettingsTab);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const toggleShortcutsOpen = useAppStore((s) => s.toggleShortcutsOpen);
  const contextTrimmed = useAppStore((s) => s.contextTrimmed);
  const setContextTrimmed = useAppStore((s) => s.setContextTrimmed);

  const { theme, cycle } = useThemeToggle();

  const activeWorkspace = useAppStore((s) => s.activeWorkspace);
  // The active file tab (open file) from the store — mirrors the editor.
  const activeFile = useAppStore((s) => s.activeFileTab);

  // Grounded Context — every number here is either provider-measured usage
  // or a persisted measured value, never a hidden heuristic estimate. While
  // a run streams, the executor also pushes live BPE estimates (flagged
  // `estimated`) so the ring moves in real time even for providers that
  // don't report usage; the selector returns only primitives so `useShallow`
  // keeps this stable across streaming flushes that replace `messages`
  // without changing totals.
  const { tokensIn, tokensOut, totalTokens, lastPromptTokens, lastPromptTokensEstimated, cacheReadsTotal, cacheWritesTotal, costValue, costUnknown } =
    useAppStore(
      useShallow((s) =>
        aggregateMessageStats(s.messages, s.selectedProvider, s.selectedModel, s.providers),
      ),
    );
  const cost = { value: costValue, unknown: costUnknown };

  // Context window: look up the current model's max context window from the
  // provider catalog. Uses lookupContextWindow fallback so the circle renders.
  const { contextWindow } = React.useMemo(() => {
    const provider = providers.find((p) => p.id === selectedProvider);
    const concreteModel = (selectedModel && selectedModel !== "auto")
      ? selectedModel
      : (provider?.models.find((m) => m.id !== "auto")?.id || DEFAULT_OPENAI_FALLBACK_MODEL);

    const modelInfo = provider?.models.find((m) => m.id === concreteModel);
    const cw = modelInfo?.contextWindow ?? lookupContextWindow(concreteModel);

    return {
      contextWindow: cw,
    };
  }, [providers, selectedProvider, selectedModel]);

  const currentProvider = providers.find((p) => p.id === selectedProvider);
  const providerLabel = currentProvider?.name ?? selectedProvider;
  const modelLabel = selectedModel && selectedModel !== "auto" ? formatModelDisplayName(selectedModel) : "—";

  const ThemeIcon = theme === "light" ? Sun : theme === "dark" ? Moon : Monitor;
  const themeLabel = theme === "light" ? "Light" : theme === "dark" ? "Dark" : "System";

  const fmtTokens = fmtTokensFn;

  const fmtCost = (c: { value: number; unknown: boolean }) => {
    if (c.unknown) return "$?";
    if (c.value === 0) return "$0.00";
    if (c.value < 0.01) return `$${c.value.toFixed(4)}`;
    if (c.value < 1) return `$${c.value.toFixed(3)}`;
    return `$${c.value.toFixed(2)}`;
  };

  const costStr = fmtCost(cost);
  const costColorClass =
    cost.unknown
      ? "text-muted-foreground"
      : cost.value < 0.01
        ? "text-brand"
        : cost.value <= 0.1
          ? "text-amber-600 dark:text-amber-500"
          : "text-foreground/80";

  // Context ring value: the live per-iteration reading (last execution's
  // prompt tokens — measured when the provider reports usage, else the
  // executor's flagged estimate) wins over the one-shot post-trim snapshot
  // from `context_trimmed`. The snapshot is only a fallback before the
  // first per-iteration reading of a run exists, so the ring keeps growing
  // with the actual context instead of freezing at the trim value.
  const livePromptTokens = lastPromptTokens > 0 ? lastPromptTokens : null;
  const ringUsed = livePromptTokens ?? contextTrimmed?.activePromptTokens ?? null;
  // The post-trim snapshot is always a BPE estimate (the executor has no
  // measured reading for it), so the fallback path must carry the "~" mark.
  const ringEstimated = livePromptTokens !== null ? lastPromptTokensEstimated : ringUsed !== null;

  return (
    <footer
      className="h-6 shrink-0 flex items-stretch border-t bg-background px-2 text-[11px] font-mono text-muted-foreground select-none"
      role="contentinfo"
      aria-label="Status bar"
    >
      {/* Left group */}
      <div className="flex items-center gap-1.5 min-w-0">
        <StatusBarItem
          onClick={() => setRightPanelTab("files")}
          tooltip={activeWorkspace ? `Workspace: ${activeWorkspace.name}` : "No workspace open"}
        >
          <Folder className={cn("size-3", activeWorkspace ? "text-brand" : "text-muted-foreground")} />
          <span className="max-w-[140px] truncate text-foreground/80">
            {activeWorkspace ? activeWorkspace.name : "no workspace"}
          </span>
        </StatusBarItem>

        {activeFile && (
          <>
            <Separator orientation="vertical" className="h-3 hidden lg:block" />
            <StatusBarItem
              onClick={() => setRightPanelTab("files")}
              tooltip={`Open file: ${activeFile}`}
              className="hidden lg:flex"
            >
              <FileText className="size-3 text-muted-foreground" />
              <span className="max-w-[220px] truncate text-foreground/80">{activeFile}</span>
            </StatusBarItem>
          </>
        )}

        <Separator orientation="vertical" className="h-3 hidden lg:block" />
        <StatusBarItem
          tooltip={`Agent mode: ${composerMode}`}
          className="hidden lg:flex"
        >
          <span className="capitalize text-foreground/80">{composerMode}</span>
        </StatusBarItem>

        {contextTrimmed && (
          <>
            <Separator orientation="vertical" className="h-3" />
            <ContextTrimmedBadge
              dropped={contextTrimmed.dropped}
              keptTokens={contextTrimmed.keptTokens}
              onDismiss={() => setContextTrimmed(null)}
            />
          </>
        )}
      </div>

      {/* Center group */}
      <div className="flex-1 flex items-center justify-center min-w-0">
        {isStreaming ? (
          <div className="flex items-center gap-1.5 text-brand">
            <StreamingDots />
            <span>Agent working…</span>
          </div>
        ) : activeConversationId ? (
          <span className="text-muted-foreground/70">Ready</span>
        ) : (
          <span className="text-muted-foreground/70">No conversation</span>
        )}
      </div>

      {/* Right group */}
      <div className="flex items-center gap-1.5 min-w-0">
        <StatusBarItem
          onClick={() => {
            setSettingsTab("providers");
            setSettingsOpen(true);
          }}
          tooltip={`Provider: ${providerLabel} · Model: ${modelLabel}`}
        >
          <ProviderLogo providerId={selectedProvider} modelId={selectedModel} size={14} />
          <span className="text-brand">{providerLabel}</span>
          <span className="text-muted-foreground/60">·</span>
          <span className="text-foreground/80 max-w-[160px] truncate">{modelLabel}</span>
        </StatusBarItem>

        <Separator orientation="vertical" className="h-3 hidden lg:block" />
        <StatusBarItem
          tooltip={
            cost.unknown
              ? `Cumulative Session Tokens Sum (Σ): ${fmtTokens(tokensIn)} in · ${fmtTokens(tokensOut)} out (all turns combined)\nEstimated cost: unknown (rate not configured)`
              : `Cumulative Session Tokens Sum (Σ): ${fmtTokens(tokensIn)} in · ${fmtTokens(tokensOut)} out (${fmtTokens(totalTokens)} total across all turns)\nEstimated session cost: ${costStr}`
          }
          className="hidden lg:flex"
        >
          <span className="text-muted-foreground">Σ</span>
          <span className="text-foreground/80">{fmtTokens(totalTokens)} tok</span>
          <span className="text-muted-foreground/60">·</span>
          <span className={costColorClass}>{costStr}</span>
        </StatusBarItem>

        {contextWindow && (
          <>
            <Separator orientation="vertical" className="h-3 hidden lg:block" />
            <ContextCircle
              used={ringUsed}
              max={resolveEffectiveMaxInputBudget({ contextWindow })}
              promptTokens={ringUsed ?? 0}
              completionTokens={tokensOut}
              cacheReads={cacheReadsTotal}
              cacheWrites={cacheWritesTotal}
              estimated={ringEstimated}
            />
          </>
        )}

        <Separator orientation="vertical" className="h-3 hidden lg:block" />
        <StatusBarItem
          onClick={cycle}
          tooltip={`Theme: ${themeLabel} (click to cycle)`}
          className="hidden lg:flex"
        >
          <ThemeIcon className="size-3" />
          <span className="capitalize">{themeLabel}</span>
        </StatusBarItem>

        <Separator orientation="vertical" className="h-3" />
        <StatusBarItem
          onClick={toggleShortcutsOpen}
          tooltip="Keyboard shortcuts (⌘/)"
        >
          <HelpCircle className="size-3" />
        </StatusBarItem>
      </div>
    </footer>
  );
}

/**
 * Three dots bouncing in sequence — used as the live "Agent
 * working" streaming indicator in the center of the status bar.
 */
function StreamingDots() {
  return (
    <div
      className="flex items-center gap-[3px]"
      role="status"
      aria-label="Agent working"
    >
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="size-1 rounded-full bg-brand"
          animate={{ opacity: [0.35, 1, 0.35], y: [0, -1.5, 0] }}
          transition={{
            duration: 0.9,
            repeat: Infinity,
            delay: i * 0.18,
            ease: "easeInOut",
          }}
        />
      ))}
    </div>
  );
}

interface StatusBarItemProps {
  children: React.ReactNode;
  onClick?: () => void;
  tooltip?: string;
  className?: string;
}

function StatusBarItem({
  children,
  onClick,
  tooltip,
  className,
}: StatusBarItemProps) {
  const content = onClick ? (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 px-1.5 py-0.5 rounded transition-colors hover:bg-accent/70 hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        className,
      )}
    >
      {children}
    </button>
  ) : (
    <div className={cn("flex items-center gap-1.5 px-1 py-0.5", className)}>
      {children}
    </div>
  );

  if (!tooltip) return content;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{content}</TooltipTrigger>
      <TooltipContent side="top" className="text-[11px] font-mono whitespace-pre-line max-w-[320px]">
        {tooltip}
      </TooltipContent>
    </Tooltip>
  );
}

function ContextTrimmedBadge({
  dropped,
  keptTokens,
  onDismiss,
}: {
  dropped: number;
  keptTokens: number;
  onDismiss: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              className={cn(
                "flex items-center gap-1.5 px-1.5 py-0.5 rounded transition-colors",
                "text-amber-600 dark:text-amber-400 font-medium",
                "hover:bg-accent/70 hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              )}
              aria-label={`Context trimmed: ${dropped} message${dropped === 1 ? "" : "s"} dropped. Click for details.`}
            >
              <Scissors className="size-3 text-amber-600 dark:text-amber-400" />
              <span>
                {dropped} msg{dropped === 1 ? "" : "s"} dropped (~
                {keptTokens > 0 ? `${(keptTokens / 1000).toFixed(0)}k` : "0"} tok)
              </span>
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-[11px] font-mono">
          History trimmed to fit context window (click details)
        </TooltipContent>
      </Tooltip>
      <PopoverContent
        side="top"
        align="start"
        className="w-80 text-xs font-mono space-y-2 p-3"
      >
        <div className="flex items-start gap-2">
          <Scissors className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-500" />
          <div className="space-y-1.5">
            <p className="font-medium text-foreground">
              Conversation history was trimmed
            </p>
            <p className="text-muted-foreground leading-relaxed">
              The conversation exceeded the model&apos;s context window.
              <span className="font-mono text-amber-700 dark:text-amber-400">
                {" "}
                {dropped}{" "}
              </span>
              older message{dropped === 1 ? " was " : "s were "}
              dropped from the middle to fit. The first message and the
              last 6 messages are always kept.
            </p>
            <p className="text-muted-foreground/80 font-mono text-[10px]">
              Kept ~{keptTokens.toLocaleString()} tokens
            </p>
            <div className="flex justify-end pt-1">
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-[11px]"
                onClick={() => {
                  setOpen(false);
                  onDismiss();
                }}
              >
                Dismiss
              </Button>
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export type { ProviderId };
const fmtTokensFn = (n: number) => {
  if (n === 0) return "0";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
};

function getContextCircleColor(pct: number): string {
  if (pct < 0.5) {
    return "var(--success)";
  } else if (pct < 0.8) {
    return "oklch(70% 0.18 90)";
  } else {
    return "var(--destructive)";
  }
}

interface ContextCircleProps {
  /** Provider-measured input tokens of the last request, or null when unknown.
   *  When no measurement exists the caller may pass the last post-trim value
   *  as a fallback so the ring reflects the best known context state. */
  used: number | null;
  /** Effective input budget (resolveEffectiveMaxInputBudget). */
  max?: number;
  promptTokens: number;
  completionTokens: number;
  cacheReads: number;
  cacheWrites: number;
  /** True when `used` comes from the executor's live estimate, not provider
   *  usage. The unfilled remainder renders as a faint dashed band and the
   *  tooltip/popover add a "~" marker, so estimates are never mistaken for
   *  measured readings. */
  estimated?: boolean;
}

/**
 * Grounded context indicator. Mirrors Cline's behavior: when no provider
 * measured usage is available we render the ring fed by the executor's
 * live pre-stream estimates. The progress arc is always drawn solid so the
 * fill level stays readable; estimates are signaled by a faint dashed
 * remainder band plus the "~" markers in the tooltip/popover, so an
 * estimate is never mistaken for an unlabeled measured value.
 */
function ContextCircle({ used, max, promptTokens, completionTokens, cacheReads, cacheWrites, estimated }: ContextCircleProps) {
  const remaining = max && used != null ? Math.max(0, max - used) : undefined;
  const measured = used != null && used > 0;
  const pct = measured && max && max > 0 ? Math.min(used! / max, 1) : 0;
  const radius = 5;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - pct);
  const fillColor = getContextCircleColor(pct);

  const title = measured && max
    ? `Usage: ${estimated ? "~" : ""}${fmtTokensFn(used!)} / ${fmtTokensFn(max)} (${(pct * 100).toFixed(0)}% of the effective input budget${estimated ? " — estimated" : ""})`
    : "Usage: not reported by provider";

  const detail = (
    <div className="w-64 space-y-1.5 text-xs font-mono">
      <div className="flex items-center justify-between text-foreground">
        <span className="text-muted-foreground">Context window</span>
        <span>
          {measured && used != null ? `${estimated ? "~" : ""}${fmtTokensFn(used)} / ${max ? fmtTokensFn(max) : "?"}` : "—"} {remaining !== undefined ? `(${fmtTokensFn(remaining)} left)` : ""}
        </span>
      </div>
      <Separator className="bg-border/60" />
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1 text-muted-foreground">
          <span aria-hidden className="text-[10px]">↑</span> Prompt tokens
        </span>
        <span>{promptTokens > 0 ? `${estimated ? "~" : ""}${fmtTokensFn(promptTokens)}` : "not reported"}</span>
      </div>
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1 text-muted-foreground">
          <span aria-hidden className="text-[10px]">↓</span> Completion tokens
        </span>
        <span>{fmtTokensFn(completionTokens)}</span>
      </div>
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1 text-muted-foreground">
          <span aria-hidden className="text-[10px]">←</span> Cache read
        </span>
        <span>{cacheReads > 0 ? fmtTokensFn(cacheReads) : "0"}</span>
      </div>
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1 text-muted-foreground">
          <span aria-hidden className="text-[10px]">→</span> Cache write
        </span>
        <span>{cacheWrites > 0 ? fmtTokensFn(cacheWrites) : "0"}</span>
      </div>
      {estimated && (
        <p className="pt-1 text-[10px] text-muted-foreground/70">
          Latest reading is a live estimate (~) — this provider did not report usage for the last request.
        </p>
      )}
      {!measured && (
        <p className="pt-1 text-[10px] text-muted-foreground/70">
          This provider did not report usage. The ring stays empty until measured data arrives.
        </p>
      )}
    </div>
  );

  const trigger = (
    <span
      className="relative inline-flex items-center"
      role="img"
      aria-label={title}
    >
      <svg width="14" height="14" viewBox="0 0 14 14" className="size-3.5">
        <circle
          cx="7"
          cy="7"
          r={radius}
          fill="none"
          className="stroke-muted-foreground/20"
          strokeWidth="1.5"
        />
        {measured && (
          <>
            {/* Faint dashed underlay: only visible in the unfilled remainder
                when the reading is estimated, so the ring keeps signaling
                "estimate" without hiding the progress arc. */}
            {estimated && (
              <circle
                cx="7"
                cy="7"
                r={radius}
                fill="none"
                className="stroke-muted-foreground/25"
                strokeWidth="1.5"
                strokeDasharray="2 1.8"
                strokeLinecap="round"
              />
            )}
            {/* Solid progress arc: dasharray = full circumference with the
                dashoffset trimming the arc to `pct`, so the fill level is
                always visible (a repeating dash pattern would paint the
                same marks at 10% and 90% and lose the progress readout). */}
            <circle
              cx="7"
              cy="7"
              r={radius}
              fill="none"
              strokeWidth="1.5"
              strokeDasharray={circumference}
              strokeDashoffset={pct < 1 ? offset : 0}
              transform="rotate(-90 7 7)"
              strokeLinecap="round"
              style={{ stroke: fillColor, opacity: estimated ? 0.7 : 0.85 }}
            />
          </>
        )}
      </svg>
    </span>
  );

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="flex items-center px-1 py-0.5 rounded transition-colors hover:bg-accent/70"
              aria-label={title}
            >
              {trigger}
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-[11px] font-mono whitespace-pre-line max-w-[320px]">
          {title}
        </TooltipContent>
      </Tooltip>
      <PopoverContent side="top" align="end" className="w-72 p-3 text-xs font-mono">
        {detail}
      </PopoverContent>
    </Popover>
  );
}
