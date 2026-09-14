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
  Bot,
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
import { useTranslation } from "@/hooks/use-translation";
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
  const pendingConversations = useAppStore((s) => s.pendingConversations);
  const streamingByConv = useAppStore((s) => s.streamingStateByConversation);
  const selectConversation = useAppStore((s) => s.selectConversation);

  const activeConversation = activeConversationId
    ? conversations.find((c) => c.id === activeConversationId)
    : null;

  // Background running session (not currently active)
  const bgRunningEntry = Object.entries(streamingByConv).find(
    ([id, st]) => id !== activeConversationId && st?.isStreaming,
  );
  const bgRunningId = bgRunningEntry?.[0];
  const bgRunningSession = bgRunningId
    ? conversations.find((c) => c.id === bgRunningId) ||
      pendingConversations.find((p) => p.id === bgRunningId)
    : null;

  const { theme, cycle } = useThemeToggle();
  const { t } = useTranslation();

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
  const themeLabel = theme === "light" ? t("theme_light") : theme === "dark" ? t("theme_dark") : t("theme_system");

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
  const sidebarLabel = sidebarCollapsed ? t("show_sidebar") : t("hide_sidebar");

  return (
    <header
      data-tauri-drag-region
      className="h-8 shrink-0 border-b bg-background/80 backdrop-blur-sm flex items-center gap-0.5 px-1.5 select-none"
      style={tauriDesktop ? { WebkitAppRegion: "drag" } as React.CSSProperties : undefined}
    >
      {/* Sidebar toggle — left edge */}
      <div className={needsTrafficLightsPad ? "ps-[80px] flex items-center gap-0.5" : "flex items-center gap-0.5"}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-6 inline-flex"
              onClick={onToggleSidebar}
              aria-label={sidebarLabel}
              data-tauri-drag-region="false"
              style={tauriDesktop ? ({ WebkitAppRegion: "no-drag" } as React.CSSProperties) : undefined}
            >
              {sidebarCollapsed ? <PanelLeftOpen className="size-3" /> : <PanelLeftClose className="size-3" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{sidebarLabel}</TooltipContent>
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

        {/* Background running session shortcut pill */}
        {bgRunningId && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="h-6 gap-1.5 px-2 text-xs border-brand/40 bg-brand/5 hover:bg-brand/10 text-brand animate-pulse"
                onClick={() => void selectConversation(bgRunningId)}
                aria-label={`${t("go_to_session")}: ${bgRunningSession?.title || t("conversation")}`}
              >
                <Bot className="size-3 shrink-0" />
                <span className="max-w-[120px] truncate font-medium">
                  {bgRunningSession?.title || t("conversation")}
                </span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {t("agent_running_in_session", { title: bgRunningSession?.title || t("conversation") })} · {t("go_to_session")}
            </TooltipContent>
          </Tooltip>
        )}

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              onClick={cycle}
              aria-label={`${t("theme")}: ${themeLabel}`}
            >
              <ThemeIcon className="size-3" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("theme")}: {themeLabel}</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              onClick={() => setCommandOpen(true)}
              aria-label={t("open_command_palette")}
            >
              <ChevronDown className="size-3" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("command_palette_shortcut")}</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              onClick={() => setSettingsOpen(true)}
              aria-label={t("open_settings")}
            >
              <SettingsIcon className="size-3" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("settings")}</TooltipContent>
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
              <SettingsIcon className="size-3" /> {t("settings")}
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
              aria-label={rightCollapsed ? t("show_right_panel") : t("hide_right_panel")}
            >
              {rightCollapsed ? <PanelRightOpen className="size-3" /> : <PanelRightClose className="size-3" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{rightCollapsed ? t("show_right_panel") : t("hide_right_panel")}</TooltipContent>
        </Tooltip>
      </div>

      {/* Native window controls — desktop only (non-macOS); macOS uses native traffic lights via Overlay */}
      {tauriDesktop && !isMacPlatform() && (
        <>
          <div className="h-4 w-px shrink-0 bg-border/60 ms-1" aria-hidden />
          <div
            data-tauri-drag-region="false"
            style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
            className="shrink-0 -me-1.5"
          >
            <WindowControls />
          </div>
        </>
      )}
    </header>
  );
}
