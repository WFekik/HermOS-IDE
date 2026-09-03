"use client";

import * as React from "react";
import { motion } from "framer-motion";
import { FileCode2, Bug, FileSearch, FlaskConical } from "lucide-react";
import { HermOSLogo } from "@/components/brand/hermos-logo";
import { useAppStore } from "@/stores/app-store";
import { cn } from "@/lib/utils";
import { isMacPlatform } from "@/lib/platform";

interface EmptyStateProps {
  onPick: (prompt: string) => void;
  className?: string;
}

interface SuggestionCardDef {
  title: string;
  description: string;
  prompt: string;
  icon: React.ElementType;
}

const SUGGESTIONS: SuggestionCardDef[] = [
  {
    title: "Scaffold a feature",
    description: "Generate a new module with tests and docs.",
    prompt:
      "Scaffold a new feature module: generate the source file, a colocated unit test, and a short README section. Explain the structure you chose.",
    icon: FileCode2,
  },
  {
    title: "Fix a bug",
    description: "Describe the symptom; the agent will investigate.",
    prompt:
      "I'm hitting a bug. Here's the symptom and the smallest reproduction I have. Investigate the likely cause, propose a fix, and apply it.",
    icon: Bug,
  },
  {
    title: "Explain code",
    description: "Point at a file and get a clear breakdown.",
    prompt:
      "Open the active file and explain what it does, line by line. Call out anything surprising, risky, or worth refactoring.",
    icon: FileSearch,
  },
  {
    title: "Write tests",
    description: "Generate unit tests for existing functions.",
    prompt:
      "Pick the most important module in this project and generate thorough unit tests. Cover happy path, edge cases, and error handling.",
    icon: FlaskConical,
  },
];

/**
 * Chat empty state — centered hero with the HermOS mark, headline, subheadline,
 * a 2×2 grid of suggestion cards, and a ⌘K hint.
 *
 * Clicking a card fills the composer draft via onPick.
 */
export function EmptyState({ onPick, className }: EmptyStateProps) {
  const activeFileTab = useAppStore((s) => s.activeFileTab);
  const hasActiveFile = Boolean(activeFileTab);
  const requestOpenFolderDialog = useAppStore((s) => s.requestOpenFolderDialog);
  const setRightPanelTab = useAppStore((s) => s.setRightPanelTab);
  const conversationWidth = useAppStore((s) => s.conversationWidth);
  const isMac = isMacPlatform();
  const suggestions = SUGGESTIONS;

  const handlePick = React.useCallback(
    (s: SuggestionCardDef) => {
      if (s.title === "Explain code" && !hasActiveFile) {
        setRightPanelTab("files");
        requestOpenFolderDialog();
        return;
      }
      onPick(s.prompt);
    },
    [hasActiveFile, onPick, requestOpenFolderDialog, setRightPanelTab],
  );

  return (
    <div className={cn("flex min-h-full flex-col items-center justify-center p-6", className)}>
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className={cn(
          "w-full text-center",
          conversationWidth === "wide" ? "max-w-3xl" : conversationWidth === "narrow" ? "max-w-xl" : "max-w-2xl"
        )}
      >
        <HermOSLogo size={48} className="mx-auto mb-5 opacity-90" />

        <h2 className="text-2xl font-semibold tracking-tight text-foreground">
          What should we build today?
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          An agent that reads, writes, and runs code in your workspace.
        </p>

        <div className="mt-7 grid grid-cols-1 sm:grid-cols-2 gap-2.5 text-left">
          {suggestions.map((s, i) => {
            const Icon = s.icon;
            return (
              <motion.button
                key={s.title}
                type="button"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3, delay: 0.05 + i * 0.05 }}
                onClick={() => handlePick(s)}
                className="group rounded-xl border bg-card p-3.5 text-left hover:-translate-y-0.5 hover:border-brand/40 hover:shadow-sm transition-all"
              >
                <div className="flex items-start gap-3">
                  <span className="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-brand transition-colors group-hover:bg-brand/10">
                    <Icon className="size-4" />
                  </span>
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-foreground">{s.title}</div>
                    <div className="mt-0.5 text-xs text-muted-foreground line-clamp-2">
                      {s.description}
                    </div>
                  </div>
                </div>
              </motion.button>
            );
          })}
        </div>

        <div className="mt-6 flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground">
          <span>Press</span>
          <kbd className="inline-flex items-center rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground/80">
            {isMac ? "⌘" : "Ctrl"}
          </kbd>
          <kbd className="inline-flex items-center rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground/80">
            K
          </kbd>
          <span>to open the command palette</span>
        </div>
      </motion.div>
    </div>
  );
}
