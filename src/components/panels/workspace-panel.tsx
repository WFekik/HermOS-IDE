"use client";

import * as React from "react";
import {
  useQuery,
  useMutation,
  useQueryClient,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import {
  Folder,
  FolderOpen,
  FilePlus,
  FolderPlus,
  RefreshCw,
  Loader2,
  FileText,
  Folder as FolderIcon,
  X,
  Columns2,
  Search,
  FileCode,
  Braces,
  FileImage,
  FileCog,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { FileTree } from "@/components/workspace/file-tree";
import {
  FileEditor,
  type FileRange,
  type EditorSide,
} from "@/components/workspace/file-editor";
import { OpenFolderDialog } from "@/components/workspace/open-folder-dialog";
import { CommandBar } from "@/components/workspace/command-bar";
import {
  workspaceKeys,
  fetchWorkspaceInfo,
  fetchTree,
  fetchFile,
  fetchFileRange,
  putFile,
  createFile,
  deleteFile,
  renamePath,
  openWorkspace,
  listWorkspaces,
  joinPath,
  baseName,
  type FileNode,
} from "@/components/workspace/types";
import { useAppStore } from "@/stores/app-store";
import { useIsDesktop } from "@/hooks/use-is-desktop";
import { ApiRequestError } from "@/lib/api-client";
import { subscribeWatch } from "@/lib/watch-client";
import { cn } from "@/lib/utils";
import { pickFolder } from "@/lib/tauri";

// WorkspacePanel — exported entry point.
//
// Wraps the inner panel in a local React Query provider because the global
// app providers do not include one (the orchestrator wires the panel as a
// standalone tab in the right rail). A single QueryClient is created per
// mounted panel instance.

export function WorkspacePanel() {
  const [queryClient] = React.useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            refetchOnWindowFocus: false,
            retry: 1,
            staleTime: 15_000,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <WorkspacePanelInner />
    </QueryClientProvider>
  );
}

function WorkspacePanelInner() {
  const queryClient = useQueryClient();
  const isDesktop = useIsDesktop();

  const openFiles = useAppStore((s) => s.openFiles);
  const activeFileTab = useAppStore((s) => s.activeFileTab);
  const openFileTab = useAppStore((s) => s.openFileTab);
  const closeFileTab = useAppStore((s) => s.closeFileTab);
  const setActiveFileTab = useAppStore((s) => s.setActiveFileTab);
  const closeAllFileTabs = useAppStore((s) => s.closeAllFileTabs);

  const splitEditorOpen = useAppStore((s) => s.splitEditorOpen);
  const splitEditorFile = useAppStore((s) => s.splitEditorFile);
  const splitEditorActive = useAppStore((s) => s.splitEditorActive);
  const setSplitEditorFile = useAppStore((s) => s.setSplitEditorFile);
  const setSplitEditorActive = useAppStore((s) => s.setSplitEditorActive);
  const setSplitEditorOpen = useAppStore((s) => s.setSplitEditorOpen);
  const setRightPanelTab = useAppStore((s) => s.setRightPanelTab);

  const gitStatus = useAppStore((s) => s.gitStatus);
  const refreshGitStatus = useAppStore((s) => s.refreshGitStatus);
  const refreshWorkspaces = useAppStore((s) => s.refreshWorkspaces);
  const switchWorkspace = useAppStore((s) => s.switchWorkspace);
  const activeWorkspace = useAppStore((s) => s.activeWorkspace);

  const [treeCollapsed, setTreeCollapsed] = React.useState(false);

  const workspaceQuery = useQuery({
    queryKey: workspaceKeys.info,
    queryFn: fetchWorkspaceInfo,
  });

  const treeQuery = useQuery({
    queryKey: workspaceKeys.tree,
    queryFn: fetchTree,
    enabled: !!workspaceQuery.data,
  });

  const listQuery = useQuery({
    queryKey: workspaceKeys.list,
    queryFn: listWorkspaces,
  });

  const [expanded, setExpanded] = React.useState<Set<string>>(
    () => new Set<string>(),
  );
  const [openFolderOpen, setOpenFolderOpen] = React.useState(false);
  const [createOpen, setCreateOpen] = React.useState<{
    type: "file" | "dir";
    dir: string;
  } | null>(null);

  // Handle "Open Folder" — uses native OS dialog in desktop mode
  async function handleOpenNativeFolder() {
    if (!isDesktop) {
      setOpenFolderOpen(true);
      return;
    }
    try {
      const selected = await pickFolder();
      if (selected && typeof selected === "string") {
        const res = await fetch("/api/workspace/from-folder", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: selected }),
        });
        if (res.ok) {
          const data = await res.json();
          const wsData = data.workspace ?? data;
          if (wsData?.id) {
            // switchWorkspace returns false on any non-404/405 failure —
            // sync the store's workspace list so the UI still converges.
            const switched = await switchWorkspace(wsData.id, wsData.name);
            if (!switched) void refreshWorkspaces();
          } else {
            void refreshWorkspaces();
          }
          void refreshGitStatus();
          void queryClient.invalidateQueries({ queryKey: workspaceKeys.list });
          void queryClient.invalidateQueries({ queryKey: workspaceKeys.info });
          void queryClient.invalidateQueries({ queryKey: workspaceKeys.tree });
          toast.success(`Opened: ${wsData.name ?? selected}`);
        } else {
          toast.error("Failed to open folder as workspace");
        }
      }
    } catch (err) {
      console.error("Native folder dialog error:", err);
    }
  }

  // Use the store's activeWorkspace (updated immediately on project switch)
  // as the source of truth. Falls back to the React Query result on first load.
  const ws = activeWorkspace ?? workspaceQuery.data ?? null;
  const hasWs = !!ws;

  // Auto-expand the root directory once when the tree first loads.
  const didAutoExpand = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (
      ws &&
      treeQuery.data &&
      didAutoExpand.current !== ws.id &&
      expanded.size === 0
    ) {
      didAutoExpand.current = ws.id;
      const topDirs = treeQuery.data.tree
        .filter((n) => n.type === "dir")
        .map((n) => n.path);
      if (topDirs.length > 0) {
        setExpanded(new Set(topDirs));
      }
    }
  }, [ws, treeQuery.data, expanded.size]);

  // When the workspace changes (project switch), invalidate queries so the
  // tree + file list reflect the new project immediately. The file tabs are
  // managed per-project by the store's selectProject action, so we no longer
  // clear them here (that would wipe the per-project tabs we just restored).
  React.useEffect(() => {
    setExpanded(new Set());
    didAutoExpand.current = null;
    void queryClient.invalidateQueries({ queryKey: workspaceKeys.tree });
    void queryClient.invalidateQueries({ queryKey: workspaceKeys.list });
    void queryClient.invalidateQueries({ queryKey: ["workspace", "file"] });
  }, [ws?.id, queryClient]);

  // Real-time file-watch listener (shared multiplexed SSE client — see
  // @/lib/watch-client) to synchronize the file tree & git status. Events
  // are debounced (500ms) so rapid file churn (npm install, git checkout,
  // etc.) triggers at most one refresh cycle, not hundreds per second.
  React.useEffect(() => {
    if (typeof window === "undefined" || !hasWs) return;
    if (typeof EventSource === "undefined") return;

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleRefresh = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        void queryClient.invalidateQueries({ queryKey: workspaceKeys.tree });
        void refreshGitStatus();
      }, 500);
    };

    const unsubscribe = subscribeWatch("/api/workspace/watch", () => {
      scheduleRefresh();
    });

    return () => {
      unsubscribe();
      if (debounceTimer) clearTimeout(debounceTimer);
    };
  }, [hasWs, queryClient, refreshGitStatus]);

  // Listen for `hermos:open-file` events from the command palette and the
  // find-in-files overlay. Opening a file adds it to the tab bar and
  // focuses it. When the split editor is open AND the right side is
  // active, route the file to the right side instead of the left.
  React.useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ path: string; side?: "left" | "right" }>).detail;
      if (!detail?.path) return;
      const s = useAppStore.getState();
      if (
        s.splitEditorOpen &&
        (detail.side === "right" || (detail.side === undefined && s.splitEditorActive === "right"))
      ) {
        s.setSplitEditorFile(detail.path);
      } else {
        openFileTab(detail.path);
      }
    };
    window.addEventListener("hermos:open-file", handler as EventListener);
    return () => {
      window.removeEventListener("hermos:open-file", handler as EventListener);
    };
  }, [openFileTab]);

  // Listen for `hermos:open-folder` events from the breadcrumb bar —
  // expand the clicked directory in the file tree and switch to the
  // Files tab so the user can see the expanded directory.
  React.useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail;
      if (!detail || typeof detail !== "string") return;
      setRightPanelTab("files");
      // Expand the directory itself and every ancestor so it's visible.
      setExpanded((prev) => {
        const next = new Set(prev);
        const parts = detail.split("/").filter(Boolean);
        let acc = "";
        for (const p of parts) {
          acc = acc ? `${acc}/${p}` : p;
          next.add(acc);
        }
        return next;
      });
    };
    window.addEventListener("hermos:open-folder", handler as EventListener);
    return () => {
      window.removeEventListener("hermos:open-folder", handler as EventListener);
    };
  }, [setRightPanelTab]);

  // Consume the store's `openFolderDialogRequested` flag. The
  // ProjectSelector sets this flag. When this panel mounts
  // (after the tab switch + animation), the flag is still true.
  // In desktop mode, open the native OS folder picker directly.
  // In web mode, open the web-based dialog.
  const openFolderDialogRequested = useAppStore(
    (s) => s.openFolderDialogRequested,
  );
  const clearOpenFolderDialogRequest = useAppStore(
    (s) => s.clearOpenFolderDialogRequest,
  );
  React.useEffect(() => {
    if (openFolderDialogRequested) {
      if (isDesktop) {
        void handleOpenNativeFolder();
      } else {
        setOpenFolderOpen(true);
      }
      clearOpenFolderDialogRequest();
    }
  }, [openFolderDialogRequested, clearOpenFolderDialogRequest, isDesktop]);

  const openMut = useMutation({
    mutationFn: (name: string) => openWorkspace(name),
    onSuccess: (info) => {
      toast.success(`Folder "${info.name}" opened`);
      void queryClient.invalidateQueries({ queryKey: workspaceKeys.all });
      // Switch workspace and update selectedProjectId + active conversation.
      if (info?.id) {
        void useAppStore.getState().switchWorkspace(info.id, info.name).then((ok) => {
          // switchWorkspace returns false on any non-404/405 failure —
          // sync the store's workspace list so the UI still converges.
          if (!ok) void useAppStore.getState().refreshWorkspaces();
        });
      } else {
        void useAppStore.getState().refreshWorkspaces();
      }
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : "Failed to open folder");
    },
  });

  const saveMut = useMutation({
    mutationFn: ({ path, content }: { path: string; content: string }) =>
      putFile(path, content),
    onSuccess: (_data, vars) => {
      toast.success("File saved");
      void queryClient.invalidateQueries({
        queryKey: workspaceKeys.file(vars.path),
      });
      void queryClient.invalidateQueries({ queryKey: workspaceKeys.tree });
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : "Save failed");
    },
  });

  const createMut = useMutation({
    mutationFn: ({
      path,
      type,
      content,
    }: {
      path: string;
      type: "file" | "dir";
      content?: string;
    }) => createFile(path, type, content),
    onSuccess: (_data, vars) => {
      toast.success(
        vars.type === "dir" ? "Folder created" : "File created",
      );
      // Reveal parent dir in the tree and select the new file.
      const parent = vars.path.split("/").slice(0, -1).join("/");
      if (parent) {
        setExpanded((prev) => {
          const next = new Set(prev);
          next.add(parent);
          return next;
        });
      }
      if (vars.type === "file") openFileTab(vars.path);
      void queryClient.invalidateQueries({ queryKey: workspaceKeys.tree });
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : "Create failed");
    },
  });

  const deleteMut = useMutation({
    mutationFn: (path: string) => deleteFile(path),
    onSuccess: (_data, path) => {
      toast.success("Deleted");
      if (useAppStore.getState().openFiles.includes(path)) {
        closeFileTab(path);
      }
      void queryClient.invalidateQueries({ queryKey: workspaceKeys.tree });
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : "Delete failed");
    },
  });

  const renameMut = useMutation({
    mutationFn: ({ from, to }: { from: string; to: string }) =>
      renamePath(from, to),
    onSuccess: (_data, vars) => {
      toast.success("Renamed");
      // If the renamed file was open as a tab, swap the path in the tab
      // bar. The simplest correct behaviour is to close the old tab and
      // open the new one (preserving order is non-trivial with the
      // store-backed list, so we just append).
      const state = useAppStore.getState();
      if (state.openFiles.includes(vars.from)) {
        closeFileTab(vars.from);
        openFileTab(vars.to);
      }
      void queryClient.invalidateQueries({ queryKey: workspaceKeys.tree });
      void queryClient.invalidateQueries({
        queryKey: workspaceKeys.file(vars.from),
      });
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : "Rename failed");
    },
  });

  const toggleExpand = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const handleSelectFile = (path: string) => {
    // When the split editor is open AND the right side is active, route
    // the file to the right pane instead of the left. This mirrors
    // VS Code's "click opens in the focused editor group" behaviour.
    if (splitEditorOpen && splitEditorActive === "right") {
      setSplitEditorFile(path);
      return;
    }
    openFileTab(path);
  };

  // Clicking a tab in the file-tab bar:
  // - If the tab is currently the right-side file: focus the right pane.
  // - Else if the tab is currently the active (left) file: focus the left pane.
  // - Else: open it on whichever pane is currently active (left or right).
  // This makes the tab bar useful in split mode (you can swap either side
  // by clicking a tab while that side is focused) without forcing a
  // specific drag-and-drop gesture.
  const handleTabSelect = (path: string) => {
    if (!splitEditorOpen) {
      setActiveFileTab(path);
      return;
    }
    if (path === splitEditorFile) {
      setSplitEditorActive("right");
      return;
    }
    if (path === activeFileTab) {
      setSplitEditorActive("left");
      return;
    }
    // Not currently shown on either side — open on the focused side.
    if (splitEditorActive === "right") {
      setSplitEditorFile(path);
    } else {
      setActiveFileTab(path);
    }
  };

  const handleSave = async (path: string, content: string) => {
    await saveMut.mutateAsync({ path, content });
  };

  const handleDelete = async (path: string) => {
    await deleteMut.mutateAsync(path);
  };

  const handleRename = async (from: string, to: string) => {
    await renameMut.mutateAsync({ from, to });
  };

  const handleCreateIn = (dirPath: string, type: "file" | "dir") => {
    setCreateOpen({ type, dir: dirPath });
  };

  const handleHeaderNew = (type: "file" | "dir") => {
    setCreateOpen({ type, dir: "" });
  };

  const refreshAll = () => {
    void queryClient.invalidateQueries({ queryKey: workspaceKeys.all });
  };

  const onResult = (result: {
    blocked?: boolean;
    reason?: string;
    exitCode: number;
  }) => {
    if (result.blocked) {
      toast.warning(
        `Blocked: ${result.reason ?? "command not allowed"}`,
      );
    }
  };

  const treeData = treeQuery.data?.tree ?? [];
  const wsName = ws?.name ?? null;

  // Render
  return (
    <div className="flex h-full flex-col bg-card">
      <div className="flex h-9 shrink-0 items-center justify-between border-b px-3">
        <div className="flex min-w-0 items-center gap-1.5">
          <Folder className="size-3.5 shrink-0 text-brand" />
          <span
            className="truncate text-xs font-medium min-w-0"
            title={wsName ?? undefined}
          >
            {wsName ?? "No folder open"}
          </span>
          {treeQuery.data && (
            <Badge
              variant="outline"
              className="ml-0.5 h-4 px-1 text-[9px] font-mono text-muted-foreground shrink-0"
            >
              {countNodes(treeData)} files
            </Badge>
          )}
          {treeQuery.isFetching && !treeQuery.isLoading && (
            <Loader2 className="size-3 animate-spin text-muted-foreground shrink-0" />
          )}
        </div>
        <div className="flex shrink-0 items-center gap-0.5 ml-1">
          <HeaderIconButton
            label="New file"
            onClick={() => handleHeaderNew("file")}
            disabled={!hasWs}
          >
            <FilePlus className="size-3.5" />
          </HeaderIconButton>
          <HeaderIconButton
            label="New folder"
            onClick={() => handleHeaderNew("dir")}
            disabled={!hasWs}
          >
            <FolderPlus className="size-3.5" />
          </HeaderIconButton>
          <HeaderIconButton
            label="Refresh"
            onClick={refreshAll}
            disabled={!hasWs}
          >
            <RefreshCw
              className={cnIcon(treeQuery.isFetching || workspaceQuery.isFetching)}
            />
          </HeaderIconButton>
          <HeaderIconButton
            label={treeCollapsed ? "Show file tree" : "Hide file tree"}
            onClick={() => setTreeCollapsed((v) => !v)}
            disabled={!hasWs}
          >
            {treeCollapsed ? (
              <PanelLeftOpen className="size-3.5" />
            ) : (
              <PanelLeftClose className="size-3.5" />
            )}
          </HeaderIconButton>
        </div>
      </div>

      {!hasWs && !workspaceQuery.isLoading ? (
        <NoWorkspace onOpen={handleOpenNativeFolder} />
      ) : (
        <div className="min-h-0 flex-1">
          <ResizablePanelGroup direction="horizontal" autoSaveId="hermos-ws-split">
            {!treeCollapsed && (
              <>
                <ResizablePanel
                  id="ws-tree"
                  order={1}
                  defaultSize={38}
                  minSize={20}
                  maxSize={60}
                  className="min-w-[140px]"
                >
                  <FileTree
                    tree={treeData}
                    selectedPath={activeFileTab}
                    expanded={expanded}
                    onToggleExpand={toggleExpand}
                    onSelectFile={handleSelectFile}
                    onRename={handleRename}
                    onDelete={handleDelete}
                    onCreateIn={handleCreateIn}
                    gitStatus={gitStatus}
                    loading={treeQuery.isLoading}
                    error={
                      treeQuery.error instanceof ApiRequestError
                        ? treeQuery.error
                        : treeQuery.error
                        ? toError(treeQuery.error)
                        : null
                    }
                    onRetry={() => void treeQuery.refetch()}
                  />
                </ResizablePanel>
                <ResizableHandle withHandle />
              </>
            )}
            <ResizablePanel id="ws-editor" order={2} defaultSize={treeCollapsed ? 100 : 62} minSize={30} className="min-w-[200px]">
              <div className="flex h-full flex-col">
                {openFiles.length > 0 && (
                  <FileTabBar
                    openFiles={openFiles}
                    activeFileTab={activeFileTab}
                    onSelect={(p) => handleTabSelect(p)}
                    onClose={closeFileTab}
                    splitEditorOpen={splitEditorOpen}
                    splitEditorFile={splitEditorFile}
                    splitEditorActive={splitEditorActive}
                  />
                )}
                <div className="min-h-0 flex-1">
                  {splitEditorOpen ? (
                    <SplitEditorContainer
                      leftPath={activeFileTab}
                      rightPath={splitEditorFile}
                      splitEditorActive={splitEditorActive}
                      onSave={handleSave}
                      onPickRightFile={(p) => setSplitEditorFile(p)}
                      onCloseSplit={() => setSplitEditorOpen(false)}
                      onActivateLeft={() => setSplitEditorActive("left")}
                      onActivateRight={() => setSplitEditorActive("right")}
                      treeData={treeData}
                    />
                  ) : (
                    <FileEditorContainer
                      path={activeFileTab}
                      onSave={handleSave}
                      side="left"
                      isActive
                      onFocusSide={() => setSplitEditorActive("left")}
                    />
                  )}
                </div>
              </div>
            </ResizablePanel>
          </ResizablePanelGroup>
        </div>
      )}

      <CommandBar
        disabled={!hasWs}
        disabledReason="Open a folder to run commands"
        cwdLabel={wsName ?? undefined}
        onResult={onResult}
      />

      <OpenFolderDialog
        open={openFolderOpen}
        onOpenChange={setOpenFolderOpen}
        workspaces={listQuery.data ?? []}
        listLoading={listQuery.isLoading}
        activeName={wsName}
        onOpen={async (name) => {
          await openMut.mutateAsync(name);
        }}
      />

      <CreateNodeDialog
        open={createOpen !== null}
        onOpenChange={(o) => !o && setCreateOpen(null)}
        type={createOpen?.type ?? "file"}
        dir={createOpen?.dir ?? ""}
        onSubmit={async (name) => {
          if (!createOpen) return;
          const path = joinPath(createOpen.dir, name);
          await createMut.mutateAsync({
            path,
            type: createOpen.type,
            content: createOpen.type === "file" ? "" : undefined,
          });
          setCreateOpen(null);
        }}
        submitting={createMut.isPending}
      />
    </div>
  );
}

// File editor container — owns the per-path file-content query and the
// range state (for lazy-loading large files). Switches between the default
// read (which the backend may truncate) and an explicit line-range read.

function FileEditorContainer({
  path,
  onSave,
  side = "left",
  isActive = true,
  onFocusSide,
  onCloseSplit,
}: {
  path: string | null;
  onSave: (path: string, content: string) => Promise<void>;
  side?: EditorSide;
  isActive?: boolean;
  onFocusSide?: () => void;
  onCloseSplit?: () => void;
}) {
  const queryClient = useQueryClient();
  // Range state: null = default read (returns the full file). When set, the
  // backend returns the explicit [start, end] range (capped at MAX_RANGE).
  const [range, setRange] = React.useState<FileRange | null>(null);

  // Reset range whenever the open file changes — each file starts at the
  // default full-file read.
  React.useEffect(() => {
    setRange(null);
  }, [path]);

  const queryKey = React.useMemo(() => {
    if (!path) return ["workspace", "file", "__none__"] as const;
    if (range) return workspaceKeys.fileRange(path, range.start, range.end);
    return workspaceKeys.file(path);
  }, [path, range]);

  const fileQuery = useQuery({
    queryKey,
    queryFn: () => {
      if (!path) throw new Error("No path");
      if (range) return fetchFileRange(path, range.start, range.end);
      return fetchFile(path);
    },
    enabled: !!path,
  });

  const handleLoadFull = React.useCallback(() => {
    // Load the whole file by requesting range [1, totalLines]. The backend
    // caps `?start=&end=` reads at MAX_RANGE (1000) per request, so very
    // large files will still be paged via go-to-line.
    const total = fileQuery.data?.totalLines ?? 0;
    if (total > 0) {
      setRange({ start: 1, end: total });
    } else {
      // totalLines unknown yet — request a generous range and let the
      // backend clamp it.
      setRange({ start: 1, end: 100_000 });
    }
  }, [fileQuery.data?.totalLines]);

  const handleLoadRange = React.useCallback((start: number, end: number) => {
    setRange({ start, end });
  }, []);

  const handleLoadDefault = React.useCallback(() => {
    setRange(null);
  }, []);

  const handleRetry = React.useCallback(() => {
    if (path) void queryClient.invalidateQueries({ queryKey });
  }, [path, queryClient, queryKey]);

  const handleExternalChange = React.useCallback(() => {
    if (path) {
      void queryClient.invalidateQueries({ queryKey: workspaceKeys.file(path) });
      void queryClient.invalidateQueries({
        queryKey: workspaceKeys.fileRange(path, range?.start ?? 1, range?.end ?? 0),
      });
    }
  }, [path, queryClient, range?.start, range?.end]);

  return (
    <FileEditor
      path={path}
      file={fileQuery.data}
      loading={fileQuery.isLoading && !!path}
      error={
        fileQuery.error instanceof ApiRequestError
          ? fileQuery.error
          : fileQuery.error
          ? toError(fileQuery.error)
          : null
      }
      range={range}
      onSave={onSave}
      onRetry={handleRetry}
      onLoadFull={handleLoadFull}
      onLoadRange={handleLoadRange}
      onLoadDefault={handleLoadDefault}
      side={side}
      isActive={isActive}
      onFocusSide={onFocusSide}
      onCloseSplit={onCloseSplit}
      onExternalChange={handleExternalChange}
    />
  );
}

// SplitEditorContainer — renders two FileEditorContainer instances side by
// side inside a resizable PanelGroup. The left side always shows the
// active file tab; the right side shows `splitEditorFile` (or an empty
// state with a file picker when splitEditorFile is null).
//
// Each side gets its own FileEditorContainer so the two files have
// independent file-content queries, range state, edit state, and
// scroll position. The `splitEditorActive` prop drives which side is
// marked `isActive` (so global keyboard shortcuts like ⌘L only open
// the go-to-line dialog on the focused side).

function SplitEditorContainer({
  leftPath,
  rightPath,
  splitEditorActive,
  onSave,
  onPickRightFile,
  onCloseSplit,
  onActivateLeft,
  onActivateRight,
  treeData,
}: {
  leftPath: string | null;
  rightPath: string | null;
  splitEditorActive: "left" | "right";
  onSave: (path: string, content: string) => Promise<void>;
  onPickRightFile: (path: string) => void;
  onCloseSplit: () => void;
  onActivateLeft: () => void;
  onActivateRight: () => void;
  treeData: FileNode[];
}) {
  const [pickerOpen, setPickerOpen] = React.useState(false);

  // If the right pane has no file, show the empty state with a "Pick file"
  // button. The button opens a small file-picker dialog (filterable list
  // of every file in the workspace tree).
  if (!rightPath) {
    return (
      <>
        <ResizablePanelGroup direction="horizontal" autoSaveId="hermos-ws-split-editor">
          <ResizablePanel id="split-left" order={1} defaultSize={50} minSize={25} className="min-w-[180px]">
            <FileEditorContainer
              path={leftPath}
              onSave={onSave}
              side="left"
              isActive={splitEditorActive === "left"}
              onFocusSide={onActivateLeft}
            />
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel id="split-right" order={2} defaultSize={50} minSize={25} className="min-w-[180px]">
            <div
              className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center"
              onMouseDown={onActivateRight}
              onFocus={onActivateRight}
            >
              <Columns2 className="size-7 text-muted-foreground/40" />
              <p className="text-xs text-muted-foreground">
                No file on the right side
              </p>
              <p className="text-[11px] text-muted-foreground/70">
                Pick a file to compare or refer to side by side.
              </p>
              <Button
                size="sm"
                variant="outline"
                className="mt-1 gap-1"
                onClick={() => {
                  onActivateRight();
                  setPickerOpen(true);
                }}
              >
                <Search className="size-3.5" /> Pick file
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="mt-1 h-7 gap-1 text-[11px] text-muted-foreground"
                onClick={onCloseSplit}
              >
                <X className="size-3" /> Close split
              </Button>
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
        <SplitFilePicker
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          treeData={treeData}
          onPick={(p) => {
            onPickRightFile(p);
            setPickerOpen(false);
          }}
        />
      </>
    );
  }

  return (
    <ResizablePanelGroup direction="horizontal" autoSaveId="hermos-ws-split-editor">
      <ResizablePanel id="split-left" order={1} defaultSize={50} minSize={25} className="min-w-[180px]">
        <FileEditorContainer
          path={leftPath}
          onSave={onSave}
          side="left"
          isActive={splitEditorActive === "left"}
          onFocusSide={onActivateLeft}
        />
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel id="split-right" order={2} defaultSize={50} minSize={25} className="min-w-[180px]">
        <FileEditorContainer
          path={rightPath}
          onSave={onSave}
          side="right"
          isActive={splitEditorActive === "right"}
          onFocusSide={onActivateRight}
          onCloseSplit={onCloseSplit}
        />
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

// SplitFilePicker — a small dialog with a filterable list of every file in
// the workspace tree. Used to pick the right-side file when the split
// editor opens with splitEditorFile === null.

function SplitFilePicker({
  open,
  onOpenChange,
  treeData,
  onPick,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  treeData: FileNode[];
  onPick: (path: string) => void;
}) {
  const [query, setQuery] = React.useState("");
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  const allFiles = React.useMemo(() => flattenFiles(treeData), [treeData]);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allFiles.slice(0, 100);
    return allFiles
      .filter((f) => f.path.toLowerCase().includes(q) || f.name.toLowerCase().includes(q))
      .slice(0, 100);
  }, [allFiles, query]);

  React.useEffect(() => {
    if (open) {
      setQuery("");
      const t = setTimeout(() => inputRef.current?.focus(), 60);
      return () => clearTimeout(t);
    }
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md p-0 gap-0 overflow-hidden">
        <DialogHeader className="px-4 py-3 border-b">
          <DialogTitle className="text-sm font-semibold flex items-center gap-2">
            <Columns2 className="size-4 text-brand" />
            Pick a file for the right side
          </DialogTitle>
          <DialogDescription className="text-xs">
            Choose a file to display alongside the current editor.
          </DialogDescription>
        </DialogHeader>
        <div className="border-b p-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter files by name or path…"
              className="h-8 pl-7 text-xs"
              spellCheck={false}
              autoComplete="off"
            />
          </div>
        </div>
        <ScrollArea className="max-h-[320px]">
          {filtered.length === 0 ? (
            <div className="p-6 text-center text-xs text-muted-foreground">
              No matching files.
            </div>
          ) : (
            <ul className="py-1">
              {filtered.map((f) => (
                <li key={f.path}>
                  <button
                    type="button"
                    onClick={() => onPick(f.path)}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-accent transition-colors"
                  >
                    <PickerFileIcon name={f.name} />
                    <span className="truncate font-mono">{f.name}</span>
                    <span className="ml-auto truncate text-[10px] text-muted-foreground/80">
                      {f.path}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}

function flattenFiles(nodes: FileNode[], acc: { path: string; name: string }[] = []) {
  for (const n of nodes) {
    if (n.type === "file") {
      acc.push({ path: n.path, name: n.name });
    } else if (n.type === "dir" && n.children) {
      flattenFiles(n.children, acc);
    }
  }
  return acc;
}

function PickerFileIcon({ name }: { name: string }) {
  const lower = name.toLowerCase();
  if (
    lower.endsWith(".ts") ||
    lower.endsWith(".tsx") ||
    lower.endsWith(".js") ||
    lower.endsWith(".jsx") ||
    lower.endsWith(".mjs") ||
    lower.endsWith(".cjs") ||
    lower === "package.json"
  ) {
    return <FileCode className="size-3.5 shrink-0 text-brand" />;
  }
  if (lower.endsWith(".json")) return <Braces className="size-3.5 shrink-0 text-muted-foreground" />;
  if (
    lower.endsWith(".png") ||
    lower.endsWith(".jpg") ||
    lower.endsWith(".jpeg") ||
    lower.endsWith(".gif") ||
    lower.endsWith(".svg") ||
    lower.endsWith(".webp")
  ) {
    return <FileImage className="size-3.5 shrink-0 text-muted-foreground" />;
  }
  if (
    lower === "dockerfile" ||
    lower.endsWith(".env") ||
    lower.endsWith(".toml") ||
    lower.endsWith(".ini") ||
    lower.endsWith(".config.js")
  ) {
    return <FileCog className="size-3.5 shrink-0 text-muted-foreground" />;
  }
  return <FileText className="size-3.5 shrink-0 text-muted-foreground" />;
}

// File tab bar — VS Code-style row of open-file tabs above the editor.
//
// When the split editor is open, each tab shows an "L" or "R" badge
// indicating which side it's currently on (the active left file or the
// right split file). Other open tabs (not currently shown on either side)
// render without a badge.

function FileTabBar({
  openFiles,
  activeFileTab,
  onSelect,
  onClose,
  splitEditorOpen,
  splitEditorFile,
  splitEditorActive,
}: {
  openFiles: string[];
  activeFileTab: string | null;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
  splitEditorOpen: boolean;
  splitEditorFile: string | null;
  splitEditorActive: "left" | "right";
}) {
  return (
    <div
      className="flex h-9 shrink-0 items-stretch border-b bg-muted/20 overflow-x-auto hermos-tabs-scroll"
      role="tablist"
      aria-label="Open files"
    >
      {openFiles.map((p) => {
        const isActive = p === activeFileTab;
        // In split mode, both the active (left) file and the right-side
        // file are "shown" simultaneously — both tabs get the active look.
        const isRight = splitEditorOpen && p === splitEditorFile;
        const isLeft = splitEditorOpen && p === activeFileTab;
        // Only one side is "focused" at a time — that tab gets an extra
        // inset ring so the user can see which side keyboard shortcuts
        // (like ⌘L go-to-line) will target.
        const isFocused =
          splitEditorOpen &&
          ((splitEditorActive === "left" && isLeft) ||
            (splitEditorActive === "right" && isRight));
        const name = baseName(p);
        return (
          <div
            key={p}
            role="tab"
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            onClick={() => onSelect(p)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect(p);
              }
            }}
            title={p}
            className={cnTab(isActive || isRight, isFocused)}
          >
            {splitEditorOpen && (isLeft || isRight) && (
              <Badge
                variant="outline"
                className={cn(
                  "h-3.5 shrink-0 px-1 text-[8px] font-mono uppercase leading-none",
                  isLeft
                    ? "border-brand/40 bg-brand/10 text-brand"
                    : "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
                )}
                aria-label={isLeft ? "Left side" : "Right side"}
              >
                {isLeft ? "L" : "R"}
              </Badge>
            )}
            <span className="truncate font-mono text-xs">{name}</span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onClose(p);
              }}
              className="ml-1 inline-flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground/70 hover:bg-accent hover:text-foreground"
              aria-label={`Close ${name}`}
            >
              <X className="size-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

function cnTab(isActive: boolean, focused = false): string {
  const base =
    "group flex h-9 shrink-0 items-center gap-1.5 border-r border-border/60 px-3 cursor-pointer transition-colors max-w-[16rem]";
  if (isActive) {
    return cn(
      base,
      "bg-card text-foreground border-b-2 border-b-brand -mb-px",
      focused && "ring-1 ring-inset ring-brand/30",
    );
  }
  return cn(
    base,
    "bg-transparent text-muted-foreground hover:bg-accent/40 hover:text-foreground",
  );
}

// Empty state — no workspace open

function NoWorkspace({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
      <div className="text-center">
        <FolderOpen className="mx-auto size-9 text-muted-foreground/40" />
        <p className="mt-2 text-sm font-medium">No folder open</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Open a workspace folder to browse, edit, and run files.
        </p>
        <Button
          size="sm"
          variant="outline"
          className="mt-3 gap-1"
          onClick={onOpen}
        >
          <FolderOpen className="size-3.5" /> Open folder
        </Button>
      </div>
    </div>
  );
}

// Create node dialog (New file / New folder)

function CreateNodeDialog({
  open,
  onOpenChange,
  type,
  dir,
  onSubmit,
  submitting,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  type: "file" | "dir";
  dir: string;
  onSubmit: (name: string) => Promise<void>;
  submitting: boolean;
}) {
  const [name, setName] = React.useState("");
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    if (open) {
      setName("");
      const t = setTimeout(() => inputRef.current?.focus(), 60);
      return () => clearTimeout(t);
    }
  }, [open]);

  const title = type === "dir" ? "New folder" : "New file";
  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    await onSubmit(trimmed);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !submitting && onOpenChange(o)}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {dir
              ? `Create inside ${dir}/`
              : "Create at the workspace root."}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5">
          <Label htmlFor="create-name">Name</Label>
          <Input
            id="create-name"
            ref={inputRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void submit();
              }
            }}
            placeholder={type === "dir" ? "components" : "index.ts"}
            disabled={submitting}
            spellCheck={false}
            autoComplete="off"
          />
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={submitting || !name.trim()}
            className="gap-1 bg-brand text-brand-foreground hover:bg-brand/90"
          >
            {submitting ? (
              <Loader2 className="size-4 animate-spin" />
            ) : type === "dir" ? (
              <FolderIcon className="size-4" />
            ) : (
              <FileText className="size-4" />
            )}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Small helpers

function HeaderIconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          className="size-7 p-0"
          onClick={onClick}
          disabled={disabled}
          aria-label={label}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

function countNodes(nodes: FileNode[]): number {
  let n = 0;
  for (const node of nodes) {
    if (node.type === "file") n += 1;
    if (node.children) n += countNodes(node.children);
  }
  return n;
}

function toError(e: unknown): Error {
  if (e instanceof Error) return e;
  return new Error(String(e));
}

function cnIcon(spinning: boolean): string {
  return spinning ? "size-3.5 animate-spin" : "size-3.5";
}
