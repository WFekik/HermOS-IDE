"use client";

import * as React from "react";
import { formatDistanceToNow } from "date-fns";
import {
  GitBranch,
  GitCommit as GitCommitIcon,
  RefreshCw,
  Loader2,
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Plus,
  Trash2,
  FilePen,
  FilePlus,
  FileMinus,
  ArrowRightLeft,
  Copy,
  ExternalLink,
  GitGraph,
  ListTree,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { GitDiffView } from "@/components/ide/git-diff-view";
import { useAppStore } from "@/stores/app-store";
import { apiGet, apiPost, apiDelete, ApiRequestError } from "@/lib/api-client";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/hooks/use-translation";
import type {
  GitBranch as GitBranchInfo,
  GitCommit,
  GitFileChange,
  GitWorktree,
} from "@/stores/app-store";

/* ------------------------------------------------------------------ *
 * git-panel.tsx — Git tab in the right panel.
 *
 * Shows the per-workspace git status (branch, ahead/behind, staged /
 * modified / untracked file lists), a "View diff" button that opens
 * a Dialog rendering the full unified diff via <GitDiffView>, recent
 * commits, branches, and worktrees. When the active workspace isn't
 * a git repo, shows a "not a git repo" empty state with a copy-
 * pasteable `git init` command.
 *
 * The store owns the gitStatus state (single source of truth). The
 * panel refreshes on mount + every 30s (light poll) + on manual
 * refresh button click. Errors are surfaced via toasts; the panel
 * itself shows graceful empty / loading / unavailable states instead
 * of crashing when the backend endpoint isn't ready yet.
 * ------------------------------------------------------------------ */

const POLL_INTERVAL_MS = 30_000;
const COMMIT_PREVIEW_COUNT = 8;
const COMMIT_EXPANDED_COUNT = 20;

export function GitPanel() {
  const { t } = useTranslation();
  const gitStatus = useAppStore((s) => s.gitStatus);
  const loading = useAppStore((s) => s.gitStatusLoading);
  const error = useAppStore((s) => s.gitStatusError);
  const refreshGitStatus = useAppStore((s) => s.refreshGitStatus);
  const setRightPanelTab = useAppStore((s) => s.setRightPanelTab);
  const activeWorkspace = useAppStore((s) => s.activeWorkspace);

  const [diffOpen, setDiffOpen] = React.useState(false);
  const [diffLoading, setDiffLoading] = React.useState(false);
  const [diffText, setDiffText] = React.useState("");
  const [worktreeDialogOpen, setWorktreeDialogOpen] = React.useState(false);
  const [showAllCommits, setShowAllCommits] = React.useState(false);

  // Initial load + 30s poll. We always poll while the panel is
  // mounted — the store dedupes concurrent requests and the top-bar
  // poller also writes to the same field, so duplicate renders are
  // cheap.
  React.useEffect(() => {
    void refreshGitStatus();
    const id = window.setInterval(() => {
      void refreshGitStatus();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [refreshGitStatus]);

  const handleRefresh = () => {
    void refreshGitStatus();
  };

  const handleViewDiff = async () => {
    setDiffOpen(true);
    setDiffLoading(true);
    try {
      const res = await apiGet<{
        isRepo: boolean;
        diff: { files: Array<{ path: string; patch: string }> };
      }>("/api/git/diff").catch(() => null);
      if (res?.diff?.files?.length) {
        setDiffText(res.diff.files.map((f) => f.patch).join("\n"));
      } else {
        setDiffText("");
      }
    } catch (e) {
      setDiffText("");
      if (e instanceof ApiRequestError && !(e.status === 404 || e.status === 405)) {
        toast.error(e.message);
      }
    } finally {
      setDiffLoading(false);
    }
  };

  const handleCheckout = async (branch: string) => {
    try {
      await apiPost("/api/git/checkout", { branch });
      toast.success(t("checked_out_branch", { branch }));
      void refreshGitStatus();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("branch_failed"));
    }
  };

  const handleAddWorktree = async (branch: string, path: string) => {
    try {
      await apiPost("/api/git/worktree", { branch, path });
      toast.success(t("worktree_added", { path }));
      void refreshGitStatus();
    } catch (e) {
      if (e instanceof ApiRequestError && (e.status === 404 || e.status === 405)) {
        toast.error(t("worktree_not_available"));
      } else {
        toast.error(e instanceof Error ? e.message : t("failed_add_worktree"));
      }
    }
  };

  const handleRemoveWorktree = async (path: string) => {
    try {
      // DELETE /api/git/worktree?path=<path> — the backend exposes removal
      // via the DELETE verb with a `path` query parameter (force=1 optional).
      await apiDelete(
        `/api/git/worktree?path=${encodeURIComponent(path)}`,
      );
      toast.success(t("worktree_removed"));
      void refreshGitStatus();
    } catch (e) {
      if (e instanceof ApiRequestError && (e.status === 404 || e.status === 405)) {
        toast.error(t("worktree_not_available"));
      } else {
        toast.error(e instanceof Error ? e.message : t("failed_remove_worktree"));
      }
    }
  };

  const handleFileClick = (path: string) => {
    // Open the file in the Files tab (the workspace panel listens for
    // `hermos:open-file` events).
    window.dispatchEvent(
      new CustomEvent("hermos:open-file", { detail: { path } }),
    );
    setRightPanelTab("files");
  };

  const isRepo = !!gitStatus?.isRepo;
  const staged = gitStatus?.staged ?? [];
  const modified = gitStatus?.modified ?? [];
  const untracked = gitStatus?.untracked ?? [];
  const commits = gitStatus?.commits ?? [];
  const branches = gitStatus?.branches ?? [];
  const worktrees = gitStatus?.worktrees ?? [];
  const totalChanges = staged.length + modified.length + untracked.length;
  const visibleCommits = showAllCommits
    ? commits.slice(0, COMMIT_EXPANDED_COUNT)
    : commits.slice(0, COMMIT_PREVIEW_COUNT);

  return (
    <div className="flex h-full flex-col bg-card">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-3 py-2">
        <div className="flex items-center gap-2">
          <GitBranch className="size-4 text-brand" />
          <span className="text-sm font-medium">{t("git")}</span>
          {isRepo && (
            <Badge
              variant="outline"
              className="h-4 px-1 text-[9px] font-mono text-brand border-brand/40 bg-brand/5"
            >
              {gitStatus?.branch || "HEAD"}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="sm"
                variant="ghost"
                className="size-7 p-0"
                onClick={handleRefresh}
                aria-label={t("refresh_git_status")}
                disabled={loading}
              >
                <RefreshCw
                  className={cn("size-3.5", loading && "animate-spin")}
                />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t("refresh")}</TooltipContent>
          </Tooltip>
          {isRepo && (
            <Button
              size="sm"
              className="h-7 gap-1 text-[11px] bg-brand text-brand-foreground hover:bg-brand/90"
              onClick={() => void handleViewDiff()}
              aria-label={t("view_full_diff")}
            >
              <FilePen className="size-3" />
              {t("view_diff")}
            </Button>
          )}
        </div>
      </div>

      <ScrollArea className="flex-1 min-h-0">
        {/* Loading state — only when there's no cached status yet. */}
        {loading && !gitStatus ? (
          <GitSkeleton />
        ) : error && !gitStatus ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
            <AlertTriangle className="size-5 text-amber-500" />
            <p className="text-xs text-amber-600 dark:text-amber-400">{error}</p>
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1 text-xs"
              onClick={handleRefresh}
            >
              <RefreshCw className="size-3" />
              {t("retry")}
            </Button>
          </div>
        ) : !isRepo ? (
          <NotARepoState />
        ) : (
          <div className="p-2 space-y-3">
            {/* Status summary */}
            <StatusSummary
              branch={gitStatus?.branch ?? ""}
              ahead={gitStatus?.ahead ?? 0}
              behind={gitStatus?.behind ?? 0}
              totalChanges={totalChanges}
              clean={totalChanges === 0}
            />

            {/* File lists */}
            <FileListSection
              title={t("git_staged")}
              files={staged}
              dotColor="bg-brand"
              emptyHint={t("git_no_staged")}
              onFileClick={handleFileClick}
              defaultOpen
            />
            <FileListSection
              title={t("git_modified")}
              files={modified}
              dotColor="bg-amber-500"
              emptyHint={t("git_no_modified")}
              onFileClick={handleFileClick}
              defaultOpen
            />
            <FileListSection
              title={t("git_untracked")}
              files={untracked}
              dotColor="bg-muted-foreground/50"
              emptyHint={t("git_no_untracked")}
              onFileClick={handleFileClick}
              defaultOpen={untracked.length > 0}
            />

            {/* Commits */}
            {commits.length > 0 && (
              <Section title={t("git_commits")} icon={GitCommitIcon}>
                <ul className="space-y-0.5">
                  {visibleCommits.map((c) => (
                    <CommitRow key={c.hash} commit={c} />
                  ))}
                </ul>
                {commits.length > COMMIT_PREVIEW_COUNT && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="mt-1 h-6 w-full justify-center text-[11px]"
                    onClick={() => setShowAllCommits((v) => !v)}
                  >
                    {showAllCommits
                      ? t("git_show_fewer")
                      : t("git_view_full_log", { count: commits.length })}
                  </Button>
                )}
              </Section>
            )}

            {/* Branches */}
            {branches.length > 0 && (
              <Section title={t("git_branches")} icon={GitBranch}>
                <ul className="space-y-0.5">
                  {branches.map((b) => (
                    <BranchRow
                      key={b.name}
                      branch={b}
                      onCheckout={() => void handleCheckout(b.name)}
                    />
                  ))}
                </ul>
              </Section>
            )}

            {/* Worktrees */}
            {worktrees.length > 0 && (
              <Section title={t("git_worktrees")} icon={ListTree}>
                <ul className="space-y-0.5">
                  {worktrees.map((w) => (
                    <WorktreeRow
                      key={w.path}
                      worktree={w}
                      onRemove={() => void handleRemoveWorktree(w.path)}
                    />
                  ))}
                </ul>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-1 h-7 w-full justify-center gap-1 text-[11px]"
                  onClick={() => setWorktreeDialogOpen(true)}
                >
                  <Plus className="size-3" />
                  {t("add_worktree")}
                </Button>
              </Section>
            )}
          </div>
        )}
      </ScrollArea>

      {/* Diff dialog */}
      <Dialog open={diffOpen} onOpenChange={setDiffOpen}>
        <DialogContent className="sm:max-w-4xl max-h-[85vh] h-[80vh] flex flex-col p-0 overflow-hidden">
          <DialogHeader className="px-5 py-4 border-b shrink-0">
            <DialogTitle>{t("working_tree_diff")}</DialogTitle>
            <DialogDescription>
              {totalChanges > 0
                ? `${totalChanges} change${totalChanges === 1 ? "" : "s"} across ${
                    new Set([
                      ...staged.map((f) => f.path),
                      ...modified.map((f) => f.path),
                      ...untracked.map((f) => f.path),
                    ]).size
                  } file${totalChanges === 1 ? "" : "s"}.`
                : t("working_tree_clean")}
            </DialogDescription>
          </DialogHeader>
          <div className="flex-1 min-h-0 p-4 overflow-hidden">
            {diffLoading ? (
              <div className="flex h-full items-center justify-center rounded-md border bg-card p-8 text-xs text-muted-foreground">
                <Loader2 className="me-2 size-4 animate-spin" />
                {t("loading_diff")}…
              </div>
            ) : (
              <GitDiffView diff={diffText} className="h-full" />
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Add worktree dialog */}
      <WorktreeDialog
        open={worktreeDialogOpen}
        onOpenChange={setWorktreeDialogOpen}
        onSubmit={async (branch, path) => {
          await handleAddWorktree(branch, path);
          setWorktreeDialogOpen(false);
        }}
      />
    </div>
  );
}

/* ------------------------------ Summary ------------------------------ */

function StatusSummary({
  branch,
  ahead,
  behind,
  totalChanges,
  clean,
}: {
  branch: string;
  ahead: number;
  behind: number;
  totalChanges: number;
  clean: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="rounded-md border bg-background/60 p-2.5 space-y-1.5">
      <div className="flex items-center gap-2">
        <GitBranch className="size-3.5 shrink-0 text-brand" />
        <span
          className="font-mono text-xs text-brand truncate"
          title={branch}
        >
          {branch || "HEAD detached"}
        </span>
        {(ahead > 0 || behind > 0) && (
          <div className="ms-auto flex items-center gap-1">
            {ahead > 0 && (
              <Badge
                variant="outline"
                className="h-4 px-1 text-[9px] font-mono text-brand border-brand/40"
              >
                ↑{ahead}
              </Badge>
            )}
            {behind > 0 && (
              <Badge
                variant="outline"
                className="h-4 px-1 text-[9px] font-mono text-amber-700 dark:text-amber-400 border-amber-500/40"
              >
                ↓{behind}
              </Badge>
            )}
          </div>
        )}
      </div>
      <Separator />
      {clean ? (
        <div className="flex items-center gap-1.5 text-xs text-brand">
          <Check className="size-3" />
          <span>{t("working_tree_clean")}</span>
        </div>
      ) : (
        <div className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400">
          <AlertTriangle className="size-3" />
          <span>
            {t("changes_to_review", { count: totalChanges })}
          </span>
        </div>
      )}
    </div>
  );
}

/* ------------------------------ File list ------------------------------ */

function FileListSection({
  title,
  files,
  dotColor,
  emptyHint,
  onFileClick,
  defaultOpen,
}: {
  title: string;
  files: GitFileChange[];
  dotColor: string;
  emptyHint: string;
  onFileClick: (path: string) => void;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = React.useState(defaultOpen ?? true);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-start text-[11px] font-semibold uppercase tracking-wider text-muted-foreground hover:bg-accent/40 transition-colors"
          aria-label={`${open ? "Collapse" : "Expand"} ${title} section`}
        >
          {open ? (
            <ChevronDown className="size-3" />
          ) : (
            <ChevronRight className="size-3" />
          )}
          <span>{title}</span>
          <Badge
            variant="secondary"
            className="ms-1 h-4 min-w-4 px-1 text-[9px] font-mono tabular-nums"
          >
            {files.length}
          </Badge>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        {files.length === 0 ? (
          <div className="px-2 py-1.5 text-[11px] text-muted-foreground/70">
            {emptyHint}
          </div>
        ) : (
          <ul className="mt-0.5 space-y-0">
            {files.map((f) => (
              <FileRow
                key={f.path}
                file={f}
                dotColor={dotColor}
                onClick={() => onFileClick(f.path)}
              />
            ))}
          </ul>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

function FileRow({
  file,
  dotColor,
  onClick,
}: {
  file: GitFileChange;
  dotColor: string;
  onClick: () => void;
}) {
  const StatusIcon =
    file.status === "A"
      ? FilePlus
      : file.status === "D"
        ? FileMinus
        : file.status === "R"
          ? ArrowRightLeft
          : FilePen;
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className="group flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-start hover:bg-accent/50 transition-colors"
        title={file.path}
      >
        <span className={cn("size-1.5 shrink-0 rounded-full", dotColor)} />
        <StatusIcon
          className={cn(
            "size-3 shrink-0",
            file.status === "A" && "text-emerald-600 dark:text-emerald-400",
            file.status === "D" && "text-red-600 dark:text-red-400",
            file.status === "R" && "text-amber-600 dark:text-amber-400",
            (file.status === "M" || file.status === "U") &&
              "text-amber-600 dark:text-amber-400",
            file.status === "?" && "text-muted-foreground",
          )}
        />
        <span
          className="flex-1 min-w-0 truncate font-mono text-[11px] text-foreground/90"
          title={file.path}
        >
          {file.path}
          {file.oldPath && (
            <span className="text-muted-foreground"> (from {file.oldPath})</span>
          )}
        </span>
        <span className="shrink-0 text-[9px] font-mono uppercase text-muted-foreground">
          {file.status === "?" ? "U" : file.status}
        </span>
      </button>
    </li>
  );
}

/* ------------------------------ Commit ------------------------------ */

function CommitRow({ commit }: { commit: GitCommit }) {
  const dateLabel = React.useMemo(() => {
    if (!commit.date) return null;
    try {
      return formatDistanceToNow(new Date(commit.date), { addSuffix: true });
    } catch {
      return null;
    }
  }, [commit.date]);

  return (
    <li className="flex items-start gap-1.5 rounded-md px-2 py-1 hover:bg-accent/40 transition-colors">
      <span
        className="mt-0.5 shrink-0 rounded bg-brand/10 px-1 py-px font-mono text-[9px] text-brand"
        title={commit.hash}
      >
        {commit.shortHash || commit.hash.slice(0, 7)}
      </span>
      <div className="flex-1 min-w-0">
        <div
          className="truncate text-[11px] text-foreground/90"
          title={commit.message}
        >
          {commit.message}
        </div>
        {(commit.author || dateLabel) && (
          <div className="text-[9px] text-muted-foreground tabular-nums">
            {[commit.author, dateLabel].filter(Boolean).join(" · ")}
          </div>
        )}
      </div>
    </li>
  );
}

/* ------------------------------ Branch ------------------------------ */

function BranchRow({
  branch,
  onCheckout,
}: {
  branch: GitBranchInfo;
  onCheckout: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={branch.current ? undefined : onCheckout}
        disabled={branch.current}
        className={cn(
          "flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-start text-[11px] transition-colors",
          branch.current
            ? "bg-brand/5 text-brand cursor-default"
            : "hover:bg-accent/50",
        )}
        title={
          branch.current
            ? `Current branch${branch.upstream ? ` · tracks ${branch.upstream}` : ""}`
            : `Checkout ${branch.name}`
        }
      >
        <GitBranch
          className={cn(
            "size-3 shrink-0",
            branch.current ? "text-brand" : "text-muted-foreground",
          )}
        />
        <span
          className={cn(
            "flex-1 min-w-0 truncate font-mono",
            branch.current ? "font-medium" : "text-foreground/90",
          )}
        >
          {branch.name}
        </span>
        {branch.current ? (
          <Check className="size-3 text-brand" />
        ) : (
          (branch.ahead ?? 0) > 0 && (
            <span className="text-[9px] font-mono text-brand">↑{branch.ahead}</span>
          )
        )}
      </button>
    </li>
  );
}

/* ------------------------------ Worktree ------------------------------ */

function WorktreeRow({
  worktree,
  onRemove,
}: {
  worktree: GitWorktree;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  return (
    <li className="flex items-center gap-1.5 rounded-md px-2 py-1 hover:bg-accent/40 transition-colors">
      <ListTree
        className={cn(
          "size-3 shrink-0",
          worktree.isMain ? "text-brand" : "text-muted-foreground",
        )}
      />
      <div className="flex-1 min-w-0">
        <div
          className="truncate font-mono text-[11px] text-foreground/90"
          title={worktree.path}
        >
          {worktree.path}
        </div>
        <div className="text-[9px] text-muted-foreground tabular-nums">
          {worktree.branch}
          {worktree.isMain && " · main"}
        </div>
      </div>
      {!worktree.isMain && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="size-6 p-0 hover:text-destructive"
              onClick={onRemove}
              aria-label={t("remove_worktree")}
            >
              <Trash2 className="size-3" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left">{t("remove_worktree")}</TooltipContent>
        </Tooltip>
      )}
    </li>
  );
}

/* ------------------------------ Section ------------------------------ */

function Section({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon: React.ElementType;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5 px-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        <Icon className="size-3" />
        {title}
      </div>
      {children}
    </div>
  );
}

/* ------------------------------ Not a repo ------------------------------ */

function NotARepoState() {
  const { t } = useTranslation();
  const [copied, setCopied] = React.useState(false);
  const setRightPanelTab = useAppStore((s) => s.setRightPanelTab);
  const cmd = "git init";
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(cmd);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
      toast.success(t("copied_to_clipboard"));
    } catch {
      toast.error(t("couldnt_copy"));
    }
  };
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <div className="rounded-full border border-dashed border-border/80 p-3">
        <GitGraph className="size-6 text-muted-foreground/60" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium">{t("not_a_git_repo")}</p>
        <p className="text-[11px] text-muted-foreground max-w-[240px]">
          {t("not_a_git_repo_desc")}
        </p>
      </div>
      <div className="flex items-center gap-2 rounded-md border bg-background/60 px-2 py-1.5">
        <code className="font-mono text-[11px] text-foreground/80">{cmd}</code>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-2 text-[11px]"
          onClick={copy}
        >
          {copied ? (
            <>
              <Check className="size-3 text-brand" /> {t("copied")}
            </>
          ) : (
            <>
              <Copy className="size-3" /> {t("copy")}
            </>
          )}
        </Button>
      </div>
      <Button
        variant="outline"
        size="sm"
        className="h-7 gap-1 text-[11px]"
        onClick={() => setRightPanelTab("terminal")}
      >
        <ExternalLink className="size-3" />
        {t("open_terminal")}
      </Button>
    </div>
  );
}

/* ------------------------------ Worktree dialog ------------------------------ */

function WorktreeDialog({
  open,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSubmit: (branch: string, path: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [branch, setBranch] = React.useState("");
  const [path, setPath] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setBranch("");
      setPath("");
    }
  }, [open]);

  const submit = async () => {
    const b = branch.trim();
    const p = path.trim();
    if (!b || !p) return;
    setSubmitting(true);
    try {
      await onSubmit(b, p);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("add_worktree")}</DialogTitle>
          <DialogDescription>
            {t("add_worktree_desc")}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="wt-branch" className="text-xs">
              {t("branch_name")}
            </Label>
            <Input
              id="wt-branch"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              placeholder="feature/new-thing"
              className="h-8 text-xs"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") void submit();
              }}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="wt-path" className="text-xs">
              {t("path")}
            </Label>
            <Input
              id="wt-path"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="../my-project-feature"
              className="h-8 text-xs font-mono"
              onKeyDown={(e) => {
                if (e.key === "Enter") void submit();
              }}
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            className="h-8"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            {t("cancel")}
          </Button>
          <Button
            size="sm"
            className="h-8 gap-1.5 bg-brand text-brand-foreground hover:bg-brand/90"
            onClick={() => void submit()}
            disabled={submitting || !branch.trim() || !path.trim()}
          >
            {submitting ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Plus className="size-3.5" />
            )}
            {t("add_worktree")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------ Skeleton ------------------------------ */

function GitSkeleton() {
  return (
    <div className="p-2 space-y-2">
      <div className="h-16 rounded-md bg-accent/40 animate-pulse" />
      <div className="h-6 rounded-md bg-accent/40 animate-pulse" />
      <div className="h-6 rounded-md bg-accent/40 animate-pulse" />
      <div className="h-6 rounded-md bg-accent/40 animate-pulse" />
      <div className="h-24 rounded-md bg-accent/40 animate-pulse" />
    </div>
  );
}
