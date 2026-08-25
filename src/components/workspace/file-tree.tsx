"use client";

import * as React from "react";
import {
  ChevronRight,
  ChevronDown,
  Folder,
  FolderOpen,
  FileText,
  FileCode,
  Braces,
  FileImage,
  FileCog,
  Loader2,
  Pencil,
  Trash2,
  Folder as FolderIcon,
} from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { fileNameIconKind, type FileNameIconKind } from "@/lib/tool-ui-shared";
import {
  type FileNode,
  baseName,
  dirName,
  joinPath,
} from "@/components/workspace/types";
import type { GitStatus, GitFileStatus } from "@/stores/app-store";

// Icon selection

const FILE_NAME_ICON: Record<FileNameIconKind, React.ElementType> = {
  code: FileCode,
  json: Braces,
  image: FileImage,
  config: FileCog,
  text: FileText,
};

function FileIcon({ name, className }: { name: string; className?: string }) {
  const Icon = FILE_NAME_ICON[fileNameIconKind(name)];
  return <Icon className={className} />;
}

// FileTree public props

export interface FileTreeProps {
  tree: FileNode[];
  selectedPath: string | null;
  expanded: Set<string>;
  onToggleExpand: (path: string) => void;
  onSelectFile: (path: string) => void;
  onRename: (from: string, to: string) => Promise<void>;
  onDelete: (path: string, type: "file" | "dir") => Promise<void>;
  /** Called when the user invokes "New File" / "New Folder" from a directory context menu. */
  onCreateIn?: (dirPath: string, type: "file" | "dir") => void;
  loading?: boolean;
  error?: Error | null;
  onRetry?: () => void;
  gitStatus?: GitStatus | null;
}

export function FileTree(props: FileTreeProps) {
  const {
    tree,
    selectedPath,
    expanded,
    onToggleExpand,
    onSelectFile,
    onRename,
    onDelete,
    onCreateIn,
    loading,
    error,
    onRetry,
    gitStatus,
  } = props;

  // Build a fast workspace-relative file path -> GitFileStatus map.
  const gitMap = React.useMemo(() => {
    const map = new Map<string, GitFileStatus>();
    if (!gitStatus || !gitStatus.isRepo) return map;
    gitStatus.staged?.forEach((c) => map.set(c.path, c.status));
    gitStatus.modified?.forEach((c) => map.set(c.path, c.status));
    gitStatus.untracked?.forEach((c) => map.set(c.path, c.status === "?" ? "U" : c.status));
    return map;
  }, [gitStatus]);

  // Inline rename state — tracks which node is being renamed and the draft value.
  const [renaming, setRenaming] = React.useState<string | null>(null);
  const [renameDraft, setRenameDraft] = React.useState("");

  // Delete confirmation state.
  const [pendingDelete, setPendingDelete] = React.useState<{
    path: string;
    type: "file" | "dir";
  } | null>(null);
  const [deleting, setDeleting] = React.useState(false);

  const startRename = (node: FileNode) => {
    setRenaming(node.path);
    setRenameDraft(baseName(node.path));
  };

  const commitRename = async () => {
    if (!renaming) return;
    const trimmed = renameDraft.trim();
    if (!trimmed || trimmed === baseName(renaming)) {
      setRenaming(null);
      return;
    }
    const to = joinPath(dirName(renaming), trimmed);
    const from = renaming;
    setRenaming(null);
    setRenameDraft("");
    try {
      await onRename(from, to);
    } catch {
      // caller handles toast; just bail
    }
  };

  const cancelRename = () => {
    setRenaming(null);
    setRenameDraft("");
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await onDelete(pendingDelete.path, pendingDelete.type);
      setPendingDelete(null);
    } finally {
      setDeleting(false);
    }
  };

  if (loading) {
    return (
      <div className="p-3 space-y-1.5">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="h-5 rounded bg-muted/60 animate-pulse"
            style={{ marginLeft: `${(i % 3) * 12}px` }}
          />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 text-center">
        <p className="text-xs text-muted-foreground">Failed to load files.</p>
        <Button
          size="sm"
          variant="ghost"
          className="mt-2 h-7 text-xs"
          onClick={onRetry}
        >
          Retry
        </Button>
      </div>
    );
  }

  if (tree.length === 0) {
    return (
      <div className="p-4 text-center text-xs text-muted-foreground">
        Empty workspace.
      </div>
    );
  }

  return (
    <>
      <div className="h-full min-h-0 overflow-y-auto overflow-x-auto">
        <div className="py-1.5 pr-2">
          {tree.map((node) => (
            <TreeNode
              key={node.path}
              node={node}
              depth={0}
              selectedPath={selectedPath}
              expanded={expanded}
              onToggleExpand={onToggleExpand}
              onSelectFile={onSelectFile}
              onStartRename={startRename}
              onDeleteRequest={(path, type) => setPendingDelete({ path, type })}
              onCreateIn={onCreateIn}
              renaming={renaming}
              renameDraft={renameDraft}
              onRenameDraftChange={setRenameDraft}
              onCommitRename={commitRename}
              onCancelRename={cancelRename}
              gitMap={gitMap}
            />
          ))}
        </div>
      </div>

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(o) => !o && !deleting && setPendingDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {pendingDelete?.type === "dir" ? "folder" : "file"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              <span className="block text-foreground/90 font-mono break-all">
                {pendingDelete?.path}
              </span>
              <span className="mt-2 block">
                This action cannot be undone. The{" "}
                {pendingDelete?.type === "dir"
                  ? "folder and everything inside it"
                  : "file"}{" "}
                will be removed from the workspace.
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              disabled={deleting}
              onClick={(e) => {
                e.preventDefault();
                void confirmDelete();
              }}
            >
              {deleting ? (
                <>
                  <Loader2 className="size-4 animate-spin" /> Deleting…
                </>
              ) : (
                <>
                  <Trash2 className="size-4" /> Delete
                </>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// TreeNode — recursive

interface TreeNodeProps {
  node: FileNode;
  depth: number;
  selectedPath: string | null;
  expanded: Set<string>;
  onToggleExpand: (path: string) => void;
  onSelectFile: (path: string) => void;
  onStartRename: (node: FileNode) => void;
  onDeleteRequest: (path: string, type: "file" | "dir") => void;
  onCreateIn?: (dirPath: string, type: "file" | "dir") => void;
  renaming: string | null;
  renameDraft: string;
  onRenameDraftChange: (v: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  gitMap: Map<string, GitFileStatus>;
}

function TreeNode(props: TreeNodeProps) {
  const {
    node,
    depth,
    selectedPath,
    expanded,
    onToggleExpand,
    onSelectFile,
    onStartRename,
    onDeleteRequest,
    onCreateIn,
    renaming,
    renameDraft,
    onRenameDraftChange,
    onCommitRename,
    onCancelRename,
    gitMap,
  } = props;

  const isDir = node.type === "dir";
  const isOpen = isDir && expanded.has(node.path);
  const isActive = !isDir && selectedPath === node.path;
  const isRenaming = renaming === node.path;
  const hasChildren = isDir && (node.children?.length ?? 0) > 0;

  // Resolve git status for this node
  const gitStatus = !isDir ? gitMap.get(node.path) : undefined;
  let statusColor = "";
  let statusChar = "";
  let statusBadgeColor = "";
  if (gitStatus) {
    statusChar = gitStatus;
    if (gitStatus === "A") {
      statusColor = "text-emerald-600 dark:text-emerald-400 font-medium";
      statusBadgeColor = "text-emerald-600 dark:text-emerald-400";
    } else if (gitStatus === "U" || gitStatus === "?") {
      statusChar = "U";
      statusColor = "text-sky-600 dark:text-sky-400 font-medium";
      statusBadgeColor = "text-sky-600 dark:text-sky-400";
    } else if (gitStatus === "M") {
      statusColor = "text-amber-600 dark:text-amber-400 font-medium";
      statusBadgeColor = "text-amber-600 dark:text-amber-400";
    } else if (gitStatus === "D") {
      statusColor = "text-rose-500 line-through opacity-70";
      statusBadgeColor = "text-rose-500 font-medium";
    } else if (gitStatus === "R") {
      statusColor = "text-purple-600 dark:text-purple-400 font-medium";
      statusBadgeColor = "text-purple-600 dark:text-purple-400";
    }
  }

  const handleClick = () => {
    if (isDir) onToggleExpand(node.path);
    else onSelectFile(node.path);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleClick();
    } else if (e.key === "ArrowRight" && isDir && !isOpen) {
      e.preventDefault();
      onToggleExpand(node.path);
    } else if (e.key === "ArrowLeft" && isDir && isOpen) {
      e.preventDefault();
      onToggleExpand(node.path);
    }
  };

  const padLeft = 8 + depth * 12;

  return (
    <div>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            role="treeitem"
            aria-expanded={isDir ? isOpen : undefined}
            aria-selected={isActive || undefined}
            tabIndex={0}
            onClick={handleClick}
            onKeyDown={handleKeyDown}
            className={cn(
              "group flex h-7 cursor-pointer items-center gap-1 rounded-sm pr-2 text-xs touch-manipulation",
              "outline-none focus-visible:ring-1 focus-visible:ring-ring/60",
              isActive
                ? "bg-accent text-accent-foreground"
                : "hover:bg-accent/60",
            )}
            style={{ paddingLeft: padLeft }}
            title={node.path}
          >
            {isDir ? (
              <>
                {hasChildren ? (
                  isOpen ? (
                    <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
                  )
                ) : (
                  <span className="w-3 shrink-0" />
                )}
                {isOpen ? (
                  <FolderOpen className="size-3.5 shrink-0 text-brand" />
                ) : (
                  <Folder className="size-3.5 shrink-0 text-brand" />
                )}
              </>
            ) : (
              <>
                <span className="w-3 shrink-0" />
                <FileIcon
                  name={node.name}
                  className="size-3.5 shrink-0 text-muted-foreground"
                />
              </>
            )}

            {isRenaming ? (
              <Input
                autoFocus
                value={renameDraft}
                onChange={(e) => onRenameDraftChange(e.target.value)}
                onBlur={() => void onCommitRename()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    e.stopPropagation();
                    void onCommitRename();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    onCancelRename();
                  }
                }}
                onClick={(e) => e.stopPropagation()}
                className="h-4 px-1 py-0 text-xs font-mono leading-none"
              />
            ) : (
              <span className={cn("truncate font-mono", statusColor)}>{node.name}</span>
            )}

            {!isRenaming && statusChar && (
              <span
                className={cn(
                  "ml-1.5 px-1 rounded-[3px] text-[9px] font-bold font-mono border select-none scale-90 origin-left shrink-0",
                  statusBadgeColor === "text-emerald-600 dark:text-emerald-400"
                    ? "bg-emerald-500/10 border-emerald-500/20"
                    : statusBadgeColor === "text-sky-600 dark:text-sky-400"
                    ? "bg-sky-500/10 border-sky-500/20"
                    : statusBadgeColor === "text-amber-600 dark:text-amber-400"
                    ? "bg-amber-500/10 border-amber-500/20"
                    : statusBadgeColor === "text-rose-500"
                    ? "bg-rose-500/10 border-rose-500/20"
                    : "bg-purple-500/10 border-purple-500/20",
                  statusBadgeColor
                )}
                title={
                  gitStatus === "A"
                    ? "Added"
                    : gitStatus === "M"
                    ? "Modified"
                    : gitStatus === "D"
                    ? "Deleted"
                    : gitStatus === "R"
                    ? "Renamed"
                    : "Untracked"
                }
              >
                {statusChar}
              </span>
            )}

            {!isRenaming && isDir && hasChildren && (
              <span className="ml-auto text-[10px] text-muted-foreground/70 font-mono">
                {node.children!.length}
              </span>
            )}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-44">
          <ContextMenuItem
            onSelect={() => {
              if (isDir) onToggleExpand(node.path);
              else onSelectFile(node.path);
            }}
          >
            {isDir ? (isOpen ? "Collapse" : "Expand") : "Open"}
          </ContextMenuItem>
          {isDir && onCreateIn && (
            <>
              <ContextMenuItem
                onSelect={() => onCreateIn(node.path, "file")}
              >
                <FileText className="size-3.5" /> New file
              </ContextMenuItem>
              <ContextMenuItem
                onSelect={() => onCreateIn(node.path, "dir")}
              >
                <FolderIcon className="size-3.5" /> New folder
              </ContextMenuItem>
            </>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => onStartRename(node)}>
            <Pencil className="size-3.5" /> Rename
          </ContextMenuItem>
          <ContextMenuItem
            variant="destructive"
            onSelect={() => onDeleteRequest(node.path, node.type)}
          >
            <Trash2 className="size-3.5" /> Delete
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {isDir && isOpen && hasChildren && (
        <div>
          {node.children!.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              expanded={expanded}
              onToggleExpand={onToggleExpand}
              onSelectFile={onSelectFile}
              onStartRename={onStartRename}
              onDeleteRequest={onDeleteRequest}
              onCreateIn={onCreateIn}
              renaming={renaming}
              renameDraft={renameDraft}
              onRenameDraftChange={onRenameDraftChange}
              onCommitRename={onCommitRename}
              onCancelRename={onCancelRename}
              gitMap={gitMap}
            />
          ))}
        </div>
      )}
    </div>
  );
}
