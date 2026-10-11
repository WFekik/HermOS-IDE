"use client";

import * as React from "react";
import { FileCode2, FolderX, Loader2, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
} from "@/components/ui/alert-dialog";
import { useTranslation } from "@/hooks/use-translation";
import type { UndoPreview } from "@/lib/undo-plan";
import { cn } from "@/lib/utils";

export interface UndoConfirmState {
  messageId: string;
  preview: UndoPreview;
  /** True when the preview went stale (409) and this is the refreshed plan. */
  refreshed?: boolean;
}

interface ConfirmUndoDialogProps {
  state: UndoConfirmState | null;
  confirming: boolean;
  onCancel: () => void;
  onConfirm: (revertFiles: boolean) => void;
}

/**
 * Confirm Undo dialog (mirrors the reference UX): title, description, a
 * "Revert file changes" checkbox, then one row per affected file with the
 * filename and INVERTED line stats — green +N for lines the undo will ADD
 * back, red −N for lines it will REMOVE. Cancel / Confirm actions.
 * Nothing here touches disk; Confirm only authorizes the DELETE call, and
 * the server re-verifies the plan hashes before executing (409 on drift).
 */
export function ConfirmUndoDialog({ state, confirming, onCancel, onConfirm }: ConfirmUndoDialogProps) {
  const { t } = useTranslation();
  const [revertFiles, setRevertFiles] = React.useState(true);

  // Reset the checkbox per message, NOT per preview: a 409 refresh swaps in
  // a new preview object for the same undo and must not re-check a box the
  // user deliberately unchecked.
  const messageId = state?.messageId;
  React.useEffect(() => {
    if (messageId) setRevertFiles(true);
  }, [messageId]);

  const open = state !== null;
  const files = state?.preview.files ?? [];
  const dirsRemoved = state?.preview.dirsRemoved ?? 0;

  return (
    <AlertDialog open={open} onOpenChange={(v) => { if (!v && !confirming) onCancel(); }}>
      <AlertDialogContent className="sm:max-w-md p-5 gap-3">
        <div className="flex items-start justify-between gap-2">
          <AlertDialogTitle className="text-base font-semibold">
            {t("confirm_undo")}
          </AlertDialogTitle>
        </div>
        <AlertDialogDescription className="text-[13px] text-muted-foreground -mt-1">
          {state?.refreshed ? t("undo_files_changed") : t("confirm_undo_desc")}
        </AlertDialogDescription>

        <label className="flex items-center gap-2.5 rounded-lg border border-border/60 bg-muted/30 px-3 py-2.5 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={revertFiles}
            onChange={(e) => setRevertFiles(e.target.checked)}
            aria-label={t("revert_file_changes")}
            className={cn(
              "size-4 shrink-0 cursor-pointer appearance-none rounded-[5px] border transition-colors",
              "border-brand/60 bg-transparent",
              "checked:border-brand checked:bg-brand",
              "checked:bg-[url('data:image/svg+xml;utf8,<svg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 24 24%27 fill=%27none%27 stroke=%27white%27 stroke-width=%273.5%27 stroke-linecap=%27round%27 stroke-linejoin=%27round%27><path d=%27M20 6 9 17l-5-5%27/></svg>')] checked:bg-center checked:bg-no-repeat",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand",
            )}
          />
          <span className="text-sm font-medium">{t("revert_file_changes")}</span>
        </label>

        {revertFiles && files.length === 0 && (
          <p className="text-xs text-muted-foreground px-1">
            {t("undo_no_file_changes")}
          </p>
        )}

        {revertFiles && files.length > 0 && (
          <div className="max-h-56 overflow-y-auto rounded-lg border border-border/60 divide-y divide-border/40">
            {files.map((f) => (
              <div key={f.path} className="flex items-center gap-2 px-3 py-2 min-w-0">
                {f.status === "created" ? (
                  <FolderX className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                ) : (
                  <FileCode2 className="size-4 shrink-0 text-brand" aria-hidden />
                )}
                <span className="truncate text-[13px] font-mono min-w-0 flex-1" title={f.display}>
                  {f.display}
                </span>
                <span className="shrink-0 font-mono text-xs tabular-nums">
                  {f.restored > 0 && (
                    <span className="text-emerald-500">+{f.restored}</span>
                  )}
                  {f.restored > 0 && f.removed > 0 && <span className="text-muted-foreground"> </span>}
                  {f.removed > 0 && (
                    <span className="text-red-500">−{f.removed}</span>
                  )}
                  {f.restored === 0 && f.removed === 0 && (
                    <span className="text-muted-foreground">±0</span>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}

        {revertFiles && dirsRemoved > 0 && (
          <p className="text-xs text-muted-foreground px-1">
            {t("undo_folders_removed", { count: dirsRemoved })}
          </p>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={confirming}>
            {t("cancel")}
          </Button>
          <Button
            size="sm"
            onClick={() => onConfirm(revertFiles)}
            disabled={confirming}
            className="gap-1.5 bg-brand text-white hover:bg-brand/90"
          >
            {confirming ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RotateCcw className="size-3.5" />
            )}
            {t("confirm")}
          </Button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}
