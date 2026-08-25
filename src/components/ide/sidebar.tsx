"use client";

import * as React from "react";
import {
  Plus,
  Search,
  Pin,
  Trash2,
  Pencil,
  MessageSquare,
  Folder,
  Settings,
  X,
  SearchX,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
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
import { ProjectSelector } from "@/components/ide/project-selector";
import { useAppStore } from "@/stores/app-store";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { ConversationDTO } from "@/lib/types";

interface SidebarProps {
  onNavigate?: () => void;
  onOpenSettings?: () => void;
  onOpenCommand?: () => void;
}

export function Sidebar({ onNavigate, onOpenSettings, onOpenCommand }: SidebarProps) {
  const conversations = useAppStore((s) => s.conversations);
  const pendingConversations = useAppStore((s) => s.pendingConversations);
  const activeConversationId = useAppStore((s) => s.activeConversationId);
  const selectConversation = useAppStore((s) => s.selectConversation);
  const createConversation = useAppStore((s) => s.createConversation);
  const deleteConversation = useAppStore((s) => s.deleteConversation);
  const togglePin = useAppStore((s) => s.togglePin);
  const renameConversation = useAppStore((s) => s.renameConversation);
  const loading = useAppStore((s) => s.loadingConversations);
  const searchConversations = useAppStore((s) => s.searchConversations);
  const streamingStateByConversation = useAppStore((s) => s.streamingStateByConversation);
  const workspaces = useAppStore((s) => s.workspaces);
  const selectedProjectId = useAppStore((s) => s.selectedProjectId);
  const collapsedProjects = useAppStore((s) => s.collapsedProjects);
  const selectProject = useAppStore((s) => s.selectProject);
  const toggleProjectCollapse = useAppStore((s) => s.toggleProjectCollapse);
  const renameWorkspace = useAppStore((s) => s.renameWorkspace);
  const deleteWorkspace = useAppStore((s) => s.deleteWorkspace);

  const [query, setQuery] = React.useState("");
  const [debouncedQuery, setDebouncedQuery] = React.useState("");
  const [serverResults, setServerResults] = React.useState<ConversationDTO[] | null>(null);
  const [deleteId, setDeleteId] = React.useState<string | null>(null);

  // Project rename state
  const [renamingProjectId, setRenamingProjectId] = React.useState<string | null>(null);
  const [renameDraft, setRenameDraft] = React.useState("");
  const renameInputRef = React.useRef<HTMLInputElement | null>(null);

  // Project close confirmation
  const [confirmDeleteId, setConfirmCloseId] = React.useState<string | null>(null);

  const startRename = React.useCallback((ws: { id: string; name: string }) => {
    setRenamingProjectId(ws.id);
    setRenameDraft(ws.name);
    // Focus the input after render.
    requestAnimationFrame(() => renameInputRef.current?.focus());
  }, []);

  const commitRename = React.useCallback(async (workspaceId: string) => {
    const next = renameDraft.trim();
    if (!next || next.length > 64) {
      toast.error("Name must be 1–64 characters");
      cancelRename();
      return;
    }
    if (renamingProjectId !== workspaceId) return;
    const ok = await renameWorkspace(workspaceId, next);
    if (ok) {
      toast.success("Project renamed");
    } else {
      toast.error("Failed to rename project");
    }
    setRenamingProjectId(null);
  }, [renameDraft, renamingProjectId, renameWorkspace]);

  const cancelRename = React.useCallback(() => {
    setRenamingProjectId(null);
    setRenameDraft("");
  }, []);

  const handleDeleteProject = React.useCallback(async (workspaceId: string) => {
    const ok = await deleteWorkspace(workspaceId);
    setConfirmCloseId(null);
    if (ok) {
      toast.success("Project closed");
    } else {
      toast.error("Failed to close project");
    }
  }, [deleteWorkspace]);

  React.useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 250);
    return () => clearTimeout(t);
  }, [query]);

  React.useEffect(() => {
    const q = debouncedQuery.trim();
    if (q.length < 3) {
      setServerResults(null);
      return;
    }
    let cancelled = false;
    searchConversations(q)
      .then((results) => {
        if (cancelled) return;
        setServerResults(results);
      })
      .catch(() => {
        if (cancelled) return;
        setServerResults(null);
      });
    return () => { cancelled = true; };
  }, [debouncedQuery, searchConversations]);

  const filtered = React.useMemo(() => {
    const all = [...conversations, ...pendingConversations] as ConversationDTO[];
    const sorted = [...all].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });
    const q = debouncedQuery.trim().toLowerCase();
    if (!q) return sorted;
    if (serverResults) {
      const ids = new Set(serverResults.map((c) => c.id));
      // Pending conversations have no server counterpart; include them if their title matches.
      const pendingMatches = sorted.filter(
        (c) => c.id.startsWith("pending-") && c.title.toLowerCase().includes(q),
      );
      const serverFiltered = sorted.filter((c) => ids.has(c.id));
      const merged = [...serverFiltered];
      for (const p of pendingMatches) {
        if (!merged.some((m) => m.id === p.id)) merged.push(p);
      }
      return merged;
    }
    return sorted.filter((c) => c.title.toLowerCase().includes(q));
  }, [conversations, pendingConversations, debouncedQuery, serverResults]);

  const clearSearch = React.useCallback(() => {
    setQuery("");
    setDebouncedQuery("");
    setServerResults(null);
  }, []);

  const onNew = async (workspaceId?: string) => {
    try {
      await createConversation(workspaceId ? { workspaceId } : undefined);
      toast.success("New conversation");
      onNavigate?.();
    } catch {
      toast.error("Failed to create conversation");
    }
  };

  const isSearching = debouncedQuery.trim().length > 0;

  // Build project groups from ALL workspaces, attaching any matching conversations.
  const projectsWithConversations = React.useMemo(() => {
    const convByWs = new Map<string, ConversationDTO[]>();
    for (const c of filtered) {
      if (c.workspaceId) {
        let arr = convByWs.get(c.workspaceId);
        if (!arr) { arr = []; convByWs.set(c.workspaceId, arr); }
        arr.push(c);
      }
    }
    const grouped = workspaces.map((w) => ({
      workspace: w,
      conversations: convByWs.get(w.id) ?? [],
    }));
    return { grouped };
  }, [filtered, workspaces]);

  // Always show all projects — selecting a project only highlights it,
  // never hides the others.
  const visible = projectsWithConversations;

  return (
    <aside className="relative flex h-full w-full min-w-0 flex-col bg-sidebar text-sidebar-foreground overflow-hidden">
      <Button
        variant="ghost"
        size="sm"
        className="md:hidden absolute right-2 top-2 z-10 size-7 p-0"
        aria-label="Close sidebar"
        onClick={onNavigate}
      >
        <X className="size-4" />
      </Button>

      {/* Top Header with project selector */}
      <div className="flex items-center px-3 pt-3 pb-1 pr-10 md:pr-3">
        <ProjectSelector className="flex-1 min-w-0" createOnSwitch={false} />
      </div>

      <div className="px-3 py-1.5">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3 text-muted-foreground pointer-events-none" />
          <Input
            placeholder="Search conversations…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && query) {
                e.preventDefault();
                clearSearch();
              }
            }}
            className="h-7.5 pl-7.5 pr-7 text-xs bg-sidebar-accent/30 border-sidebar-border/50 rounded-lg focus-visible:ring-1"
            aria-label="Search conversations"
          />
          {query && (
            <Button
              variant="ghost"
              size="sm"
              aria-label="Clear search"
              onClick={clearSearch}
              className="absolute right-1 top-1/2 -translate-y-1/2 size-5 p-0 text-muted-foreground hover:text-foreground"
            >
              <X className="size-3" />
            </Button>
          )}
        </div>
      </div>

      <ScrollArea className="flex-1 min-h-0">
        <div className="px-2 py-1 space-y-2">
          {loading && filtered.length === 0 ? (
            <div className="space-y-1.5 px-1 pt-1">
              {[...Array(4)].map((_, i) => (
                <div key={i} className="h-7 rounded-lg bg-accent/40 animate-pulse" />
              ))}
            </div>
          ) : (
            <>
              {visible.grouped.map(({ workspace, conversations: convs }) => {
                const isSelected = selectedProjectId === workspace.id;
                const isCollapsed = collapsedProjects.includes(workspace.id);
                const isRenaming = renamingProjectId === workspace.id;
                return (
                  <div key={workspace.id} className="space-y-0.5">
                    {/* Project header */}
                    <div
                      className={cn(
                        "group flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs cursor-pointer transition-colors",
                        isSelected
                          ? "bg-sidebar-accent/70 text-foreground font-medium"
                          : "text-muted-foreground hover:bg-sidebar-accent/40 hover:text-foreground",
                      )}
                      onClick={() => {
                        if (!isRenaming) selectProject(isSelected ? null : workspace.id);
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setConfirmCloseId(workspace.id);
                      }}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          selectProject(isSelected ? null : workspace.id);
                        }
                      }}
                    >
                      <button
                        type="button"
                        className="size-4 p-0 shrink-0 flex items-center justify-center text-muted-foreground hover:text-foreground rounded"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleProjectCollapse(workspace.id);
                        }}
                        aria-label={isCollapsed ? "Expand project" : "Collapse project"}
                      >
                        {isCollapsed ? (
                          <ChevronRight className="size-3" />
                        ) : (
                          <ChevronDown className="size-3" />
                        )}
                      </button>
                      <Folder className="size-3.5 shrink-0 text-muted-foreground group-hover:text-foreground transition-colors" />
                      {isRenaming ? (
                        <Input
                          ref={renameInputRef}
                          value={renameDraft}
                          onChange={(e) => setRenameDraft(e.target.value)}
                          onBlur={() => void commitRename(workspace.id)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") { e.preventDefault(); void commitRename(workspace.id); }
                            if (e.key === "Escape") { e.preventDefault(); cancelRename(); }
                          }}
                          onClick={(e) => e.stopPropagation()}
                          maxLength={64}
                          className="h-6 text-xs font-medium px-1.5 py-0 flex-1 min-w-0"
                        />
                      ) : (
                        <span className="truncate font-medium flex-1 min-w-0 text-foreground/90" title={workspace.name}>
                          {workspace.name}
                        </span>
                      )}

                      <div className="ml-auto flex items-center gap-0.5 shrink-0">
                        {convs.length > 0 && !isCollapsed && (
                          <span className="text-[10px] text-muted-foreground/60 tabular-nums px-1 group-hover:hidden">
                            {convs.length}
                          </span>
                        )}
                        {/* Actions on hover */}
                        <div className="hidden group-hover:flex group-focus-within:flex items-center gap-0.5 shrink-0">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="size-5 p-0 text-muted-foreground hover:text-foreground"
                            onClick={(e) => { e.stopPropagation(); void onNew(workspace.id); }}
                            aria-label={`New chat in ${workspace.name}`}
                            title="New chat in this project"
                          >
                            <Plus className="size-3" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="size-5 p-0 text-muted-foreground hover:text-foreground"
                            onClick={(e) => { e.stopPropagation(); startRename(workspace); }}
                            aria-label={`Rename ${workspace.name}`}
                            title="Rename project"
                          >
                            <Pencil className="size-3" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="size-5 p-0 text-muted-foreground hover:text-destructive"
                            onClick={(e) => { e.stopPropagation(); setConfirmCloseId(workspace.id); }}
                            aria-label={`Delete ${workspace.name}`}
                            title="Delete project"
                          >
                            <Trash2 className="size-3" />
                          </Button>
                        </div>
                      </div>
                    </div>

                    {/* Project conversations */}
                    {!isCollapsed && convs.length > 0 && (
                      <div className="ml-3 pl-2 border-l border-sidebar-border/30 space-y-0.5">
                        {convs.map((c) => {
                          const active = c.id === activeConversationId;
                          return (
                            <MemoizedConversationRow
                              key={c.id}
                              conversation={c}
                              active={active}
                              streaming={streamingStateByConversation[c.id]?.isStreaming ?? false}
                              query={debouncedQuery.trim()}
                              onSelect={() => {
                                selectConversation(c.id);
                                onNavigate?.();
                              }}
                              onPin={() => togglePin(c.id)}
                              onDelete={() => setDeleteId(c.id)}
                              onRename={(title) => renameConversation(c.id, title)}
                            />
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}

              {/* Empty state */}
              {visible.grouped.length === 0 && !loading && (
                <div className="px-2 py-6 text-xs text-muted-foreground text-center">
                  {debouncedQuery ? (
                    <div className="flex flex-col items-center gap-1.5">
                      <SearchX className="size-4 text-muted-foreground/60" />
                      <span>No conversations found</span>
                      <button
                        type="button"
                        onClick={clearSearch}
                        className="text-[11px] text-brand hover:underline"
                      >
                        Clear search
                      </button>
                    </div>
                  ) : (
                    "No conversations yet"
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </ScrollArea>

      <div className="border-t border-sidebar-border p-2 space-y-1 shrink-0 min-w-0">
        <Button
          variant="outline"
          size="sm"
          className="w-full justify-start text-xs h-8 px-2.5 gap-2 min-w-0"
          onClick={onOpenCommand}
        >
          <Search className="size-3.5 shrink-0" />
          <span className="truncate flex-1 text-left min-w-0">Quick switch</span>
          <Badge variant="secondary" className="ml-auto text-[10px] font-mono shrink-0">⌘K</Badge>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start text-xs h-8 px-2.5 gap-2 min-w-0"
          onClick={onOpenSettings}
        >
          <Settings className="size-3.5 shrink-0" />
          <span className="truncate flex-1 text-left min-w-0">Settings</span>
        </Button>
      </div>

      <AlertDialog open={deleteId !== null} onOpenChange={(o) => !o && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete conversation?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the conversation and all its messages. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={async () => {
                if (!deleteId) return;
                await deleteConversation(deleteId);
                setDeleteId(null);
                toast.success("Conversation deleted");
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmDeleteId !== null} onOpenChange={(o) => !o && setConfirmCloseId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete project?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the project from HermOS and unlinks its conversations.
              The files on disk will not be affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => { if (confirmDeleteId) void handleDeleteProject(confirmDeleteId); }}
            >
              Delete project
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </aside>
  );
}

/**
 * A single conversation row in the sidebar. When `showProjectBadge` is true,
 * a small folder dot is shown to indicate it belongs to a project.
 */
function ConversationRow({
  conversation,
  active,
  streaming,
  query,
  onSelect,
  onPin,
  onDelete,
  onRename,
}: {
  conversation: ConversationDTO;
  active: boolean;
  streaming: boolean;
  query: string;
  onSelect: () => void;
  onPin: () => void;
  onDelete: () => void;
  onRename: (title: string) => Promise<void>;
}) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(conversation.title);
  const [saving, setSaving] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    if (!editing) setDraft(conversation.title);
  }, [conversation.title, editing]);

  React.useEffect(() => {
    if (editing) {
      const el = inputRef.current;
      if (el) { el.focus(); el.select(); }
    }
  }, [editing]);

  const startRename = (e: React.MouseEvent) => {
    e.stopPropagation();
    setDraft(conversation.title);
    setEditing(true);
  };

  const cancel = () => {
    setDraft(conversation.title);
    setEditing(false);
  };

  const commit = async () => {
    const next = draft.trim();
    if (next.length < 1 || next.length > 100) {
      toast.error("Title must be 1–100 characters");
      cancel();
      return;
    }
    if (next === conversation.title) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await onRename(next);
      setEditing(false);
      toast.success("Renamed");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Rename failed");
      cancel();
    } finally {
      setSaving(false);
    }
  };

  const isPending = conversation.id.startsWith("pending-");

  return (
    <div
      className={cn(
        "group relative flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs cursor-pointer transition-colors",
        active
          ? "bg-sidebar-accent text-foreground font-medium"
          : "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground",
        editing && "cursor-default",
        isPending && "opacity-60 italic",
      )}
      onClick={() => { if (!editing) onSelect(); }}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (editing) return;
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(); }
      }}
    >
      <MessageSquare
        className={cn(
          "size-3.5 shrink-0 transition-colors",
          active ? "text-brand" : "text-muted-foreground/60 group-hover:text-foreground",
          isPending && "text-muted-foreground/40",
        )}
      />
      <div className="flex-1 min-w-0">
        {editing ? (
          <Input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); void commit(); }
              else if (e.key === "Escape") { e.preventDefault(); cancel(); }
            }}
            onClick={(e) => e.stopPropagation()}
            disabled={saving}
            maxLength={100}
            aria-label="Conversation title"
            className="h-6 text-xs font-medium px-1.5 py-0"
          />
        ) : (
          <div className="flex items-center gap-1.5 min-w-0" title={conversation.title}>
            {streaming && (
              <span className="size-1.5 rounded-full bg-brand animate-pulse shrink-0" />
            )}
            <span className="truncate text-xs leading-snug flex-1 min-w-0 font-normal">
              <HighlightedTitle title={conversation.title} query={query} />
            </span>
          </div>
        )}
      </div>

      {/* Hover actions */}
      {!editing && (
        <div className="hidden group-hover:flex group-focus-within:flex items-center gap-0.5 shrink-0">
          {!isPending && (
            <Button
              variant="ghost"
              size="sm"
              className="size-5 p-0 text-muted-foreground hover:text-foreground"
              aria-label={conversation.pinned ? "Unpin" : "Pin"}
              onClick={(e) => { e.stopPropagation(); onPin(); }}
            >
              <Pin className={cn("size-3", conversation.pinned ? "text-brand fill-brand" : "text-muted-foreground")} />
            </Button>
          )}
          <Button variant="ghost" size="sm" className="size-5 p-0 text-muted-foreground hover:text-foreground" aria-label="Rename" onClick={startRename}>
            <Pencil className="size-3 text-muted-foreground" />
          </Button>
          <Button variant="ghost" size="sm" className="size-5 p-0 text-muted-foreground hover:text-destructive" aria-label="Delete" onClick={(e) => { e.stopPropagation(); onDelete(); }}>
            <Trash2 className="size-3" />
          </Button>
        </div>
      )}
      {!editing && conversation.pinned && !isPending && (
        <Pin className="size-3 text-brand fill-brand shrink-0 group-hover:hidden" aria-hidden />
      )}
    </div>
  );
}

const MemoizedConversationRow = React.memo(ConversationRow, (prev, next) => {
  return (
    prev.active === next.active &&
    prev.streaming === next.streaming &&
    prev.query === next.query &&
    prev.conversation.id === next.conversation.id &&
    prev.conversation.title === next.conversation.title &&
    prev.conversation.pinned === next.conversation.pinned &&
    prev.conversation.updatedAt === next.conversation.updatedAt
  );
});

function HighlightedTitle({ title, query }: { title: string; query: string }) {
  if (!query) return <>{title}</>;
  const q = query.toLowerCase();
  const lower = title.toLowerCase();
  const idx = lower.indexOf(q);
  if (idx === -1) return <>{title}</>;
  const before = title.slice(0, idx);
  const match = title.slice(idx, idx + query.length);
  const after = title.slice(idx + query.length);
  return (
    <>
      {before}
      <mark className="bg-transparent text-brand font-semibold">{match}</mark>
      {after}
    </>
  );
}
