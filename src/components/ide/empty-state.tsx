"use client";

import * as React from "react";
import { motion } from "framer-motion";
import { FileCode2, Bug, FileSearch, FlaskConical } from "lucide-react";
import { HermOSLogo } from "@/components/brand/hermos-logo";
import { useAppStore } from "@/stores/app-store";
import { useTranslation } from "@/hooks/use-translation";
import { cn } from "@/lib/utils";
import { isMacPlatform } from "@/lib/platform";

interface EmptyStateProps {
  onPick: (prompt: string) => void;
  className?: string;
}

interface SuggestionCardDef {
  /** Stable translation key — used to look up title, description, and prompt in the i18n dictionary. */
  key: "scaffold_feature" | "fix_bug" | "explain_code" | "write_tests";
  title: string;
  description: string;
  prompt: string;
  icon: React.ElementType;
}

const SUGGESTIONS: SuggestionCardDef[] = [
  {
    key: "scaffold_feature",
    title: "Scaffold a feature",
    description: "Generate a new module with tests and docs.",
    prompt:
      "Scaffold a new feature module: generate the source file, a colocated unit test, and a short README section. Explain the structure you chose.",
    icon: FileCode2,
  },
  {
    key: "fix_bug",
    title: "Fix a bug",
    description: "Describe the symptom; the agent will investigate.",
    prompt:
      "I'm hitting a bug. Here's the symptom and the smallest reproduction I have. Investigate the likely cause, propose a fix, and apply it.",
    icon: Bug,
  },
  {
    key: "explain_code",
    title: "Explain code",
    description: "Point at a file and get a clear breakdown.",
    prompt:
      "Open the active file and explain what it does, line by line. Call out anything surprising, risky, or worth refactoring.",
    icon: FileSearch,
  },
  {
    key: "write_tests",
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
  const { t } = useTranslation();
  const activeFileTab = useAppStore((s) => s.activeFileTab);
  const hasActiveFile = Boolean(activeFileTab);
  const requestOpenFolderDialog = useAppStore((s) => s.requestOpenFolderDialog);
  const setRightPanelTab = useAppStore((s) => s.setRightPanelTab);
  const conversationWidth = useAppStore((s) => s.conversationWidth);
  const isMac = isMacPlatform();
  const suggestions = SUGGESTIONS;

  const handlePick = React.useCallback(
    (cardKey: string, fallbackPrompt: string) => {
      if (cardKey === "explain_code" && !hasActiveFile) {
        setRightPanelTab("files");
        requestOpenFolderDialog();
        return;
      }
      const promptKey = `${cardKey}_prompt`;
      const prompt = t(promptKey) !== promptKey ? t(promptKey) : fallbackPrompt;
      onPick(prompt);
    },
    [hasActiveFile, onPick, requestOpenFolderDialog, setRightPanelTab, t],
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
          {t("empty_state_title")}
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {t("empty_state_subtitle")}
        </p>

        <div className="mt-7 grid grid-cols-1 sm:grid-cols-2 gap-2.5 text-start">
          {suggestions.map((s, i) => {
            const Icon = s.icon;
            const titleText = t(s.key);
            const descText = t(`${s.key}_desc`);

            return (
              <motion.button
                key={s.key}
                type="button"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3, delay: 0.05 + i * 0.05 }}
                onClick={() => handlePick(s.key, s.prompt)}
                className="group rounded-xl border bg-card p-3.5 text-start hover:-translate-y-0.5 hover:border-brand/40 hover:shadow-sm transition-all"
              >
                <div className="flex items-start gap-3">
                  <span className="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-brand transition-colors group-hover:bg-brand/10">
                    <Icon className="size-4" />
                  </span>
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-foreground">{titleText}</div>
                    <div className="mt-0.5 text-xs text-muted-foreground line-clamp-2">
                      {descText}
                    </div>
                  </div>
                </div>
              </motion.button>
            );
          })}
        </div>

        <div className="mt-6 flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground">
          <span>{t("press")}</span>
          <kbd className="inline-flex items-center rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground/80">
            {isMac ? "⌘" : "Ctrl"}
          </kbd>
          <kbd className="inline-flex items-center rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground/80">
            K
          </kbd>
          <span>{t("open_command_palette")}</span>
        </div>
      </motion.div>
    </div>
  );
}
