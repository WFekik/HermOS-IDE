"use client";

import * as React from "react";

import dynamic from "next/dynamic";
import {
  Plug,
  Puzzle,
  Terminal as TerminalIcon,
  FolderTree,
  Globe,
  FileText,
  Bot,
  ListTree,
  GitBranch,
  Sparkles,
  ChevronDown,
  ChevronUp,
  Loader2,
} from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ErrorBoundary } from "@/components/ide/error-boundary";
import { useAppStore } from "@/stores/app-store";
import type { RightPanelTab } from "@/stores/app-store";

function PanelSkeleton() {
  return (
    <div className="flex h-full w-full items-center justify-center p-8">
      <Loader2 className="size-5 animate-spin text-muted-foreground" />
    </div>
  );
}

const WorkspacePanel = dynamic(
  () => import("@/components/panels/workspace-panel").then((m) => ({ default: m.WorkspacePanel })),
  { ssr: false, loading: () => <PanelSkeleton /> },
);
const ArtifactPanel = dynamic(
  () => import("@/components/panels/artifact-panel").then((m) => ({ default: m.ArtifactPanel })),
  { ssr: false, loading: () => <PanelSkeleton /> },
);
const OutlinePanel = dynamic(
  () => import("@/components/panels/outline-panel").then((m) => ({ default: m.OutlinePanel })),
  { ssr: false, loading: () => <PanelSkeleton /> },
);
const McpPanel = dynamic(
  () => import("@/components/panels/mcp-panel").then((m) => ({ default: m.McpPanel })),
  { ssr: false, loading: () => <PanelSkeleton /> },
);
const PluginsPanel = dynamic(
  () => import("@/components/panels/plugins-panel").then((m) => ({ default: m.PluginsPanel })),
  { ssr: false, loading: () => <PanelSkeleton /> },
);
const SkillsPanel = dynamic(
  () => import("@/components/panels/skills-panel").then((m) => ({ default: m.SkillsPanel })),
  { ssr: false, loading: () => <PanelSkeleton /> },
);
const TerminalPanel = dynamic(
  () => import("@/components/panels/terminal-panel").then((m) => ({ default: m.TerminalPanel })),
  { ssr: false, loading: () => <PanelSkeleton /> },
);
const BrowserPanel = dynamic(
  () => import("@/components/panels/browser-panel").then((m) => ({ default: m.BrowserPanel })),
  { ssr: false, loading: () => <PanelSkeleton /> },
);
const OfficePanel = dynamic(
  () => import("@/components/panels/office-panel").then((m) => ({ default: m.OfficePanel })),
  { ssr: false, loading: () => <PanelSkeleton /> },
);
const SubagentsPanel = dynamic(
  () => import("@/components/panels/subagents-panel").then((m) => ({ default: m.SubagentsPanel })),
  { ssr: false, loading: () => <PanelSkeleton /> },
);
const GitPanel = dynamic(
  () => import("@/components/panels/git-panel").then((m) => ({ default: m.GitPanel })),
  { ssr: false, loading: () => <PanelSkeleton /> },
);

/**
 * Single source of truth for the right-panel tabs. IdeShell derives the
 * ⌘1-9 shortcut order and the collapsed-rail icons from this list so the
 * keyboard, rail, and tab bar can never drift apart.
 */
export const RIGHT_PANEL_TABS: { value: RightPanelTab; label: string; icon: React.ElementType }[] = [
  { value: "files", label: "Files", icon: FolderTree },
  { value: "artifacts", label: "Artifacts", icon: Sparkles },
  { value: "outline", label: "Outline", icon: ListTree },
  { value: "mcp", label: "MCP", icon: Plug },
  { value: "plugins", label: "Plugins", icon: Puzzle },
  { value: "skills", label: "Skills", icon: Sparkles },
  { value: "terminal", label: "Terminal", icon: TerminalIcon },
  { value: "browser", label: "Browser", icon: Globe },
  { value: "office", label: "Office", icon: FileText },
  { value: "subagents", label: "Subagents", icon: Bot },
  { value: "git", label: "Git", icon: GitBranch },
];

export function RightPanel() {
  const tab = useAppStore((s) => s.rightPanelTab);
  const setTab = useAppStore((s) => s.setRightPanelTab);
  const [tabBarCollapsed, setTabBarCollapsed] = React.useState(false);
  const tabListRef = React.useRef<HTMLDivElement>(null);

  // Auto-scroll active tab into view smoothly
  React.useEffect(() => {
    if (tabListRef.current) {
      const activeEl = tabListRef.current.querySelector<HTMLElement>('[data-state="active"]');
      if (activeEl) {
        activeEl.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
      }
    }
  }, [tab]);

  const activeTabLabel = RIGHT_PANEL_TABS.find((t) => t.value === tab)?.label ?? "Tabs";

  return (
    <div className="flex h-full min-h-0 flex-col bg-card overflow-hidden">
      <Tabs value={tab} onValueChange={(v) => setTab(v as RightPanelTab)} className="flex-1 flex flex-col gap-0 min-h-0">
        <div className="shrink-0 flex items-center border-b px-1 py-0.5 bg-muted/20 gap-1 min-w-0">
          {!tabBarCollapsed ? (
            <>
              <div
                ref={tabListRef}
                className="flex-1 min-w-0 overflow-x-auto overflow-y-hidden flex items-center py-0.5 scroll-smooth"
                style={{ scrollbarWidth: "none", msOverflowStyle: "none" }}
              >
                <TabsList className="h-8 inline-flex flex-row items-center gap-0.5 whitespace-nowrap bg-transparent p-0 w-max shrink-0">
                  {RIGHT_PANEL_TABS.map((t) => (
                    <TabsTrigger
                      key={t.value}
                      value={t.value}
                      className="text-xs gap-1.5 px-2.5 h-7 shrink-0 data-[state=active]:bg-background data-[state=active]:shadow-xs rounded-md transition-all"
                      title={t.label}
                    >
                      <t.icon className="size-3.5 shrink-0" />
                      <span className="truncate max-w-[90px]">{t.label}</span>
                    </TabsTrigger>
                  ))}
                </TabsList>
              </div>
              <button
                type="button"
                onClick={() => setTabBarCollapsed(true)}
                className="shrink-0 p-1.5 rounded hover:bg-accent transition-colors border-l pl-1.5 ml-0.5 text-muted-foreground hover:text-foreground"
                title="Hide tabs"
                aria-label="Collapse panel tabs"
              >
                <ChevronUp className="size-3.5" />
              </button>
            </>
          ) : (
            <div className="flex items-center justify-between w-full px-1">
              <button
                type="button"
                onClick={() => setTabBarCollapsed(false)}
                className="flex items-center gap-1.5 px-2 py-1 rounded hover:bg-accent transition-colors text-xs text-muted-foreground hover:text-foreground font-medium"
                title="Show tabs"
                aria-label="Expand panel tabs"
              >
                <ChevronDown className="size-3.5" />
                <span>Panel tabs ({activeTabLabel})</span>
              </button>
            </div>
          )}
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden relative">
          <TabsContent value="files" className="mt-0 h-full data-[state=inactive]:hidden">
            <ErrorBoundary fallbackTitle="Files panel error">
              <WorkspacePanel />
            </ErrorBoundary>
          </TabsContent>
          <TabsContent value="artifacts" className="mt-0 h-full data-[state=inactive]:hidden">
            <ErrorBoundary fallbackTitle="Artifacts panel error">
              <ArtifactPanel />
            </ErrorBoundary>
          </TabsContent>
          <TabsContent value="outline" className="mt-0 h-full data-[state=inactive]:hidden">
            <ErrorBoundary fallbackTitle="Outline panel error">
              <OutlinePanel />
            </ErrorBoundary>
          </TabsContent>
          <TabsContent value="mcp" className="mt-0 h-full data-[state=inactive]:hidden">
            <ErrorBoundary fallbackTitle="MCP panel error">
              <McpPanel />
            </ErrorBoundary>
          </TabsContent>
          <TabsContent value="plugins" className="mt-0 h-full data-[state=inactive]:hidden">
            <ErrorBoundary fallbackTitle="Plugins panel error">
              <PluginsPanel />
            </ErrorBoundary>
          </TabsContent>
          <TabsContent value="skills" className="mt-0 h-full data-[state=inactive]:hidden">
            <ErrorBoundary fallbackTitle="Skills panel error">
              <SkillsPanel />
            </ErrorBoundary>
          </TabsContent>
          <TabsContent value="terminal" className="mt-0 h-full data-[state=inactive]:hidden">
            <ErrorBoundary fallbackTitle="Terminal panel error">
              <TerminalPanel />
            </ErrorBoundary>
          </TabsContent>
          <TabsContent value="browser" className="mt-0 h-full data-[state=inactive]:hidden">
            <ErrorBoundary fallbackTitle="Browser panel error">
              <BrowserPanel />
            </ErrorBoundary>
          </TabsContent>
          <TabsContent value="office" className="mt-0 h-full data-[state=inactive]:hidden">
            <ErrorBoundary fallbackTitle="Office panel error">
              <OfficePanel />
            </ErrorBoundary>
          </TabsContent>
          <TabsContent value="subagents" className="mt-0 h-full data-[state=inactive]:hidden">
            <ErrorBoundary fallbackTitle="Subagents panel error">
              <SubagentsPanel />
            </ErrorBoundary>
          </TabsContent>
          <TabsContent value="git" className="mt-0 h-full data-[state=inactive]:hidden">
            <ErrorBoundary fallbackTitle="Git panel error">
              <GitPanel />
            </ErrorBoundary>
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}
