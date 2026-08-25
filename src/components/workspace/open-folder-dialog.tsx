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
  const [name, setName] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const isWebMode = !isTauri();

  React.useEffect(() => {
    if (open) {
      setName("");
      const t = setTimeout(() => inputRef.current?.focus(), 60);
      return () => clearTimeout(t);
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
          <DialogTitle>{isWebMode ? "New workspace (sandboxed)" : "Open folder"}</DialogTitle>
          <DialogDescription>
            {isWebMode
              ? "Creates a sandboxed directory under ~/.hermos/workspaces — your existing folders require the desktop app."
              : "Open or create a local workspace folder on your machine."}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3.5">
          <div className="grid gap-1.5">
            <Label htmlFor="ws-name">Folder name</Label>
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
                    <Loader2 className="size-4 animate-spin" /> Opening
                  </>
                ) : (
                  <>
                    <FolderOpen className="size-4" /> Open
                  </>
                )}
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Press <kbd className="rounded border bg-muted px-1 font-mono text-[10px]">Enter</kbd> to open. Allowed: letters, digits, dots, dashes, underscores.
            </p>
          </div>

          {/* Recent workspaces */}
          <div className="grid gap-1.5">
            <Label className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Recent folders
            </Label>
            <div className="max-h-40 overflow-y-auto rounded-md border">
              {listLoading ? (
                <div className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" /> Loading…
                </div>
              ) : workspaces.length === 0 ? (
                <div className="px-3 py-3 text-xs text-muted-foreground">
                  No recent folders. Type a name above to create one.
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
                            "flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors",
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
                              active
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
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
