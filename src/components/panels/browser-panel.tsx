"use client";

import * as React from "react";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import {
  Globe,
  ArrowRight,
  RefreshCw,
  Camera,
  X,
  MousePointerClick,
  Keyboard,
  ChevronUp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Loader2,
  AlertTriangle,
  ExternalLink,
  Eye,
  ListTree,
  Info,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { SnapshotView } from "@/components/browser/snapshot-view";
import { ScreenshotDialog } from "@/components/browser/screenshot-dialog";
import {
  browserKeys,
  openBrowser,
  fetchSnapshot,
  fetchSession,
  clickElement,
  typeIntoElement,
  pressKey,
  scrollBrowser,
  fetchScreenshot,
  closeBrowser,
  normalizeBrowserUrl,
  isLocalOrPrivateUrl,
  toErrorMessage,
  PRESSABLE_KEYS,
  type ScrollDirection,
  type BrowserSession,
} from "@/components/browser/types";
import { useAppStore } from "@/stores/app-store";

/* ------------------------------------------------------------------ *
 * BrowserPanel — exported entry point.
 *
 * Wraps the inner panel in a local React Query provider because the
 * global app providers do not include one (matching the workspace panel
 * pattern). A single QueryClient is created per mounted instance.
 * ------------------------------------------------------------------ */

export function BrowserPanel() {
  const [queryClient] = React.useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { refetchOnWindowFocus: false, retry: 1, staleTime: 0 },
        },
      }),
  );
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserPanelInner />
    </QueryClientProvider>
  );
}

const QUICK_LINKS = [
  "github.com",
  "news.ycombinator.com",
  "developer.mozilla.org",
];

/* localStorage key for the Snapshot/Preview toggle. Persisted across
 * sessions so the user's preferred mode is restored on next open. */
const MODE_STORAGE_KEY = "hermos:browser-mode";

type BrowserMode = "snapshot" | "preview";

function loadMode(): BrowserMode {
  if (typeof window === "undefined") return "snapshot";
  try {
    const raw = window.localStorage.getItem(MODE_STORAGE_KEY);
    return raw === "preview" ? "preview" : "snapshot";
  } catch {
    return "snapshot";
  }
}

function saveMode(mode: BrowserMode) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(MODE_STORAGE_KEY, mode);
  } catch {
    // ignore quota / private mode errors
  }
}

function BrowserPanelInner() {
  const queryClient = useQueryClient();
  const browserAgentActive = useAppStore((s: any) => s.browserAgentActive);
  const setBrowserAgentActive = useAppStore((s: any) => s.setBrowserAgentActive);

  // Local UI state.
  const [session, setSession] = React.useState<BrowserSession | null>(null);
  const [urlInput, setUrlInput] = React.useState("");
  const [selectedRef, setSelectedRef] = React.useState<string | null>(null);
  const [busyRef, setBusyRef] = React.useState<string | null>(null);
  const [shotOpen, setShotOpen] = React.useState(false);
  const [refDraft, setRefDraft] = React.useState("");
  const [textDraft, setTextDraft] = React.useState("");
  // Snapshot vs Preview toggle. Persisted to localStorage.
  const [mode, setMode] = React.useState<BrowserMode>("snapshot");
  React.useEffect(() => {
    setMode(loadMode());
  }, []);
  const handleModeChange = (next: BrowserMode) => {
    setMode(next);
    saveMode(next);
  };
  // Nonce that increments on each manual reload while in Preview mode.
  // Bumping it forces the iframe to remount (its `key` includes the
  // nonce), which is the only reliable way to re-fetch the URL without
  // giving the iframe a same-origin src.
  const [previewNonce, setPreviewNonce] = React.useState(0);

  // Snapshot query — only enabled once a session exists. Polling is just a
  // fallback: SSE events carry live url/title and drive realtime updates.
  const snapshotQuery = useQuery({
    queryKey: browserKeys.snapshot,
    queryFn: ({ signal }) => fetchSnapshot(signal),
    enabled: !!session,
    refetchInterval: browserAgentActive ? 2500 : false,
  });

  const sessionQuery = useQuery({
    queryKey: browserKeys.session,
    queryFn: ({ signal }) => fetchSession(signal),
    refetchInterval: browserAgentActive ? 4000 : false,
  });

  // While the user is editing the URL bar, incoming session syncs must not
  // clobber what they are typing.
  const urlInputFocusedRef = React.useRef(false);
  // Timestamp of the freshest live state applied outside polling (SSE payload
  // or a successful open). An older in-flight poll response landing later
  // must never revert it (URL flap during rapid agent navigation).
  const liveUpdateAtRef = React.useRef(0);

  // Subscribe to real-time browser events to avoid polling.
  React.useEffect(() => {
    let es: EventSource | null = null;
    try {
      es = new EventSource("/api/browser/events");
      es.onmessage = (ev) => {
        // Navigation events carry { url, title } — apply instantly instead of
        // waiting for the next poll round-trip.
        if (ev.data && ev.data !== "update") {
          try {
            const payload = JSON.parse(ev.data) as { url?: string; title?: string };
            if (payload.url) {
              liveUpdateAtRef.current = Date.now();
              setSession((cur) =>
                cur ? { ...cur, url: payload.url!, title: payload.title ?? cur.title } : cur,
              );
              if (!urlInputFocusedRef.current) setUrlInput(payload.url);
            }
          } catch {
            /* legacy opaque tick */
          }
        }
        void queryClient.invalidateQueries({ queryKey: browserKeys.session });
        void queryClient.invalidateQueries({ queryKey: browserKeys.snapshot });
      };
    } catch (err) {
      console.warn("[BrowserPanel] SSE unavailable — relying on query polling:", err);
    }
    return () => {
      es?.close();
    };
  }, [queryClient]);

  // When the agent's browser session changes (different url / closed)
  // sync the panel to match. Defined below, after openMut/closeMut.

  const snapshot: string =
    (snapshotQuery.data?.snapshot as string | undefined) ?? "";

  // Mutations

  const openMut = useMutation({
    mutationFn: (url: string) => openBrowser(url),
    onSuccess: (data) => {
      liveUpdateAtRef.current = Date.now();
      setSession(data.session);
      setUrlInput(data.session.url);
      queryClient.setQueryData(browserKeys.snapshot, { snapshot: data.snapshot });
      toast.success(`Opened ${data.session.url}`);
    },
    onError: (e) => {
      toast.error(toErrorMessage(e));
    },
  });

  const refreshMut = useMutation({
    mutationFn: () => fetchSnapshot(),
    onSuccess: (data) => {
      queryClient.setQueryData(browserKeys.snapshot, data);
      toast.success("Snapshot refreshed");
    },
    onError: (e) => {
      toast.error(toErrorMessage(e));
    },
  });

  const closeMut = useMutation({
    mutationFn: () => closeBrowser(),
    onSuccess: () => {
      setSession(null);
      setUrlInput("");
      setSelectedRef(null);
      setBusyRef(null);
      setTextDraft("");
      setRefDraft("");
      queryClient.setQueryData(browserKeys.snapshot, { snapshot: "" });
      toast.success("Browser session closed");
    },
    onError: (e) => {
      toast.error(toErrorMessage(e));
    },
  });

  const clickMut = useMutation({
    mutationFn: (ref: string) => clickElement(ref),
    onMutate: (ref) => setBusyRef(ref),
    onSuccess: (data) => {
      queryClient.setQueryData(browserKeys.snapshot, { snapshot: data.snapshot });
      setSelectedRef(null);
    },
    onError: (e) => toast.error(toErrorMessage(e)),
    onSettled: () => setBusyRef(null),
  });

  const typeMut = useMutation({
    mutationFn: ({ ref, text }: { ref: string; text: string }) =>
      typeIntoElement(ref, text),
    onMutate: (vars) => setBusyRef(vars.ref),
    onSuccess: (data) => {
      queryClient.setQueryData(browserKeys.snapshot, { snapshot: data.snapshot });
      setTextDraft("");
      setSelectedRef(null);
    },
    onError: (e) => toast.error(toErrorMessage(e)),
    onSettled: () => setBusyRef(null),
  });

  const pressMut = useMutation({
    mutationFn: (key: string) => pressKey(key),
    onSuccess: (data, key) => {
      queryClient.setQueryData(browserKeys.snapshot, {
        snapshot: data.snapshot,
      });
      toast.success(`Pressed ${key}`);
    },
    onError: (e) => toast.error(toErrorMessage(e)),
  });

  const scrollMut = useMutation({
    mutationFn: (dir: ScrollDirection) => scrollBrowser(dir, 400),
    onSuccess: (data) => {
      queryClient.setQueryData(browserKeys.snapshot, {
        snapshot: data.snapshot,
      });
    },
    onError: (e) => toast.error(toErrorMessage(e)),
  });

  // The panel and the agent share ONE server-side browser session (keyed by
  // userId). Mirror its state into the panel — never re-navigate here, that
  // would double-load the page the agent is already driving.
  const prevPolledRef = React.useRef<BrowserSession | null>(null);
  const polledSession = sessionQuery.data?.session ?? null;
  const sessionFetchedAt = sessionQuery.dataUpdatedAt;
  React.useEffect(() => {
    const prev = prevPolledRef.current;
    prevPolledRef.current = polledSession;
    if (polledSession) {
      // A live update (SSE payload / successful open) newer than this poll's
      // fetch is authoritative — don't let the stale response revert it.
      if (liveUpdateAtRef.current > sessionFetchedAt) return;
      setSession(polledSession);
      if (!urlInputFocusedRef.current && polledSession.url !== urlInput) {
        setUrlInput(polledSession.url);
      }
    } else if (prev && liveUpdateAtRef.current <= sessionFetchedAt) {
      // Server session disappeared (agent closed it or TTL eviction) —
      // reset the panel locally; no API call needed. Guarded like above: a
      // null response older than our freshest live update must not wipe it.
      setSession(null);
      setSelectedRef(null);
      setBusyRef(null);
      setTextDraft("");
      setRefDraft("");
      if (!urlInputFocusedRef.current) setUrlInput("");
      queryClient.setQueryData(browserKeys.snapshot, { snapshot: "" });
    }
  }, [polledSession, sessionFetchedAt, urlInput, queryClient]);

  // While the agent drives the shared session, show the view that reflects
  // ITS page truthfully: the accessibility snapshot. Exception — localhost
  // URLs load directly in the iframe (no proxy), an accurate mirror of dev
  // servers. An explicit toggle by the user wins over the heuristic.
  const [agentViewOverride, setAgentViewOverride] = React.useState<BrowserMode | null>(null);
  React.useEffect(() => {
    if (!browserAgentActive) setAgentViewOverride(null);
  }, [browserAgentActive]);
  const isLocalSession = !!session?.url && isLocalOrPrivateUrl(session.url);
  const activeMode: BrowserMode = browserAgentActive
    ? agentViewOverride ?? (isLocalSession ? "preview" : "snapshot")
    : mode;

  // Screenshot is fetched on-demand when the dialog opens.
  const screenshotQuery = useQuery({
    queryKey: ["browser", "screenshot"] as const,
    queryFn: () => fetchScreenshot(),
    enabled: false, // manual only
  });

  // Handlers

  const handleGo = () => {
    const url = normalizeBrowserUrl(urlInput);
    if (!url) {
      toast.error("Enter a URL or search term");
      return;
    }
    setUrlInput(url);
    void openMut.mutate(url);
  };

  const handleQuickLink = (host: string) => {
    setUrlInput(host);
    void openMut.mutate(`https://${host}/`);
  };

  const handleQuickClick = (ref: string) => {
    if (browserAgentActive) return; // lock shield also blocks mouse; gate keyboard too
    void clickMut.mutate(ref);
  };

  const handleQuickType = (ref: string) => {
    if (browserAgentActive) return;
    setSelectedRef(ref);
    setRefDraft(ref);
    setTextDraft("");
  };

  const handleActionBarClick = () => {
    const ref = (refDraft || selectedRef || "").trim();
    if (!ref) {
      toast.error("Enter a ref (e.g. @e1)");
      return;
    }
    void clickMut.mutate(ref);
  };

  const handleActionBarType = () => {
    const ref = (refDraft || selectedRef || "").trim();
    if (!ref) {
      toast.error("Enter a ref (e.g. @e1)");
      return;
    }
    void typeMut.mutate({ ref, text: textDraft });
  };

  const handlePress = (key: string) => {
    void pressMut.mutate(key);
  };

  const handleScroll = (dir: ScrollDirection) => {
    void scrollMut.mutate(dir);
  };

  const handleScreenshot = () => {
    setShotOpen(true);
    void screenshotQuery.refetch();
  };

  const anyLoading =
    openMut.isPending ||
    clickMut.isPending ||
    typeMut.isPending ||
    pressMut.isPending ||
    scrollMut.isPending ||
    refreshMut.isPending ||
    snapshotQuery.isFetching;

  // Render

  return (
    <div className={cn("flex h-full flex-col bg-card relative", browserAgentActive && "border-2 border-blue-500 rounded-md transition-all duration-300")}>
      {browserAgentActive && (
        <>
          <div className="bg-brand text-white text-[10px] py-1 px-3 flex items-center justify-between font-medium tracking-wide border-b border-brand/40 shadow-sm shrink-0 z-10">
            <div className="flex items-center gap-1.5">
              <Loader2 className="size-3 animate-spin text-white" />
              <span>Agent is controlling this browser session...</span>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setBrowserAgentActive(false)}
                className="text-[9px] font-sans font-bold bg-white/20 hover:bg-white/30 text-white border border-white/30 rounded px-1.5 py-0.5 transition-colors cursor-pointer"
              >
                Unlock
              </button>
              <Badge variant="outline" className="text-[8px] h-4 text-white border-white/40">LIVE</Badge>
            </div>
          </div>
          <div className="absolute inset-x-0 bottom-0 top-[28px] z-[50] bg-transparent pointer-events-auto cursor-not-allowed" />
        </>
      )}
      {/* Toolbar — kept above the agent lock-shield (z-[60] vs z-[50]) so the
          view toggle stays reachable while the agent drives; interactive
          controls are individually disabled/gated instead. */}
      <div className="relative z-[60] flex h-10 shrink-0 items-center gap-1.5 border-b px-2">
        <Input
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
          onFocus={() => {
            urlInputFocusedRef.current = true;
          }}
          onBlur={() => {
            urlInputFocusedRef.current = false;
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              handleGo();
            }
          }}
          disabled={browserAgentActive}
          placeholder="Enter a URL or search…"
          className="h-7 flex-1 font-mono text-xs"
          aria-label="Browser URL"
          spellCheck={false}
          autoComplete="off"
        />
        <Button
          size="sm"
          className="h-7 gap-1 bg-brand px-2 text-[11px] text-brand-foreground hover:bg-brand/90"
          onClick={handleGo}
          disabled={openMut.isPending || browserAgentActive}
          aria-label="Open URL"
        >
          {openMut.isPending ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <ArrowRight className="size-3" />
          )}
          Go
        </Button>
        {/* Snapshot / Preview toggle */}
        <ToggleGroup
          type="single"
          value={activeMode}
          onValueChange={(v) => {
            if (v === "snapshot" || v === "preview") {
              handleModeChange(v);
              // Explicit user choice wins over the agent-mirroring heuristic.
              setAgentViewOverride(v);
            }
          }}
          className="h-7 rounded-md border bg-background px-0.5"
          aria-label="Browser view mode"
        >
          <ToggleGroupItem
            value="snapshot"
            className="h-6 px-1.5 text-[11px] gap-1 data-[state=on]:bg-accent"
            aria-label="Snapshot view (accessibility tree)"
          >
            <ListTree className="size-3" />
            <span className="hidden xl:inline">Snapshot</span>
          </ToggleGroupItem>
          <ToggleGroupItem
            value="preview"
            className="h-6 px-1.5 text-[11px] gap-1 data-[state=on]:bg-accent"
            aria-label="Preview view (live iframe)"
          >
            <Eye className="size-3" />
            <span className="hidden xl:inline">Preview</span>
          </ToggleGroupItem>
        </ToggleGroup>
        <ToolbarIconButton
          label={activeMode === "snapshot" ? "Refresh snapshot" : "Reload preview"}
          onClick={() =>
            activeMode === "snapshot"
              ? void refreshMut.mutate()
              : setPreviewNonce((n) => n + 1)
          }
          disabled={!session || refreshMut.isPending}
        >
          <RefreshCw
            className={cn(
              "size-3.5",
              refreshMut.isPending && "animate-spin",
            )}
          />
        </ToolbarIconButton>
        <ToolbarIconButton
          label="Screenshot"
          onClick={handleScreenshot}
          disabled={!session}
        >
          <Camera className="size-3.5" />
        </ToolbarIconButton>
        <ToolbarIconButton
          label="Close session"
          onClick={() => void closeMut.mutate()}
          disabled={!session || closeMut.isPending || browserAgentActive}
        >
          {closeMut.isPending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <X className="size-3.5" />
          )}
        </ToolbarIconButton>
      </div>

      {/* Body — Snapshot (accessibility tree) or Preview (live iframe) */}
      <div className="min-h-0 flex-1">
        {!session ? (
          openMut.isPending ? (
            <SnapshotSkeleton />
          ) : (
            <EmptyState onQuickLink={handleQuickLink} />
          )
        ) : activeMode === "preview" ? (
          <PreviewView url={session.url} nonce={previewNonce} />
        ) : snapshotQuery.isLoading && !snapshot ? (
          <SnapshotSkeleton />
        ) : snapshotQuery.isError && !snapshot ? (
          <ErrorState
            message={toErrorMessage(snapshotQuery.error)}
            onRetry={() => void snapshotQuery.refetch()}
          />
        ) : (
          <ScrollArea className="h-full">
            <SnapshotView
              snapshot={snapshot}
              selectedRef={selectedRef}
              onSelectRef={(ref) => {
                setSelectedRef((cur) => (cur === ref ? null : ref));
                if (ref) setRefDraft(ref);
              }}
              onQuickClick={handleQuickClick}
              onQuickType={handleQuickType}
              busyRef={busyRef}
            />
          </ScrollArea>
        )}
      </div>

      {/* Action bar — hidden in Preview mode (click/type/press only work
          in Snapshot mode). Shows a hint instead. */}
      {activeMode === "preview" && session ? (
        <div className="flex h-10 shrink-0 items-center gap-2 border-t px-3 text-[11px] text-muted-foreground">
          <Info className="size-3 text-brand" />
          <span>Switch to Snapshot mode to interact with the page.</span>
          <Button
            size="sm"
            variant="outline"
            className="ml-auto h-7 gap-1 text-[11px]"
            onClick={() => {
              handleModeChange("snapshot");
              setAgentViewOverride("snapshot");
            }}
          >
            <ListTree className="size-3" />
            Snapshot
          </Button>
        </div>
      ) : (
        <div className="flex h-10 shrink-0 items-center gap-1.5 border-t px-2">
          <Input
            value={refDraft}
            onChange={(e) => setRefDraft(e.target.value)}
            disabled={browserAgentActive}
            placeholder="@e1"
            className="h-7 w-20 font-mono text-xs"
            aria-label="Element ref"
            spellCheck={false}
            autoComplete="off"
          />
          <Input
            value={textDraft}
            onChange={(e) => setTextDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                handleActionBarType();
              }
            }}
            disabled={browserAgentActive}
            placeholder="Type text…"
            className="h-7 flex-1 font-mono text-xs"
            aria-label="Text to type"
            spellCheck={false}
            autoComplete="off"
          />
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1 px-2 text-[11px]"
            onClick={handleActionBarClick}
            disabled={!session || clickMut.isPending || !refDraft || browserAgentActive}
            aria-label="Click element"
          >
            {clickMut.isPending ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <MousePointerClick className="size-3" />
            )}
            Click
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1 px-2 text-[11px]"
            onClick={handleActionBarType}
            disabled={!session || typeMut.isPending || !refDraft || browserAgentActive}
            aria-label="Type into element"
          >
            {typeMut.isPending ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <Keyboard className="size-3" />
            )}
            Type
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="sm"
                variant="outline"
                className="h-7 gap-1 px-2 text-[11px]"
                disabled={!session || pressMut.isPending || browserAgentActive}
                aria-label="Press a key"
              >
                {pressMut.isPending ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <Keyboard className="size-3" />
                )}
                Press
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Press a key</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {PRESSABLE_KEYS.map((k) => (
                <DropdownMenuItem
                  key={k.value}
                  onSelect={() => handlePress(k.value)}
                >
                  {k.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <div className="mx-0.5 flex items-center overflow-hidden rounded-md border">
            <ScrollBtn
              label="Scroll left"
              onClick={() => handleScroll("left")}
              disabled={!session || scrollMut.isPending || browserAgentActive}
            >
              <ChevronLeft className="size-3" />
            </ScrollBtn>
            <ScrollBtn
              label="Scroll up"
              onClick={() => handleScroll("up")}
              disabled={!session || scrollMut.isPending || browserAgentActive}
            >
              <ChevronUp className="size-3" />
            </ScrollBtn>
            <ScrollBtn
              label="Scroll down"
              onClick={() => handleScroll("down")}
              disabled={!session || scrollMut.isPending || browserAgentActive}
            >
              <ChevronDown className="size-3" />
            </ScrollBtn>
            <ScrollBtn
              label="Scroll right"
              onClick={() => handleScroll("right")}
              disabled={!session || scrollMut.isPending || browserAgentActive}
            >
              <ChevronRight className="size-3" />
            </ScrollBtn>
          </div>
        </div>
      )}

      {/* Loading bar */}
      {anyLoading && (
        <div
          className="h-0.5 w-full bg-brand/40"
          role="status"
          aria-label="Browser action in progress"
        />
      )}

      <ScreenshotDialog
        open={shotOpen}
        onOpenChange={setShotOpen}
        dataUrl={screenshotQuery.data?.dataUrl ?? null}
        loading={screenshotQuery.isFetching}
        error={
          screenshotQuery.isError
            ? toErrorMessage(screenshotQuery.error)
            : null
        }
        onRetry={() => void screenshotQuery.refetch()}
      />
    </div>
  );
}

/* --------------------------- Sub-components ---------------------------- */

/* PreviewView — live iframe of the current browser session URL.
 *
 * Many sites block iframe embedding via X-Frame-Options or
 * frame-ancestors CSP. The iframe still renders in those cases, but
 * shows the browser's own "refused to connect" error. We can't detect
 * the block from JS (the iframe's onLoad fires even for blocked
 * loads), so we render a small, always-visible notice bar above the
 * iframe with an "Open in new tab" link. If the iframe is still
 * blank after 6 seconds, we additionally overlay a fallback panel
 * with the same guidance.
 */
function PreviewView({ url, nonce }: { url: string; nonce: number }) {
  const [showFallback, setShowFallback] = React.useState(false);
  const timerRef = React.useRef<number | null>(null);

  // Reset the fallback timer whenever the URL or nonce (manual reload)
  // changes. If onLoad hasn't fired within 6s, we surface the fallback.
  React.useEffect(() => {
    setShowFallback(false);
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
    }
    timerRef.current = window.setTimeout(() => {
      setShowFallback(true);
    }, 6000);
    return () => {
      if (timerRef.current) {
        window.clearTimeout(timerRef.current);
      }
    };
  }, [url, nonce]);

  const handleLoad = () => {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setShowFallback(false);
  };

  const isLocal = isLocalOrPrivateUrl(url);
  const iframeSrc = isLocal ? url : `/api/browser/proxy?url=${encodeURIComponent(url)}`;

  return (
    <div className="relative flex h-full flex-col bg-background">
      {/* Small notice bar — always visible so the user has the
          "open in new tab" affordance regardless of load state. */}
      <div className="flex shrink-0 items-center gap-1.5 border-b bg-muted/30 px-2 py-1 text-[10px] text-muted-foreground">
        <Info className="size-2.5 shrink-0 text-brand" />
        <span className="truncate font-mono">{url}</span>
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-brand hover:bg-accent transition-colors"
          aria-label="Open in new tab"
        >
          <ExternalLink className="size-2.5" />
          <span>Open</span>
        </a>
      </div>
      <div className="relative min-h-0 flex-1">
        <iframe
          key={`${url}-${nonce}`}
          src={iframeSrc}
          title={`Preview of ${url}`}
          className="size-full border-0 bg-white"
          onLoad={handleLoad}
        />
        {/* Overlay fallback — shown only after the 6s timer fires with
            no onLoad. Covers the iframe so the user isn't staring at a
            blank rectangle. */}
        {showFallback && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background/95 p-6 text-center backdrop-blur-sm">
            <AlertTriangle className="size-6 text-amber-500" />
            <p className="text-sm font-medium">Can&apos;t preview this site</p>
            <p className="max-w-sm text-xs text-muted-foreground">
              Many sites block iframe embedding via X-Frame-Options or
              Content-Security-Policy. Use Snapshot mode to interact with
              the page, or open it in a new tab.
            </p>
            <div className="mt-2 flex items-center gap-2">
              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-brand px-3 text-xs font-medium text-white hover:bg-brand/90 transition-colors"
              >
                <ExternalLink className="size-3" />
                Open in new tab
              </a>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ToolbarIconButton({
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

function ScrollBtn({
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
        <button
          type="button"
          onClick={onClick}
          disabled={disabled}
          aria-label={label}
          className={cn(
            "flex size-6 items-center justify-center text-muted-foreground transition-colors",
            "hover:bg-accent hover:text-foreground",
            "disabled:opacity-50 disabled:hover:bg-transparent",
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}

function SnapshotSkeleton() {
  return (
    <div className="space-y-1.5 p-2">
      {Array.from({ length: 12 }).map((_, i) => (
        <Skeleton
          key={i}
          className="h-3.5"
          style={{ width: `${40 + ((i * 13) % 50)}%` }}
        />
      ))}
    </div>
  );
}

function EmptyState({
  onQuickLink,
}: {
  onQuickLink: (host: string) => void;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center p-6 text-center">
      <Globe className="size-9 text-muted-foreground/40" />
      <p className="mt-2 text-sm font-medium">Browse the web</p>
      <p className="mt-1 text-xs text-muted-foreground">
        Enter a URL above to start. Pages render as an accessibility tree you
        can click and type into.
      </p>
      <div className="mt-3 flex flex-wrap items-center justify-center gap-1.5">
        {QUICK_LINKS.map((host) => (
          <Button
            key={host}
            size="sm"
            variant="outline"
            className="h-6 px-2 font-mono text-[11px]"
            onClick={() => onQuickLink(host)}
          >
            {host}
          </Button>
        ))}
      </div>
    </div>
  );
}

function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
      <AlertTriangle className="size-5 text-amber-500" />
      <p className="max-w-sm text-xs text-amber-600 dark:text-amber-400">
        {message}
      </p>
      <Button size="sm" variant="outline" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}
