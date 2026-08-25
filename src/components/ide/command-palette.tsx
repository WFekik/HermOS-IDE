"use client";

import * as React from "react";
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useCommandState } from "cmdk";
import {
  MessageSquare,
  Plus,
  Settings as SettingsIcon,
  Plug,
  Puzzle,
  Terminal as TerminalIcon,
  Sun,
  Moon,
  Monitor,
  FileText,
  FileCode,
  Braces,
  FileImage,
  FileCog,
  Hash,
  Clock,
  Search,
  ListTree,
  Globe,
} from "lucide-react";
import { useAppStore } from "@/stores/app-store";
import { useTheme } from "@/components/theme/theme-provider";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import { apiGet, ApiRequestError } from "@/lib/api-client";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { fileNameIconKind, type FileNameIconKind } from "@/lib/tool-ui-shared";
import type { ConversationDTO } from "@/lib/types";

/* ------------------------------------------------------------------ *
 * Module-level workspace tree cache.
 *
 * Fetched once per workspace (when the palette is first opened) and
 * reused for subsequent opens. The cache records which workspace it was
 * fetched for; when the palette opens again under a DIFFERENT active
 * workspace, `fetchTreeFiles` invalidates it and refetches.
 * ------------------------------------------------------------------ */

interface FlatFile {
  /** Path relative to workspace root, e.g. "src/components/math.ts". */
  path: string;
  /** Just the file name, e.g. "math.ts". */
  name: string;
}

interface TreeCache {
  workspaceId: string;
  workspaceName: string;
  files: FlatFile[];
}

let treeCache: TreeCache | null = null;
let treeFetchInFlight: Promise<FlatFile[]> | null = null;

interface FileNodeShape {
  name: string;
  path: string;
  type: "file" | "dir";
  children?: FileNodeShape[];
}

function flattenFiles(nodes: FileNodeShape[], acc: FlatFile[] = []): FlatFile[] {
  for (const n of nodes) {
    if (n.type === "file") {
      acc.push({ path: n.path, name: n.name });
    } else if (n.type === "dir" && n.children) {
      flattenFiles(n.children, acc);
    }
  }
  return acc;
}

async function fetchTreeFiles(): Promise<FlatFile[]> {
  if (treeCache) {
    // The palette refetches its file list on every open, so this is the
    // invalidation point: if the active workspace changed since the cache
    // was filled, drop it (unknown ids are kept — conservative, matches
    // the old never-invalidate behavior).
    const wsId = useAppStore.getState().activeWorkspace?.id ?? null;
    if (wsId && treeCache.workspaceId && treeCache.workspaceId !== wsId) {
      invalidateCommandPaletteTreeCache();
    } else {
      return treeCache.files;
    }
  }
  if (treeFetchInFlight) return treeFetchInFlight;
  treeFetchInFlight = (async () => {
    try {
      const res = await apiGet<{ workspace: { id: string; name: string }; tree: FileNodeShape[] }>(
        "/api/workspace/tree",
      );
      const files = flattenFiles(res?.tree ?? []);
      treeCache = {
        workspaceId: res?.workspace?.id ?? "",
        workspaceName: res?.workspace?.name ?? "workspace",
        files,
      };
      return files;
    } finally {
      treeFetchInFlight = null;
    }
  })();
  return treeFetchInFlight;
}

/** Clear the cached workspace tree (called on workspace change; also exported for tests). */
export function invalidateCommandPaletteTreeCache() {
  treeCache = null;
  treeFetchInFlight = null;
}

/* ------------------------------------------------------------------ *
 * Recent-files memory (localStorage, last 5).
 * ------------------------------------------------------------------ */

const RECENT_FILES_KEY = "hermos:recent-files";
const MAX_RECENT = 5;

function loadRecentFiles(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(RECENT_FILES_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x): x is string => typeof x === "string" && x.length > 0)
      .slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}

function pushRecentFile(path: string): string[] {
  if (typeof window === "undefined") return [];
  const current = loadRecentFiles();
  const next = [path, ...current.filter((p) => p !== path)].slice(0, MAX_RECENT);
  try {
    window.localStorage.setItem(RECENT_FILES_KEY, JSON.stringify(next));
  } catch {
    // ignore quota / private mode errors
  }
  return next;
}

/* ------------------------------------------------------------------ *
 * Open-file event.
 *
 * Dispatched when the user picks a file from the palette. The workspace
 * panel may listen for it; in any case we also switch to the Files tab
 * so the user lands in the right place.
 * ------------------------------------------------------------------ */

function dispatchOpenFile(path: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<{ path: string }>("hermos:open-file", { detail: { path } }),
  );
}

/* ------------------------------------------------------------------ *
 * Fuzzy matcher.
 *
 * Scores `query` against `text` by character-sequence (subsequence)
 * matching with bonuses for word boundaries, consecutive matches, and
 * exact-case matches. Returns the matched character indices so the UI
 * can highlight them. Returns null when the query isn't a subsequence.
 *
 * The score is tuned so that:
 *  - exact substring matches score very high (they winnow to the top),
 *  - word-boundary matches (e.g. "nc" matching "New conversation" at
 *    the N and the c) score next,
 *  - loose subsequence matches (e.g. "ncv" matching "New conversation")
 *    score lower but still rank above non-matches.
 * ------------------------------------------------------------------ */

interface FuzzyResult {
  score: number;
  indices: number[];
}

function fuzzyMatch(text: string, query: string): FuzzyResult | null {
  if (!query) return { score: 1, indices: [] };
  const t = text;
  const q = query;
  let qi = 0;
  let ti = 0;
  let score = 0;
  let consecutive = 0;
  const indices: number[] = [];
  const isAlnum = (c: string) => /[a-z0-9]/i.test(c);
  while (qi < q.length && ti < t.length) {
    if (q[qi].toLowerCase() === t[ti].toLowerCase()) {
      indices.push(ti);
      // Word-boundary bonus: previous char is non-alphanumeric or BOF.
      const prevChar = ti > 0 ? t[ti - 1] : " ";
      const isBoundary = !isAlnum(prevChar) || ti === 0;
      if (isBoundary) score += 10;
      // Consecutive-match bonus (compounds for longer runs).
      if (consecutive > 0) score += 3 + consecutive;
      consecutive += 1;
      // Exact-case bonus (the original chars match, not just lowercased).
      if (q[qi] === t[ti]) score += 2;
      qi++;
    } else {
      consecutive = 0;
    }
    ti++;
  }
  if (qi < q.length) return null; // not all query chars matched
  // Penalty for leading gaps (first match far into the text). Caps so
  // a long text with a late first match isn't over-penalized.
  if (indices.length > 0) {
    score -= Math.min(15, indices[0] * 0.4);
  }
  // Bonus for matching the whole query as a contiguous substring (the
  // text contains the query verbatim). This makes exact substring
  // matches winnow to the top, above fuzzy matches.
  const lowerT = t.toLowerCase();
  const lowerQ = q.toLowerCase();
  if (lowerT.includes(lowerQ)) {
    score += 50;
    // Extra bonus when the substring starts at a word boundary.
    const idx = lowerT.indexOf(lowerQ);
    const prev = idx > 0 ? t[idx - 1] : " ";
    if (!isAlnum(prev) || idx === 0) score += 15;
  }
  return { score, indices };
}

/**
 * cmdk-compatible filter. Returns a rank (0 = hide, higher = better).
 * cmdk sorts items by rank descending. We compute the matched indices
 * separately in <HighlightedText/> for the emerald highlight (cmdk's
 * filter signature only returns a rank, not indices).
 */
function fuzzyFilter(value: string, search: string): number {
  const res = fuzzyMatch(value, search);
  if (!res) return 0;
  return res.score;
}

/* ------------------------------------------------------------------ *
 * Highlighted text — renders `text` with the characters at `indices`
 * highlighted in emerald. Used for fuzzy-match highlighting in the
 * command palette items.
 * ------------------------------------------------------------------ */

function HighlightedText({
  text,
  query,
}: {
  text: string;
  query: string;
}) {
  const indices = React.useMemo(() => {
    if (!query) return new Set<number>();
    const res = fuzzyMatch(text, query);
    if (!res) return new Set<number>();
    return new Set(res.indices);
  }, [text, query]);

  if (indices.size === 0) return <>{text}</>;

  const out: React.ReactNode[] = [];
  for (let i = 0; i < text.length; i++) {
    if (indices.has(i)) {
      out.push(
        <span key={i} className="text-brand font-medium">
          {text[i]}
        </span>,
      );
    } else {
      out.push(<span key={i}>{text[i]}</span>);
    }
  }
  return <>{out}</>;
}

/* ------------------------------------------------------------------ *
 * Command palette
 * ------------------------------------------------------------------ */

export function CommandPalette() {
  const open = useAppStore((s) => s.commandOpen);
  const setOpen = useAppStore((s) => s.setCommandOpen);

  const close = () => setOpen(false);

  // ⌘K is handled by IdeShell's global keydown handler to avoid a
  // duplicate handler that would toggle the palette closed immediately
  // after the parent opens it.

  // Tab handling: per the spec, Tab "accepts the current query as a
  // filter only (doesn't select)". cmdk's default Tab cycles the active
  // item; we preventDefault so Tab is a pure no-op (the query stays as
  // the filter, no item is selected, no navigation happens). The user
  // can then use arrow keys + Enter to pick.
  const handleKeyDown = React.useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Tab") {
      e.preventDefault();
    }
  }, []);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogHeader className="sr-only">
        <DialogTitle>Command Palette</DialogTitle>
        <DialogDescription>
          Search for a command to run, or type a query to filter files
          and conversations.
        </DialogDescription>
      </DialogHeader>
      <DialogContent className="overflow-hidden p-0" showCloseButton>
        <Command
          className="[&_[cmdk-group-heading]]:text-muted-foreground **:data-[slot=command-input-wrapper]:h-12 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group]]:px-2 [&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0 [&_[cmdk-input-wrapper]_svg]:h-5 [&_[cmdk-input-wrapper]_svg]:w-5 [&_[cmdk-input]]:h-12 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-3 [&_[cmdk-item]_svg]:h-5 [&_[cmdk-item]_svg]:w-5"
          filter={fuzzyFilter}
          onKeyDown={handleKeyDown}
        >
          <CommandInput placeholder="Type a command or search files, conversations…" />
          <CommandList>
            <CommandEmpty>No results found.</CommandEmpty>

            <RecentGroup close={close} />
            <ActionsGroup close={close} />
            <ConversationsGroup close={close} />
            <FilesGroup close={close} />
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ *
 * Recent commands group — shows the last 5 commands the user ran, with
 * a Clock icon. Only rendered when no query is typed (so it doesn't
 * duplicate the items in their normal groups).
 * ------------------------------------------------------------------ */

interface RecentCommand {
  id: string;
  label: string;
  icon: React.ElementType;
  /** Re-run the command. Called when the user picks the recent item. */
  run: () => void;
}

function RecentGroup({ close }: { close: () => void }) {
  const search = useCommandState((s) => s.search) as string;
  const recentCommands = useAppStore((s) => s.recentCommands);

  // The registry of known command ids → {label, icon, run}. We build it
  // here (rather than inside ActionsGroup) so the recent items can
  // re-run their original command without duplicating the action logic.
  const registry = useRecentCommandRegistry(close);

  // Don't render the Recent group when the user has typed a query — the
  // matching items appear in their normal groups and the Recent header
  // would just be noise.
  if (search.trim()) return null;
  if (recentCommands.length === 0) return null;

  const items: RecentCommand[] = [];
  for (const id of recentCommands) {
    const cmd = registry.get(id);
    if (cmd) items.push(cmd);
  }
  if (items.length === 0) return null;

  return (
    <>
      <CommandGroup heading="Recent">
        {items.map((cmd) => (
          <CommandItem
            key={`recent-${cmd.id}`}
            value={`recent ${cmd.label} ${cmd.id}`}
            onSelect={() => {
              cmd.run();
            }}
          >
            <Clock className="size-4 text-muted-foreground" />
            <span>{cmd.label}</span>
          </CommandItem>
        ))}
      </CommandGroup>
      <CommandSeparator />
    </>
  );
}

/**
 * Build a registry of known command ids → {label, icon, run}. The `run`
 * function re-executes the command and closes the palette. Used by the
 * Recent group to re-run a previously-executed command.
 */
function useRecentCommandRegistry(close: () => void): Map<string, RecentCommand> {
  const createConversation = useAppStore((s) => s.createConversation);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const setSettingsTab = useAppStore((s) => s.setSettingsTab);
  const setRightPanelTab = useAppStore((s) => s.setRightPanelTab);
  const setFindInFilesOpen = useAppStore((s) => s.setFindInFilesOpen);
  const { setTheme } = useTheme();

  return React.useMemo(() => {
    const m = new Map<string, RecentCommand>();
    m.set("new-conversation", {
      id: "new-conversation",
      label: "New conversation",
      icon: Plus,
      run: async () => {
        await createConversation();
        toast.success("New conversation");
        close();
      },
    });
    m.set("find-in-files", {
      id: "find-in-files",
      label: "Find in files",
      icon: Search,
      run: () => {
        setFindInFilesOpen(true);
        close();
      },
    });
    m.set("go-to-line", {
      id: "go-to-line",
      label: "Go to line",
      icon: Hash,
      run: () => {
        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent("hermos:go-to-line"));
        }
        close();
      },
    });
    m.set("open-settings", {
      id: "open-settings",
      label: "Open settings",
      icon: SettingsIcon,
      run: () => {
        setSettingsTab("providers");
        setSettingsOpen(true);
        close();
      },
    });
    const panelCmd = (
      id: string,
      label: string,
      icon: React.ElementType,
      tab: Parameters<typeof setRightPanelTab>[0],
    ): RecentCommand => ({
      id,
      label,
      icon,
      run: () => {
        setRightPanelTab(tab);
        close();
      },
    });
    const panelCmds: RecentCommand[] = [
      panelCmd("panel:outline", "Outline panel", ListTree, "outline"),
      panelCmd("panel:mcp", "MCP servers", Plug, "mcp"),
      panelCmd("panel:plugins", "Plugins", Puzzle, "plugins"),
      panelCmd("panel:terminal", "Terminal", TerminalIcon, "terminal"),
      panelCmd("panel:browser", "Browser preview", Globe, "browser"),
      panelCmd("panel:files", "Files", FileText, "files"),
    ];
    for (const cmd of panelCmds) m.set(cmd.id, cmd);
    m.set("theme:light", {
      id: "theme:light",
      label: "Theme: Light",
      icon: Sun,
      run: () => {
        setTheme("light");
        close();
      },
    });
    m.set("theme:dark", {
      id: "theme:dark",
      label: "Theme: Dark",
      icon: Moon,
      run: () => {
        setTheme("dark");
        close();
      },
    });
    m.set("theme:system", {
      id: "theme:system",
      label: "Theme: System",
      icon: Monitor,
      run: () => {
        setTheme("system");
        close();
      },
    });
    return m;
  }, [createConversation, setSettingsOpen, setSettingsTab, setRightPanelTab, setFindInFilesOpen, setTheme, close]);
}

/* ------------------------------------------------------------------ *
 * Actions group — existing commands. Each command's onSelect now also
 * pushes its stable id onto the recent-commands list.
 * ------------------------------------------------------------------ */

function ActionsGroup({ close }: { close: () => void }) {
  const createConversation = useAppStore((s) => s.createConversation);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const setSettingsTab = useAppStore((s) => s.setSettingsTab);
  const setRightPanelTab = useAppStore((s) => s.setRightPanelTab);
  const setFindInFilesOpen = useAppStore((s) => s.setFindInFilesOpen);
  const pushRecentCommand = useAppStore((s) => s.pushRecentCommand);
  const search = useCommandState((s) => s.search) as string;
  const { setTheme } = useTheme();

  const q = search.trim();

  return (
    <>
      <CommandGroup heading="Actions">
        <CommandItem
          value="action new conversation create ⌘N"
          onSelect={async () => {
            pushRecentCommand("new-conversation");
            await createConversation();
            toast.success("New conversation");
            close();
          }}
        >
          <Plus className="size-4" />
          <HighlightedText text="New conversation" query={q} />
          <CommandShortcut>⌘N</CommandShortcut>
        </CommandItem>
        <CommandItem
          value="action find in files search grep ⌘⇧F"
          onSelect={() => {
            pushRecentCommand("find-in-files");
            setFindInFilesOpen(true);
            close();
          }}
        >
          <Search className="size-4" />
          <HighlightedText text="Find in files" query={q} />
          <CommandShortcut>⌘⇧F</CommandShortcut>
        </CommandItem>
        <CommandItem
          value="action go to line ⌘L"
          onSelect={() => {
            pushRecentCommand("go-to-line");
            if (typeof window !== "undefined") {
              window.dispatchEvent(new CustomEvent("hermos:go-to-line"));
            }
            close();
          }}
        >
          <Hash className="size-4" />
          <HighlightedText text="Go to line" query={q} />
          <CommandShortcut>⌘L</CommandShortcut>
        </CommandItem>
        <CommandItem
          value="action open settings preferences"
          onSelect={() => {
            pushRecentCommand("open-settings");
            setSettingsTab("providers");
            setSettingsOpen(true);
            close();
          }}
        >
          <SettingsIcon className="size-4" />
          <HighlightedText text="Open settings" query={q} />
        </CommandItem>
      </CommandGroup>

      <CommandSeparator />

      <CommandGroup heading="Right panel">
        <CommandItem
          value="panel outline symbols"
          onSelect={() => {
            pushRecentCommand("panel:outline");
            setRightPanelTab("outline");
            close();
          }}
        >
          <ListTree className="size-4" />
          <HighlightedText text="Outline" query={q} />
        </CommandItem>
        <CommandItem
          value="panel mcp servers"
          onSelect={() => {
            pushRecentCommand("panel:mcp");
            setRightPanelTab("mcp");
            close();
          }}
        >
          <Plug className="size-4" />
          <HighlightedText text="MCP servers" query={q} />
        </CommandItem>
        <CommandItem
          value="panel plugins"
          onSelect={() => {
            pushRecentCommand("panel:plugins");
            setRightPanelTab("plugins");
            close();
          }}
        >
          <Puzzle className="size-4" />
          <HighlightedText text="Plugins" query={q} />
        </CommandItem>
        <CommandItem
          value="panel terminal shell"
          onSelect={() => {
            pushRecentCommand("panel:terminal");
            setRightPanelTab("terminal");
            close();
          }}
        >
          <TerminalIcon className="size-4" />
          <HighlightedText text="Terminal" query={q} />
        </CommandItem>
        <CommandItem
          value="panel browser preview web"
          onSelect={() => {
            pushRecentCommand("panel:browser");
            setRightPanelTab("browser");
            close();
          }}
        >
          <Globe className="size-4" />
          <HighlightedText text="Browser" query={q} />
        </CommandItem>
      </CommandGroup>

      <CommandSeparator />
      <CommandGroup heading="Theme">
        <CommandItem
          value="theme light mode"
          onSelect={() => {
            pushRecentCommand("theme:light");
            setTheme("light");
            close();
          }}
        >
          <Sun className="size-4" />
          <HighlightedText text="Light" query={q} />
        </CommandItem>
        <CommandItem
          value="theme dark mode"
          onSelect={() => {
            pushRecentCommand("theme:dark");
            setTheme("dark");
            close();
          }}
        >
          <Moon className="size-4" />
          <HighlightedText text="Dark" query={q} />
        </CommandItem>
        <CommandItem
          value="theme system auto"
          onSelect={() => {
            pushRecentCommand("theme:system");
            setTheme("system");
            close();
          }}
        >
          <Monitor className="size-4" />
          <HighlightedText text="System" query={q} />
        </CommandItem>
      </CommandGroup>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Conversations group — uses store.searchConversations (server-side
 * when available, client-side fallback otherwise).
 * ------------------------------------------------------------------ */

function ConversationsGroup({ close }: { close: () => void }) {
  const search = useCommandState((s) => s.search) as string;
  const conversations = useAppStore((s) => s.conversations);
  const selectConversation = useAppStore((s) => s.selectConversation);
  const searchConversations = useAppStore((s) => s.searchConversations);
  const pushRecentCommand = useAppStore((s) => s.pushRecentCommand);

  const [serverResults, setServerResults] = React.useState<ConversationDTO[] | null>(null);
  const [loading, setLoading] = React.useState(false);

  // Reset server results when the palette closes (search clears).
  React.useEffect(() => {
    if (!search.trim()) {
      setServerResults(null);
      setLoading(false);
    }
  }, [search]);

  // Server-side search for queries >=3 chars; fall back to client-side.
  React.useEffect(() => {
    const q = search.trim();
    if (q.length < 3) {
      setServerResults(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    searchConversations(q)
      .then((results) => {
        if (cancelled) return;
        setServerResults(results);
      })
      .catch(() => {
        if (cancelled) return;
        setServerResults(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [search, searchConversations]);

  const items = React.useMemo(() => {
    const sorted = [...conversations].sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
    const q = search.trim();
    if (!q) return sorted.slice(0, 8);
    if (serverResults) {
      const ids = new Set(serverResults.map((c) => c.id));
      return sorted.filter((c) => ids.has(c.id)).slice(0, 8);
    }
    return sorted.filter((c) => c.title.toLowerCase().includes(q.toLowerCase())).slice(0, 8);
  }, [conversations, search, serverResults]);

  if (items.length === 0 && !loading) return null;

  return (
    <>
      <CommandSeparator />
      <CommandGroup
        heading={
          loading
            ? "Conversations · searching…"
            : serverResults
              ? "Conversations · server"
              : "Conversations"
        }
      >
        {items.map((c) => (
          <CommandItem
            key={c.id}
            value={`conv ${c.title} ${c.id}`}
            onSelect={async () => {
              pushRecentCommand("conv:open");
              await selectConversation(c.id);
              close();
            }}
          >
            <MessageSquare className="size-4" />
            <span className="truncate">
              <HighlightedText text={c.title} query={search.trim()} />
            </span>
            <CommandShortcut>
              {formatDistanceToNow(new Date(c.updatedAt), { addSuffix: true })}
            </CommandShortcut>
          </CommandItem>
        ))}
        {items.length === 0 && loading && (
          <CommandItem disabled>
            <span className="text-muted-foreground">Searching…</span>
          </CommandItem>
        )}
      </CommandGroup>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Files group — queries the workspace tree, filters by filename or
 * path. Shows recent files at the top when no query.
 * ------------------------------------------------------------------ */

function FilesGroup({ close }: { close: () => void }) {
  const search = useCommandState((s) => s.search) as string;
  const setRightPanelTab = useAppStore((s) => s.setRightPanelTab);
  const pushRecentCommand = useAppStore((s) => s.pushRecentCommand);

  const [files, setFiles] = React.useState<FlatFile[] | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [recent, setRecent] = React.useState<string[]>([]);

  // Load recent files on mount.
  React.useEffect(() => {
    setRecent(loadRecentFiles());
  }, []);

  // Load the tree lazily; this runs on first mount of the palette body
  // (palette only renders its body when open via the Dialog). The cache
  // is module-level so subsequent opens are instant.
  React.useEffect(() => {
    let cancelled = false;
    fetchTreeFiles()
      .then((f) => {
        if (!cancelled) {
          setFiles(f);
          setLoadError(null);
        }
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        // 401 / network / etc — show subtle empty state.
        const msg =
          e instanceof ApiRequestError ? e.message : "Failed to load workspace files";
        setLoadError(msg);
        setFiles([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handlePick = React.useCallback(
    (path: string) => {
      // Persist to recent-files memory + recent-commands list.
      const next = pushRecentFile(path);
      setRecent(next);
      pushRecentCommand("file:open");
      // Switch to Files tab + dispatch open-file event.
      setRightPanelTab("files");
      dispatchOpenFile(path);
      close();
    },
    [setRightPanelTab, close, pushRecentCommand],
  );

  // Maximum number of files to show in the group. Capped at 10 for
  // render perf and scanability (matching the spec).
  const MAX_FILES = 10;

  // Compute the visible items.
  const visible = React.useMemo(() => {
    if (!files) return null; // still loading
    const q = search.trim();
    if (!q) {
      // No query: show recent files that still exist, then pad with the
      // first few files in the tree.
      const recentExisting = recent
        .map((p) => files.find((f) => f.path === p))
        .filter((x): x is FlatFile => !!x);
      // Deduplicate and pad with the first few files in the tree.
      const seen = new Set(recentExisting.map((f) => f.path));
      const pad = files
        .filter((f) => !seen.has(f.path))
        .slice(0, MAX_FILES - recentExisting.length);
      return {
        items: [...recentExisting, ...pad].slice(0, MAX_FILES),
        isRecent: true,
      };
    }
    // Filter by filename OR path. The cmdk filter already does fuzzy
    // matching on the item's `value` (which includes both the path and
    // the filename), so typing "src/ma" matches `src/math.ts` and
    // "math" matches both `src/math.ts` and `lib/math.ts`. We cap to
    // a generous candidate pool for render perf and let cmdk rank them;
    // the rendered list is sliced to MAX_FILES below.
    return { items: files.slice(0, 60), isRecent: false };
  }, [files, search, recent]);

  // Don't render the group at all while loading the tree on first open
  // (the user is mostly typing action names; the files group appearing
  // a frame later is invisible).
  if (visible === null) return null;
  if (visible.items.length === 0 && loadError) return null;

  // The set of recently-opened file paths (for the emerald "Recent"
  // badge next to each result). Pre-computed for O(1) lookup.
  const recentSet = new Set(recent);

  return (
    <>
      <CommandSeparator />
      <CommandGroup heading={visible.isRecent ? "Files · recent" : "Files"}>
        {visible.items.length === 0 ? (
          <CommandItem disabled value="__no-files__">
            <span className="text-muted-foreground">No matching files</span>
          </CommandItem>
        ) : (
          visible.items.slice(0, MAX_FILES).map((f) => {
            const isRecent = recentSet.has(f.path);
            return (
              <CommandItem
                key={f.path}
                // The value includes both the path and the filename so the
                // cmdk fuzzy filter can match either. The "file " prefix
                // is a stable discriminator so the ArrowRight handler in
                // the parent <Command> can detect "the active item is a
                // file" (we use it to open on ArrowRight).
                value={`file ${f.path} ${f.name}`}
                onSelect={() => handlePick(f.path)}
                // ArrowRight opens the file immediately (the user has
                // navigated to this row and pressed → to commit). This
                // mirrors the behaviour of file-pickers in modern IDEs.
                onKeyDown={(e: React.KeyboardEvent) => {
                  if (e.key === "ArrowRight") {
                    e.preventDefault();
                    handlePick(f.path);
                  }
                }}
              >
                <PaletteFileIcon name={f.name} />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate font-mono text-xs">
                      <HighlightedText text={f.name} query={search.trim()} />
                    </span>
                    {isRecent && (
                      <Badge
                        variant="outline"
                        className="shrink-0 border-brand/40 bg-brand/10 px-1 text-[8px] font-mono uppercase leading-none text-brand"
                        aria-label="Recent file"
                      >
                        Recent
                      </Badge>
                    )}
                  </div>
                  <span className="flex items-center gap-1 text-[10px] font-mono text-muted-foreground/80">
                    <Hash className="size-2.5 opacity-60" />
                    <span className="max-w-[260px] truncate">
                      <HighlightedText text={f.path} query={search.trim()} />
                    </span>
                  </span>
                </div>
              </CommandItem>
            );
          })
        )}
      </CommandGroup>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * PaletteFileIcon — extension-aware file icon for the command palette.
 * Extension matching lives in lib/tool-ui-shared (shared with the file
 * tree); this wrapper renders the palette's own muted styling.
 * ------------------------------------------------------------------ */

const PALETTE_FILE_ICON: Record<FileNameIconKind, React.ElementType> = {
  code: FileCode,
  json: Braces,
  image: FileImage,
  config: FileCog,
  text: FileText,
};

function PaletteFileIcon({ name }: { name: string }) {
  const cls = "size-4 shrink-0 text-muted-foreground";
  const kind = fileNameIconKind(name);
  if (kind === "code") {
    return <FileCode className={cn(cls, "text-brand")} />;
  }
  const Icon = PALETTE_FILE_ICON[kind];
  return <Icon className={cls} />;
}

/* ------------------------------------------------------------------ *
 * Helper exported for the workspace panel to dispatch an open-file
 * event when the user picks a file from elsewhere (e.g. the tree).
 * Kept here so the event name stays in one place.
 * ------------------------------------------------------------------ */

export { dispatchOpenFile as dispatchOpenFileEvent };
