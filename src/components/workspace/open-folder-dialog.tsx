"use client";

import * as React from "react";
import { Loader2, FolderOpen, FolderCheck, CornerDownLeft } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { isTauri } from "@/lib/tauri";
import { useTranslation } from "@/hooks/use-translation";
import type { WorkspaceInfo } from "@/components/workspace/types";

export interface OpenFolderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaces: WorkspaceInfo[];
  listLoading: boolean;
  activeName: string | null;
  onOpen: (name: string) => Promise<void>;
}

export function OpenFolderDialog({
  open,
  onOpenChange,
  workspaces,
  listLoading,
  activeName,
  onOpen,
}: OpenFolderDialogProps) {
  const { t } = useTranslation();
  const [name, setName] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const isWebMode = !isTauri();

  React.useEffect(() => {
    if (open) {
      setName("");
      const timer = setTimeout(() => inputRef.current?.focus(), 60);
      return () => clearTimeout(timer);
    }
  }, [open]);

  const submit = async (value?: string) => {
    const trimmed = (value ?? name).trim();
    if (!trimmed) return;
    setSubmitting(true);
    try {
      await onOpen(trimmed);
      onOpenChange(false);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !submitting && onOpenChange(o)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isWebMode ? t("new_workspace_sandboxed") : t("open_folder")}</DialogTitle>
          <DialogDescription>
            {isWebMode
              ? t("sandboxed_workspace_desc")
              : t("local_workspace_desc")}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3.5">
          <div className="grid gap-1.5">
            <Label htmlFor="ws-name">{t("folder_name")}</Label>
            <div className="flex gap-2">
              <Input
                id="ws-name"
                ref={inputRef}
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void submit();
                  }
                }}
                placeholder="my-project"
                disabled={submitting}
                spellCheck={false}
                autoComplete="off"
              />
              <Button
                onClick={() => void submit()}
                disabled={submitting || !name.trim()}
                className="gap-1"
              >
                {submitting ? (
                  <>
                    <Loader2 className="size-4 animate-spin" /> {t("opening")}
                  </>
                ) : (
                  <>
                    <FolderOpen className="size-4" /> {t("open")}
                  </>
                )}
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              {t("folder_name_hint")}
            </p>
          </div>

          {/* Recent workspaces */}
          <div className="grid gap-1.5">
            <Label className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {t("recent_folders")}
            </Label>
            <div className="max-h-40 overflow-y-auto rounded-md border">
              {listLoading ? (
                <div className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" /> {t("loading_ellipsis")}
                </div>
              ) : workspaces.length === 0 ? (
                <div className="px-3 py-3 text-xs text-muted-foreground">
                  {t("no_recent_folders")}
                </div>
              ) : (
                <ul className="divide-y">
                  {workspaces.map((ws) => {
                    const isActive = ws.isActive || ws.name === activeName;
                    return (
                      <li key={ws.id}>
                        <button
                          type="button"
                          disabled={submitting}
                          onClick={() => void submit(ws.name)}
                          className={cn(
                            "flex w-full items-center gap-2 px-3 py-2 text-start text-xs transition-colors",
                            "hover:bg-accent/70 disabled:opacity-50",
                            isActive && "bg-accent/50",
                          )}
                        >
                          {isActive ? (
                            <FolderCheck className="size-3.5 shrink-0 text-brand" />
                          ) : (
                            <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
                          )}
                          <span className="flex-1 truncate font-mono">
                            {ws.name}
                          </span>
                          {isActive && (
                            <Badge
                              variant="outline"
                              className="h-4 px-1 text-[9px] uppercase tracking-wide text-brand border-brand/40"
                            >
                              {t("active")}
                            </Badge>
                          )}
                          <CornerDownLeft className="size-3 text-muted-foreground/60" />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            {t("cancel")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
