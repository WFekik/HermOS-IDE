"use client";

import * as React from "react";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import {
  Plus,
  Settings as SettingsIcon,
} from "lucide-react";
import { Sidebar } from "@/components/ide/sidebar";
import { TopBar } from "@/components/ide/top-bar";
import { ChatView } from "@/components/ide/chat-view";
import { StatusBar } from "@/components/ide/status-bar";
import { KeyboardShortcuts } from "@/components/ide/keyboard-shortcuts";
import { TaskProgress } from "@/components/ide/task-progress";
import { RightPanel, RIGHT_PANEL_TABS } from "@/components/panels/right-panel";
import { FindInFilesPanel } from "@/components/panels/find-in-files-panel";
import dynamic from "next/dynamic";
// Code-split the settings dialog (~1.1k lines + providers/usage/permissions
// modules) out of the initial bundle; an idle prefetch warms the chunks so
// the first click opens instantly instead of paying a synchronous mount.
const SettingsDialog = dynamic(
  () => import("@/components/settings/settings-dialog").then((m) => ({ default: m.SettingsDialog })),
  { ssr: false, loading: () => null },
);
import { CommandPalette } from "@/components/ide/command-palette";
import { HermOSLogo } from "@/components/brand/hermos-logo";
import { ErrorBoundary } from "@/components/ide/error-boundary";
import { dispatchExportConversation } from "@/components/ide/chat-export-button";
import { useAppStore, isPendingConversationId } from "@/stores/app-store";
import { useIsTablet } from "@/hooks/use-mobile";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { isMacPlatform } from "@/lib/platform";
import type { RightPanelTab } from "@/stores/app-store";

/* The thin 48px rails shown when the sidebar / right panel are
   collapsed. Matches VS Code's "icon-only" collapse behavior — the
   user still sees the active affordances (logo + new chat + settings
   on the left; tab icons on the right) and can click to re-expand. */
const RAIL_WIDTH_PX = 48;

/* ⌘1-9 switch right-panel tabs; the order (and the collapsed rail's
   icons below) derive from RIGHT_PANEL_TABS so the keyboard shortcuts,
   rail, and tab bar always agree. */
const RIGHT_PANEL_TAB_ORDER: RightPanelTab[] = RIGHT_PANEL_TABS.map((t) => t.value);

export function IdeShell() {
  const [sidebarCollapsed, setSidebarCollapsed] = React.useState(true);
  const [rightCollapsed, setRightCollapsed] = React.useState(true);

  const settingsOpen = useAppStore((s) => s.settingsOpen);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const settingsTab = useAppStore((s) => s.settingsTab);
  const setSettingsTab = useAppStore((s) => s.setSettingsTab);
  const setRightPanelTab = useAppStore((s) => s.setRightPanelTab);
  const rightPanelTab = useAppStore((s) => s.rightPanelTab);
  const rightPanelOpen = useAppStore((s) => s.rightPanelOpen);
  const setRightPanelOpen = useAppStore((s) => s.setRightPanelOpen);
  const setCommandOpen = useAppStore((s) => s.setCommandOpen);
  const toggleShortcutsOpen = useAppStore((s) => s.toggleShortcutsOpen);
  const setFindInFilesOpen = useAppStore((s) => s.setFindInFilesOpen);
  const activeConversationId = useAppStore((s) => s.activeConversationId);

  const isTablet = useIsTablet();
  const openSettings = React.useCallback(() => setSettingsOpen(true), [setSettingsOpen]);

  // Warm the code-split settings chunks while the shell idles so the first
  // settings click opens instantly (dialog + providers tab module cache).
  React.useEffect(() => {
    const id = window.setTimeout(() => {
      import("@/components/settings/settings-dialog")
        .then(() => import("@/components/settings/tabs/providers-tab"))
        .catch(() => {});
    }, 2000);
    return () => window.clearTimeout(id);
  }, []);

  // Auto-collapse sidebar & right panel into 48px rails on tablet screens
  // (768px-1024px) to preserve main chat/editor width.
  React.useEffect(() => {
    if (isTablet) {
      setSidebarCollapsed(true);
      setRightPanelOpen(false);
    }
  }, [isTablet, setRightPanelOpen]);

  // Keep the local collapse state in sync with the global rightPanelOpen
  // store flag (opened from the rail, top bar, or ⌘J).
  React.useEffect(() => {
    setRightCollapsed(!rightPanelOpen);
  }, [rightPanelOpen]);

  const toggleSidebar = React.useCallback(() => {
    setSidebarCollapsed((v) => !v);
  }, []);

  const toggleRight = React.useCallback(() => {
    const current = useAppStore.getState().rightPanelOpen;
    setRightPanelOpen(!current);
  }, [setRightPanelOpen]);

  // Global keyboard shortcut handler.
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;

      const tag = (e.target as HTMLElement | null)?.tagName?.toUpperCase();
      const inText =
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        (e.target as HTMLElement | null)?.isContentEditable;

      // ⌘? (shift+/) or ⌘/ — toggle shortcuts overlay.
      if ((e.key === "?" || e.key === "/") && !e.altKey) {
        // Allow ⌘/ inside text inputs too (it's not a typing conflict).
        e.preventDefault();
        toggleShortcutsOpen();
        return;
      }

      // ⌘K — command palette (allowed in text inputs).
      if (e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCommandOpen(true);
        return;
      }

      // ⌘, — settings (allowed in text inputs).
      if (e.key === ",") {
        e.preventDefault();
        setSettingsOpen(true);
        return;
      }

      // ⌘N — new conversation (skip if typing in an input — could be
      // creating a new file in the workspace panel).
      if (e.key.toLowerCase() === "n" && !inText) {
        e.preventDefault();
        void useAppStore
          .getState()
          .createConversation()
          .then(() => toast.success("New conversation"));
        return;
      }

      // ⌘E — export the active conversation as Markdown. Allowed inside
      // text inputs (e.g. while typing in the composer) since it doesn't
      // conflict with typing. preventDefault stops some browsers from
      // using ⌘E for "Find".
      if (e.key.toLowerCase() === "e" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        const { activeConversationId } = useAppStore.getState();
        if (!activeConversationId || isPendingConversationId(activeConversationId)) {
          toast.error("No active conversation to export");
          return;
        }
        dispatchExportConversation();
        return;
      }

      // ⌘⇧A — select all conversations (enters bulk-select mode in the
      // sidebar and selects every conversation row).
      if (e.shiftKey && e.key.toLowerCase() === "a" && !inText) {
        e.preventDefault();
        const s = useAppStore.getState();
        if (s.conversations.length === 0) {
          toast.error("No conversations to select");
          return;
        }
        s.setBulkSelectMode(true);
        s.selectAllConversations();
        return;
      }

      // ⌘⇧F — find in files (global workspace grep overlay). Allowed
      // inside text inputs so the user can hit it while typing in the
      // composer; the overlay's own search input is auto-focused.
      if (e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setFindInFilesOpen(true);
        return;
      }

      // ⌘L — go to line in the active file editor. preventDefault is
      // important: some browsers use ⌘L to focus the address bar; in
      // the app context we override. Allowed inside text inputs so the
      // user can hit it while typing in the composer or the editor
      // itself. The FileEditor listens for the `hermos:go-to-line`
      // window event and opens its dialog (no-op if no file is open).
      if (!e.shiftKey && !e.altKey && e.key.toLowerCase() === "l") {
        e.preventDefault();
        // In split mode, target the active side (left or right) so the
        // dialog opens on the focused editor.
        const st = useAppStore.getState();
        const side = st.splitEditorOpen ? st.splitEditorActive : "left";
        window.dispatchEvent(
          new CustomEvent("hermos:go-to-line", { detail: { side } }),
        );
        return;
      }

      // ⌘\ — toggle the split editor (open/close). Allowed inside text
      // inputs since it doesn't conflict with typing. preventDefault
      // stops some browsers from using ⌘\ for "show bookmarks bar".
      if (!e.shiftKey && !e.altKey && e.key === "\\") {
        e.preventDefault();
        useAppStore.getState().toggleSplitEditor();
        return;
      }

      // ⌘B — toggle sidebar.
      if (e.key.toLowerCase() === "b" && !inText) {
        e.preventDefault();
        toggleSidebar();
        return;
      }

      // ⌘J — toggle right panel.
      if (e.key.toLowerCase() === "j" && !inText) {
        e.preventDefault();
        toggleRight();
        return;
      }

      // ⌘1–9 — switch right-panel tab.
      const numMatch = /^[1-9]$/.test(e.key);
      if (numMatch && !inText) {
        e.preventDefault();
        const idx = parseInt(e.key, 10) - 1;
        const tab = RIGHT_PANEL_TAB_ORDER[idx];
        if (tab) setRightPanelTab(tab);
        return;
      }

      // ⌘⇧P — alias for command palette.
      if (e.shiftKey && e.key.toLowerCase() === "p" && !inText) {
        e.preventDefault();
        setCommandOpen(true);
        return;
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    toggleSidebar,
    toggleRight,
    setRightPanelTab,
    setCommandOpen,
    setSettingsOpen,
    toggleShortcutsOpen,
    setFindInFilesOpen,
  ]);

  // Subagent polling is handled by SubagentsPanel (single source of truth).
  // Do NOT add a second interval here — it would cause duplicate requests.

  return (
    <TooltipProvider delayDuration={200}>
      <div className="h-screen w-screen flex flex-col bg-background overflow-hidden">
        <TopBar
          onToggleSidebar={toggleSidebar}
          sidebarCollapsed={sidebarCollapsed}
          onToggleRight={toggleRight}
          rightCollapsed={rightCollapsed}
        />
        <div className="flex-1 min-h-0 relative">
          <ResizablePanelGroup direction="horizontal" autoSaveId="hermos-layout">
              {sidebarCollapsed ? (
                /* Collapsed-left rail — 48px wide, just the logo +
                   new-chat + settings icons. Clicking the rail
                   re-expands the sidebar. */
                <SidebarRail
                  onExpand={toggleSidebar}
                  onNewChat={() =>
                    void useAppStore
                      .getState()
                      .createConversation()
                      .then(() => toast.success("New conversation"))
                  }
                  onOpenSettings={openSettings}
                />
              ) : (
                <>
                  <ResizablePanel id="sidebar" order={1} defaultSize={25} minSize={12} maxSize={70} className="min-w-[260px] max-w-[750px]">
                    <ErrorBoundary fallbackTitle="Sidebar encountered an error">
                      <Sidebar
                        onOpenSettings={openSettings}
                        onOpenCommand={() => setCommandOpen(true)}
                      />
                    </ErrorBoundary>
                  </ResizablePanel>
                  <ResizableHandle withHandle />
                </>
              )}
              <ResizablePanel id="main" order={2} defaultSize={52} minSize={15}>
                <ErrorBoundary fallbackTitle="Chat View encountered an error">
                  <ChatView />
                </ErrorBoundary>
              </ResizablePanel>
              {rightCollapsed ? (
                /* Collapsed-right rail — 48px wide, vertical column of
                   tab icons. Clicking any icon re-expands the right
                   panel on that tab. */
                <RightPanelRail
                  activeTab={rightPanelTab}
                  onPick={(t) => {
                    setRightPanelTab(t);
                    setRightPanelOpen(true);
                  }}
                />
              ) : (
                <>
                  <ResizableHandle withHandle />
                  <ResizablePanel id="right-panel" order={3} defaultSize={23} minSize={18} maxSize={85} className="min-w-[280px]">
                    <ErrorBoundary fallbackTitle="Panel encountered an error">
                      <RightPanel />
                    </ErrorBoundary>
                  </ResizablePanel>
                </>
              )}
            </ResizablePanelGroup>
        </div>
        <div className="hidden md:block shrink-0">
          <StatusBar />
        </div>
        <TaskProgress />
        <ErrorBoundary fallbackTitle="Settings encountered an error">
          <SettingsDialog
            open={settingsOpen}
            onOpenChange={setSettingsOpen}
            tab={settingsTab}
            onTabChange={setSettingsTab}
          />
        </ErrorBoundary>
        <ErrorBoundary fallbackTitle="Command palette encountered an error">
          <CommandPalette />
        </ErrorBoundary>
        <ErrorBoundary fallbackTitle="Keyboard shortcuts encountered an error">
          <KeyboardShortcuts />
        </ErrorBoundary>
        <ErrorBoundary fallbackTitle="Find in files encountered an error">
          <FindInFilesPanel />
        </ErrorBoundary>
      </div>
    </TooltipProvider>
  );
}

/* ------------------------------ Sidebar rail ------------------------------ */

function SidebarRail({
  onExpand,
  onNewChat,
  onOpenSettings,
}: {
  onExpand: () => void;
  onNewChat: () => void;
  onOpenSettings: () => void;
}) {
  return (
    <aside
      className="flex h-full shrink-0 flex-col items-center gap-1 border-r bg-sidebar py-2"
      style={{ width: `${RAIL_WIDTH_PX}px` }}
      aria-label="Sidebar (collapsed)"
    >
      <button
        type="button"
        onClick={onExpand}
        className="flex size-9 items-center justify-center rounded-md hover:bg-sidebar-accent/60 transition-colors"
        aria-label="Expand sidebar"
      >
        <HermOSLogo size={24} />
      </button>
      <div className="my-1 h-px w-6 bg-sidebar-border" />
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-9"
            onClick={onNewChat}
            aria-label="New conversation"
          >
            <Plus className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="right">New conversation ({isMacPlatform() ? "⌘" : "Ctrl+"}N)</TooltipContent>
      </Tooltip>
      <div className="flex-1" />
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-9"
            onClick={onOpenSettings}
            aria-label="Settings"
          >
            <SettingsIcon className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="right">Settings ({isMacPlatform() ? "⌘" : "Ctrl+"},)</TooltipContent>
      </Tooltip>
    </aside>
  );
}

/* ------------------------------ Right panel rail ------------------------------ */

function SubagentRailBadge() {
  const runningCount = useAppStore(
    (s) => s.subagents.filter((x) => x.status === "running" || x.status === "pending").length,
  );
  if (runningCount === 0) return null;
  return (
    <span className="absolute -top-0.5 -right-0.5 flex size-3.5 items-center justify-center rounded-full bg-sky-500 text-[8px] font-mono font-semibold text-white leading-none shadow-2xs animate-pulse">
      {runningCount > 9 ? "9+" : runningCount}
    </span>
  );
}

function RightPanelRail({
  activeTab,
  onPick,
}: {
  activeTab: RightPanelTab;
  onPick: (t: RightPanelTab) => void;
}) {
  return (
    <aside
      className="flex h-full shrink-0 flex-col items-center gap-0.5 border-l bg-card py-2 overflow-y-auto"
      style={{ width: `${RAIL_WIDTH_PX}px` }}
      aria-label="Tools panel (collapsed)"
    >
      {RIGHT_PANEL_TABS.map((t) => {
        const Icon = t.icon;
        const active = t.value === activeTab;
        return (
          <Tooltip key={t.value}>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => onPick(t.value)}
                className={cn(
                  "flex size-9 items-center justify-center rounded-md transition-colors",
                  active
                    ? "bg-brand/10 text-brand"
                    : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                )}
                    aria-label={`${t.label} (expand panel)`}
                  >
                    <span className="relative">
                      <Icon className="size-4" />
                      {t.value === "subagents" && <SubagentRailBadge />}
                    </span>
                  </button>
            </TooltipTrigger>
            <TooltipContent side="left">{t.label}</TooltipContent>
          </Tooltip>
        );
      })}
    </aside>
  );
}
