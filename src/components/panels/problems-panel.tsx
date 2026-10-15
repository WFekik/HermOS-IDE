"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, XCircle, CheckCircle2, Loader2 } from "lucide-react";
import { useAppStore } from "@/stores/app-store";
import { useTranslation } from "@/hooks/use-translation";
import { fetchFile, workspaceKeys, isBinaryPlaceholder } from "@/components/workspace/types";
import { lintContent, type Diagnostic } from "@/lib/linter";
import { languageFromExt } from "@/lib/symbols";

/**
 * Problems panel — surfaces the regex-based JS/TS diagnostics from
 * src/lib/linter.ts for the active file tab. Previously the linter had
 * zero UI surface; now every rule hit is a row that jumps to its line.
 */
export function ProblemsPanel() {
  const { t } = useTranslation();
  const activeFileTab = useAppStore((s) => s.activeFileTab);

  const fileQuery = useQuery({
    queryKey: activeFileTab ? workspaceKeys.file(activeFileTab) : ["workspace", "file", "__none__"],
    queryFn: () => fetchFile(activeFileTab!),
    enabled: !!activeFileTab,
  });

  const diagnostics: Diagnostic[] | null = React.useMemo(() => {
    const file = fileQuery.data;
    // Backend flags new reads; stale caches may carry the placeholder text
    // without the flag — check both, like the file editor does.
    if (!file || file.isBinary === true || isBinaryPlaceholder(file.content)) return null;
    const lang = activeFileTab ? languageFromExt(activeFileTab) : null;
    if (!lang) return [];
    try {
      return lintContent(file.content, lang);
    } catch {
      return [];
    }
  }, [fileQuery.data, activeFileTab]);

  const jump = (d: Diagnostic) => {
    if (!activeFileTab) return;
    window.dispatchEvent(
      new CustomEvent("hermos:open-file", {
        detail: { path: activeFileTab, line: d.line, column: d.column },
      }),
    );
  };

  if (!activeFileTab) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center">
        <p className="text-xs text-muted-foreground">{t("problems_no_file")}</p>
      </div>
    );
  }

  if (fileQuery.isLoading) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (diagnostics === null) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center">
        <p className="text-xs text-muted-foreground">{t("problems_binary")}</p>
      </div>
    );
  }

  if (diagnostics.length === 0) {
    const lang = languageFromExt(activeFileTab);
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <CheckCircle2 className="size-5 text-emerald-600 dark:text-emerald-400" />
        <p className="text-xs text-muted-foreground">
          {lang ? t("problems_clean") : t("problems_unsupported")}
        </p>
      </div>
    );
  }

  const errors = diagnostics.filter((d) => d.severity === "error").length;
  const warnings = diagnostics.length - errors;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b bg-muted/20 px-3 py-1.5 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <XCircle className="size-3 text-red-500" />
          {t("problems_errors", { count: errors })}
        </span>
        <span className="flex items-center gap-1">
          <AlertTriangle className="size-3 text-amber-500" />
          {t("problems_warnings", { count: warnings })}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto" role="list" aria-label={t("problems")}>
        {diagnostics.map((d, i) => (
          <button
            key={`${d.rule}-${d.line}-${d.column}-${i}`}
            type="button"
            role="listitem"
            onClick={() => jump(d)}
            className="flex w-full items-start gap-2 border-b border-border/40 px-3 py-1.5 text-start hover:bg-accent/30"
          >
            {d.severity === "error" ? (
              <XCircle className="mt-0.5 size-3.5 shrink-0 text-red-500" />
            ) : (
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
            )}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs text-foreground/90">{d.message}</span>
              <span className="mt-0.5 block font-mono text-[10px] text-muted-foreground">
                {t("problems_location", { line: d.line, column: d.column, rule: d.rule })}
              </span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
