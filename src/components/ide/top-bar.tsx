"use client";

import * as React from "react";
import {
  Moon,
  Sun,
  Monitor,
  Settings as SettingsIcon,
  PanelRightOpen,
  PanelRightClose,
  PanelLeftOpen,
  PanelLeftClose,
  ChevronDown,
  GitBranch,
  Check,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { HermOSLogo } from "@/components/brand/hermos-logo";
import { ChatExportButton } from "@/components/ide/chat-export-button";
import { WindowControls } from "@/components/ide/window-controls";
import { useAppStore, isPendingConversationId } from "@/stores/app-store";
import { useThemeToggle } from "@/hooks/use-theme-toggle";
import { isTauri } from "@/lib/tauri";
import { isMacPlatform } from "@/lib/platform";

interface TopBarProps {
  onToggleSidebar: () => void;
  sidebarCollapsed: boolean;
  onToggleRight: () => void;
  rightCollapsed: boolean;
}

export function TopBar({
  onToggleSidebar,
  sidebarCollapsed,
  onToggleRight,
  rightCollapsed,
}: TopBarProps) {
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const setCommandOpen = useAppStore((s) => s.setCommandOpen);
  const setRightPanelTab = useAppStore((s) => s.setRightPanelTab);
  const currentUser = useAppStore((s) => s.currentUser);
  const gitStatus = useAppStore((s) => s.gitStatus);
  const activeWorkspace = useAppStore((s) => s.activeWorkspace);
  const refreshGitStatus = useAppStore((s) => s.refreshGitStatus);
  const activeConversationId = useAppStore((s) => s.activeConversationId);
  const conversations = useAppStore((s) => s.conversations);

  const activeConversation = activeConversationId
    ? conversations.find((c) => c.id === activeConversationId)
    : null;

  const { theme, cycle } = useThemeToggle();

  // Poll git status when the active workspace is a git repo. Refetch
  // on workspace change + every 30s (light). Cleared when the
  // workspace switches so the indicator never shows a stale branch.
  React.useEffect(() => {
    if (!activeWorkspace) return;
    void refreshGitStatus();
    const id = window.setInterval(() => {
      void refreshGitStatus();
    }, 30_000);
    return () => window.clearInterval(id);
  }, [activeWorkspace?.id, refreshGitStatus]);

  const ThemeIcon = theme === "light" ? Sun : theme === "dark" ? Moon : Monitor;
  const themeLabel = theme === "light" ? "Light" : theme === "dark" ? "Dark" : "System";

  const initials = (currentUser?.name || currentUser?.email || "U")
    .split(/[ @]/)
    .map((s) => s[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();

  // Git indicator summary — derived from the store's gitStatus. Counts
  // are split into "unstaged/untracked" (amber) and "staged" (emerald)
  // so the user can see at a glance whether they have anything ready
  // to commit. Hidden entirely when the workspace isn't a git repo
  // (cleaner than showing "not a repo").
  const isRepo = !!gitStatus?.isRepo;
  const unstagedCount = isRepo
    ? (gitStatus?.modified?.length ?? 0) + (gitStatus?.untracked?.length ?? 0)
    : 0;
  const stagedCount = isRepo ? (gitStatus?.staged?.length ?? 0) : 0;
  const totalChanges = unstagedCount + stagedCount;
  const branchName = gitStatus?.branch ?? "";
  const gitTooltip = isRepo
    ? `${branchName || "HEAD detached"} · ${totalChanges} change${
        totalChanges === 1 ? "" : "s"
      } · click to view`
    : "Open a git repository to see status";

  const openGitTab = () => {
    setRightPanelTab("git");
  };

  const tauriDesktop = isTauri();
  const needsTrafficLightsPad = tauriDesktop && isMacPlatform();

  return (
    <header
      data-tauri-drag-region
      className="h-8 shrink-0 border-b bg-background/80 backdrop-blur-sm flex items-center gap-0.5 px-1.5 select-none"
      style={tauriDesktop ? { WebkitAppRegion: "drag" } as React.CSSProperties : undefined}
    >
      {/* Sidebar toggle — left edge */}
      <div className={needsTrafficLightsPad ? "pl-[80px] flex items-center gap-0.5" : "flex items-center gap-0.5"}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-6 inline-flex"
              onClick={onToggleSidebar}
              aria-label={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
              data-tauri-drag-region="false"
              style={tauriDesktop ? ({ WebkitAppRegion: "no-drag" } as React.CSSProperties) : undefined}
            >
              {sidebarCollapsed ? <PanelLeftOpen className="size-3" /> : <PanelLeftClose className="size-3" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}</TooltipContent>
        </Tooltip>

        <div className="md:hidden">
          <HermOSLogo size={16} />
        </div>
      </div>

      {/* Center group — git status + export + controls */}
      <div
        className="flex-1 flex items-center justify-center gap-0.5"
        data-tauri-drag-region="false"
        style={tauriDesktop ? ({ WebkitAppRegion: "no-drag" } as React.CSSProperties) : undefined}
      >
        {/* Git status indicator */}
        {isRepo && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 gap-1 px-1 text-xs"
                onClick={openGitTab}
                aria-label={gitTooltip}
              >
                <GitBranch className="size-3 text-brand" />
                <span className="max-w-[64px] truncate font-mono text-foreground/80">
                  {branchName || "HEAD"}
                </span>
                {totalChanges > 0 && (
                  <span className="flex items-center gap-0.5">
                    {unstagedCount > 0 && (
                      <Badge
                        variant="outline"
                        className="h-3 min-w-3 px-0.5 text-[8px] font-mono tabular-nums text-amber-700 dark:text-amber-400 border-amber-500/40 bg-amber-500/5"
                      >
                        {unstagedCount}
                      </Badge>
                    )}
                    {stagedCount > 0 && (
                      <Badge
                        variant="outline"
                        className="h-3 min-w-3 px-0.5 text-[8px] font-mono tabular-nums text-brand border-brand/40 bg-brand/5"
                      >
                        {stagedCount}
                      </Badge>
                    )}
                  </span>
                )}
                {totalChanges === 0 && (
                  <Check className="size-2 text-brand" aria-hidden />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{gitTooltip}</TooltipContent>
          </Tooltip>
        )}

        {/* Export button — only shown when a persisted conversation is active */}
        {activeConversationId && !isPendingConversationId(activeConversationId) && (
          <ChatExportButton
            conversationId={activeConversationId}
            title={activeConversation?.title ?? ""}
            className="h-6 px-1"
          />
        )}

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              onClick={cycle}
              aria-label={`Theme: ${themeLabel}. Click to cycle.`}
            >
              <ThemeIcon className="size-3" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Theme: {themeLabel}</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              onClick={() => setCommandOpen(true)}
              aria-label="Open command palette"
            >
              <ChevronDown className="size-3" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Command palette (⌘K)</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              onClick={() => setSettingsOpen(true)}
              aria-label="Open settings"
            >
              <SettingsIcon className="size-3" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Settings</TooltipContent>
        </Tooltip>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-6 gap-0.5 px-0.5">
              <Avatar className="size-4">
                <AvatarFallback className="bg-secondary text-secondary-foreground text-[8px]">
                  {initials}
                </AvatarFallback>
              </Avatar>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel className="flex flex-col gap-0.5">
              <span className="text-sm font-medium truncate">
                {currentUser?.name || "Local Developer"}
              </span>
              <span className="text-xs text-muted-foreground font-normal truncate">
                {currentUser?.email || "desktop@hermos.local"}
              </span>
              <Badge variant="secondary" className="text-[10px] w-fit mt-1">
                Local / Offline
              </Badge>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => setSettingsOpen(true)}>
              <SettingsIcon className="size-3" /> Settings
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Right panel toggle — right edge */}
      <div data-tauri-drag-region="false" style={tauriDesktop ? ({ WebkitAppRegion: "no-drag" } as React.CSSProperties) : undefined}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-6 hidden md:inline-flex"
              onClick={onToggleRight}
              aria-label={rightCollapsed ? "Show right panel" : "Hide right panel"}
            >
              {rightCollapsed ? <PanelRightOpen className="size-3" /> : <PanelRightClose className="size-3" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{rightCollapsed ? "Show right panel" : "Hide right panel"}</TooltipContent>
        </Tooltip>
      </div>

      {/* Native window controls — desktop only (non-macOS); macOS uses native traffic lights via Overlay */}
      {tauriDesktop && !isMacPlatform() && (
        <>
          <div className="h-4 w-px shrink-0 bg-border/60 ml-1" aria-hidden />
          <div
            data-tauri-drag-region="false"
            style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
            className="shrink-0 -mr-1.5"
          >
            <WindowControls />
          </div>
        </>
      )}
    </header>
  );
}
