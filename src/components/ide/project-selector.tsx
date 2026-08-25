"use client";

import * as React from "react";
import {
  Folder,
  ChevronDown,
  Check,
  FolderPlus,
} from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useAppStore, type WorkspaceListItem } from "@/stores/app-store";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { isTauri } from "@/lib/tauri";

export function ProjectSelector({
  className,
  createOnSwitch = true,
}: {
  className?: string;
  /** When true (fresh-chat context), selecting a workspace also creates a new conversation. */
  createOnSwitch?: boolean;
}) {
  const workspaces = useAppStore((s) => s.workspaces);
  const activeWorkspace = useAppStore((s) => s.activeWorkspace);
  const refreshWorkspaces = useAppStore((s) => s.refreshWorkspaces);
  const switchWorkspace = useAppStore((s) => s.switchWorkspace);
  const createConversation = useAppStore((s) => s.createConversation);
  const setRightPanelTab = useAppStore((s) => s.setRightPanelTab);
  const requestOpenFolderDialog = useAppStore((s) => s.requestOpenFolderDialog);

  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      void refreshWorkspaces();
    }
  }, [open, refreshWorkspaces]);

  const handleSelectWorkspace = async (ws: WorkspaceListItem) => {
    setOpen(false);
    try {
      if (!ws.isActive) {
        await switchWorkspace(
          ws.id,
          ws.name,
          createOnSwitch ? { skipAutoSelectConversation: true } : undefined,
        );
      }
      if (createOnSwitch) {
        await createConversation({ workspaceId: ws.id });
      }
      toast.success(`Switched to ${ws.name}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't switch workspace");
    }
  };

  const handleOpenFolder = () => {
    setOpen(false);
    setRightPanelTab("files");
    requestOpenFolderDialog();
  };

  const displayName = activeWorkspace?.rootDir || activeWorkspace?.name || "Select Project";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Current project: ${displayName}. Click to change.`}
          className={cn(
            "group inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-mono transition-colors",
            "text-muted-foreground hover:text-foreground hover:bg-muted/40",
            "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand/40",
            className,
          )}
        >
          <Folder className="size-3.5 shrink-0 text-muted-foreground group-hover:text-foreground transition-colors" />
          <span className="truncate max-w-[260px] text-foreground/90 font-medium">
            {displayName}
          </span>
          <ChevronDown
            className={cn(
              "size-3 shrink-0 text-muted-foreground/60 transition-transform duration-150",
              open && "rotate-180",
            )}
          />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        className="w-72 rounded-2xl p-1.5 border border-border/60 bg-popover/95 shadow-2xl backdrop-blur-md"
      >
        <div className="space-y-0.5">
          {workspaces.map((ws) => {
            const label = ws.rootDir || ws.name;
            return (
              <button
                key={ws.id}
                type="button"
                onClick={() => void handleSelectWorkspace(ws)}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-xs text-left transition-colors font-mono",
                  "hover:bg-accent hover:text-foreground",
                  ws.isActive ? "text-foreground font-medium" : "text-muted-foreground",
                )}
              >
                <Folder className="size-3.5 shrink-0" />
                <span className="flex-1 truncate" title={label}>
                  {label}
                </span>
                {ws.isActive && <Check className="size-3.5 shrink-0 text-foreground" />}
              </button>
            );
          })}
        </div>

        <div className="my-1.5 h-px bg-border/40" />

        <button
          type="button"
          onClick={handleOpenFolder}
          className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-xs text-left transition-colors text-foreground/90 hover:bg-accent"
        >
          <FolderPlus className="size-3.5 shrink-0 text-muted-foreground" />
          <span>{!isTauri() ? "New workspace (sandboxed)" : "Open Folder / New Project"}</span>
        </button>
        {!isTauri() && (
          <p className="px-2.5 pt-1 text-[10px] leading-snug text-muted-foreground">
            Creates a sandboxed directory under ~/.hermos/workspaces — your existing folders require the desktop app.
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
