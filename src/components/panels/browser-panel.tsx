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
  Monitor,
  ShieldCheck,
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
  toErrorMessage,
  PRESSABLE_KEYS,
  type ScrollDirection,
  type BrowserSession,
} from "@/components/browser/types";
import {
  sandboxForTier,
  classifyBrowserTrust,
  type BrowserTrustTier,
} from "@/lib/browser-trust";
import { useAppStore } from "@/stores/app-store";
import { useTranslation } from "@/hooks/use-translation";

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

type BrowserMode = "snapshot" | "preview" | "mirror";

function loadMode(): BrowserMode {
  if (typeof window === "undefined") return "snapshot";
  try {
    const raw = window.localStorage.getItem(MODE_STORAGE_KEY);
    if (raw === "preview" || raw === "mirror") return raw;
    return "snapshot";
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
  const { t } = useTranslation();
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
  // Freshest server state applied outside polling, keyed by session id +
  // monotonic seq. A response (SSE or poll) for an already-applied session
  // with an older seq must never revert it (URL flap during rapid agent
  // navigation). A different session id always wins (fresh open / restart).
  const liveIdRef = React.useRef<string | null>(null);
  const liveSeqRef = React.useRef(0);
  // Wall-clock of the last live apply — only used to forgive a stale NULL
  // poll (fetched before an open completed). Existence is server truth.
  const liveAppliedAtRef = React.useRef(0);
  // Consecutive forgiven nulls — at most one stale null is ever forgiven, so
  // a genuine close always lands on the next poll instead of sticking.
  const liveNullStreakRef = React.useRef(0);
  // Current view mode for event handlers (auto-reload preview on nav).
  // Synced every render next to the activeMode computation below.
  const modeRef = React.useRef<BrowserMode>("snapshot");

  // Subscribe to real-time browser events to avoid polling.
  React.useEffect(() => {
    let es: EventSource | null = null;
    try {
      es = new EventSource("/api/browser/events");
      es.onmessage = (ev) => {
        // Navigation events carry { id, url, title, trust, seq } — apply
        // instantly instead of waiting for the next poll round-trip.
        if (ev.data && ev.data !== "update") {
          try {
            const payload = JSON.parse(ev.data) as {
              id?: string;
              url?: string;
              title?: string;
              trust?: BrowserTrustTier;
              seq?: number;
            };
            if (payload.url) {
              const seq = typeof payload.seq === "number" ? payload.seq : 0;
              const sameSession =
                !!payload.id && payload.id === liveIdRef.current;
              if (!sameSession || seq > liveSeqRef.current) {
                if (payload.id) liveIdRef.current = payload.id;
                // A new session id resets the version baseline (server
                // restarts reset the counter) — never max() across ids or a
                // stale high-water mark would freeze updates forever.
                liveSeqRef.current = sameSession
                  ? Math.max(liveSeqRef.current, seq)
                  : seq;
                liveAppliedAtRef.current = Date.now();
                liveNullStreakRef.current = 0;
                // Abort any poll fetched during the transition gap so its
                // stale null cannot wipe this fresh state on arrival.
                void queryClient.cancelQueries({ queryKey: browserKeys.session });
                const nextUrl = payload.url;
                const nextTitle = payload.title ?? "";
                const nextTrust = payload.trust ?? "public";
                setSession((cur) =>
                  cur
                    ? {
                        ...cur,
                        url: nextUrl,
                        title: payload.title ?? cur.title,
                        trust: payload.trust ?? cur.trust,
                        seq,
                      }
                    : payload.id
                      ? {
                          // No local session yet (fresh panel load, agent
                          // opened first): seed a minimal one so the view is
                          // instant; the poll backfill completes it.
                          id: payload.id,
                          url: nextUrl,
                          title: nextTitle,
                          createdAt: Date.now(),
                          trust: nextTrust,
                          seq,
                        }
                      : cur,
                );
                if (!urlInputFocusedRef.current) setUrlInput(nextUrl);
                // Agent navigated while the user watches Preview — reload the
                // iframe so it tracks the live page (Snapshot/Mirror update
                // via query invalidation below).
                if (modeRef.current === "preview") {
                  setPreviewNonce((n) => n + 1);
                }
              }
            }
          } catch {
            /* legacy opaque tick */
          }
        }
        void queryClient.invalidateQueries({ queryKey: browserKeys.session });
        void queryClient.invalidateQueries({ queryKey: browserKeys.snapshot });
      };
      es.onerror = () => {
        // EventSource reconnects automatically with backoff; polling below
        // covers the gap while the stream is down.
        console.warn("[BrowserPanel] SSE stream error — relying on polling until it recovers.");
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
      liveIdRef.current = data.session.id;
      liveSeqRef.current = data.session.seq ?? 0;
      liveAppliedAtRef.current = Date.now();
      liveNullStreakRef.current = 0;
      // Abort any in-flight session poll fetched before this open completed
      // so its stale null cannot wipe the fresh session on arrival.
      void queryClient.cancelQueries({ queryKey: browserKeys.session });
      setSession(data.session);
      setUrlInput(data.session.url);
      queryClient.setQueryData(browserKeys.snapshot, { snapshot: data.snapshot });
      toast.success(t("browser_opened_url", { url: data.session.url }));
    },
    onError: (e) => {
      toast.error(toErrorMessage(e));
    },
  });

  const refreshMut = useMutation({
    mutationFn: () => fetchSnapshot(),
    onSuccess: (data) => {
      queryClient.setQueryData(browserKeys.snapshot, data);
      toast.success(t("browser_snapshot_refreshed"));
    },
    onError: (e) => {
      toast.error(toErrorMessage(e));
    },
  });

  const closeMut = useMutation({
    mutationFn: () => closeBrowser(),
    onSuccess: () => {
      liveIdRef.current = null;
      liveSeqRef.current = 0;
      liveNullStreakRef.current = 0;
      lastMirrorKeyRef.current = "";
      setSession(null);
      setUrlInput("");
      setSelectedRef(null);
      setBusyRef(null);
      setTextDraft("");
      setRefDraft("");
      queryClient.setQueryData(browserKeys.snapshot, { snapshot: "" });
      toast.success(t("browser_session_closed"));
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
      toast.success(t("browser_pressed_key", { key }));
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
      // A live update (SSE payload / successful open) for the same session
      // with a newer-or-equal seq is authoritative — don't let a stale
      // in-flight poll response revert it. A new session id resets the
      // baseline (server restarts reset the counter).
      const seq = polledSession.seq ?? 0;
      const sameSession =
        !!liveIdRef.current && polledSession.id === liveIdRef.current;
      if (sameSession && liveSeqRef.current > 0 && seq <= liveSeqRef.current) {
        return;
      }
      liveIdRef.current = polledSession.id;
      liveSeqRef.current = sameSession
        ? Math.max(liveSeqRef.current, seq)
        : seq;
      liveNullStreakRef.current = 0;
      setSession(polledSession);
      if (!urlInputFocusedRef.current && polledSession.url !== urlInput) {
        setUrlInput(polledSession.url);
      }
    } else if (prev) {
      // Server session disappeared (agent closed it or TTL eviction) —
      // reset the panel locally; no API call needed. Forgiven only when the
      // null was clearly fetched BEFORE our live apply (stale in-flight
      // poll racing a just-completed open) — and at most once in a row, so
      // a genuine close always lands on the following poll.
      if (
        liveIdRef.current &&
        prev.id === liveIdRef.current &&
        sessionFetchedAt < liveAppliedAtRef.current &&
        liveNullStreakRef.current === 0
      ) {
        liveNullStreakRef.current = 1;
        return;
      }
      liveIdRef.current = null;
      liveSeqRef.current = 0;
      liveNullStreakRef.current = 0;
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
  // Trust tier is server-classified per live URL; fall back to a local
  // classification for pre-1.1 payloads that lack it.
  const sessionTrust: BrowserTrustTier =
    session?.trust ??
    (session?.url ? classifyBrowserTrust(session.url).tier : "public");
  const isLocalSession = !!session?.url && sessionTrust !== "public";
  const activeMode: BrowserMode = browserAgentActive
    ? agentViewOverride ?? (isLocalSession ? "preview" : "snapshot")
    : mode;
  React.useEffect(() => {
    modeRef.current = activeMode;
  });

  // Screenshot is fetched on-demand when the dialog opens, and drives the
  // Mirror view (live pixels of the agent's headless browser).
  const screenshotQuery = useQuery({
    queryKey: ["browser", "screenshot"] as const,
    queryFn: () => fetchScreenshot(),
    enabled: false, // manual only
  });

  // Mirror auto-refresh: every new server state (agent action) pulls a fresh
  // frame while Mirror is visible. Throttled to one frame per 1.5s so rapid
  // action bursts don't queue screenshot storms; a throttled-behind state is
  // retried via timer so the mirror never sticks on an old frame. Skipped
  // while a capture is already in flight (single CLI capture at a time).
  // Keyed by session id + seq: seq alone resets on server restart, so an
  // id-less key could collide with a previously rendered frame.
  const lastMirrorAtRef = React.useRef(0);
  const lastMirrorKeyRef = React.useRef("");
  const mirrorTimerRef = React.useRef<number | null>(null);
  const [mirrorTick, setMirrorTick] = React.useState(0);
  React.useEffect(() => {
    return () => {
      if (mirrorTimerRef.current) {
        window.clearTimeout(mirrorTimerRef.current);
        mirrorTimerRef.current = null;
      }
    };
  }, []);
  React.useEffect(() => {
    if (activeMode !== "mirror" || !session) return;
    const key = `${session.id}:${session.seq ?? 0}`;
    if (key === lastMirrorKeyRef.current) return;
    if (screenshotQuery.isFetching) {
      // A capture is running long — retry shortly after instead of
      // dropping this state (nothing else re-triggers the effect).
      if (mirrorTimerRef.current) window.clearTimeout(mirrorTimerRef.current);
      mirrorTimerRef.current = window.setTimeout(
        () => setMirrorTick((tick) => tick + 1),
        500,
      );
      return;
    }
    const wait =
      lastMirrorKeyRef.current === ""
        ? 0
        : Math.max(0, 1500 - (Date.now() - lastMirrorAtRef.current));
    if (wait > 0) {
      if (mirrorTimerRef.current) window.clearTimeout(mirrorTimerRef.current);
      mirrorTimerRef.current = window.setTimeout(
        () => setMirrorTick((tick) => tick + 1),
        wait,
      );
      return;
    }
    if (mirrorTimerRef.current) {
      window.clearTimeout(mirrorTimerRef.current);
      mirrorTimerRef.current = null;
    }
    lastMirrorKeyRef.current = key;
    lastMirrorAtRef.current = Date.now();
    void screenshotQuery.refetch();
  }, [activeMode, session?.id, session?.seq, mirrorTick]);

  // Handlers

  const handleGo = () => {
    const url = normalizeBrowserUrl(urlInput);
    if (!url) {
      toast.error(t("browser_enter_url_error"));
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
      toast.error(t("browser_enter_ref_error"));
      return;
    }
    void clickMut.mutate(ref);
  };

  const handleActionBarType = () => {
    const ref = (refDraft || selectedRef || "").trim();
    if (!ref) {
      toast.error(t("browser_enter_ref_error"));
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
              <span>{t("browser_agent_controlling")}</span>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setBrowserAgentActive(false)}
                className="text-[10px] font-sans font-bold bg-white/20 hover:bg-white/30 text-white border border-white/30 rounded px-1.5 py-0.5 transition-colors cursor-pointer"
              >
                {t("browser_unlock")}
              </button>
              <Badge variant="outline" className="text-[10px] h-4 text-white border-white/40">{t("live")}</Badge>
            </div>
          </div>
          <div className="absolute inset-x-0 bottom-0 top-[28px] z-[5] bg-transparent pointer-events-auto cursor-not-allowed" />
        </>
      )}
      {/* Toolbar — kept above the agent lock-shield (z-10 vs z-[5]) so the
          view toggle stays reachable while the agent drives; interactive
          controls are individually disabled/gated instead. Both stay below
          app modals (dialog overlay/content are z-50). */}
      <div className="relative z-10 flex h-10 shrink-0 items-center gap-1.5 border-b px-2">
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
          placeholder={t("browser_url_placeholder")}
          className="h-7 flex-1 font-mono text-xs"
          aria-label={t("browser_url")}
          spellCheck={false}
          autoComplete="off"
        />
        <Button
          size="sm"
          className="h-7 gap-1 bg-brand px-2 text-[11px] text-brand-foreground hover:bg-brand/90"
          onClick={handleGo}
          disabled={openMut.isPending || browserAgentActive}
          aria-label={t("browser_open")}
        >
          {openMut.isPending ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <ArrowRight className="size-3" />
          )}
          {t("browser_go")}
        </Button>
        {/* Snapshot / Preview / Mirror toggle */}
        <ToggleGroup
          type="single"
          value={activeMode}
          onValueChange={(v) => {
            if (v === "snapshot" || v === "preview" || v === "mirror") {
              handleModeChange(v);
              // Explicit user choice wins over the agent-mirroring heuristic.
              setAgentViewOverride(v);
            }
          }}
          className="h-7 rounded-md border bg-background px-0.5"
          aria-label={t("browser_view_mode")}
        >
          <ToggleGroupItem
            value="snapshot"
            className="h-6 px-1.5 text-[11px] gap-1 data-[state=on]:bg-accent"
            aria-label={t("browser_snapshot_view_aria")}
          >
            <ListTree className="size-3" />
            <span className="hidden xl:inline">{t("browser_snapshot")}</span>
          </ToggleGroupItem>
          <ToggleGroupItem
            value="preview"
            className="h-6 px-1.5 text-[11px] gap-1 data-[state=on]:bg-accent"
            aria-label={t("browser_preview_view_aria")}
          >
            <Eye className="size-3" />
            <span className="hidden xl:inline">{t("browser_preview")}</span>
          </ToggleGroupItem>
          <ToggleGroupItem
            value="mirror"
            className="h-6 px-1.5 text-[11px] gap-1 data-[state=on]:bg-accent"
            aria-label={t("browser_mirror_view_aria")}
          >
            <Monitor className="size-3" />
            <span className="hidden xl:inline">{t("browser_mirror")}</span>
          </ToggleGroupItem>
        </ToggleGroup>
        <ToolbarIconButton
          label={
            activeMode === "snapshot"
              ? t("browser_refresh_snapshot")
              : activeMode === "preview"
                ? t("browser_reload_preview")
                : t("browser_reload_mirror")
          }
          onClick={() =>
            activeMode === "snapshot"
              ? void refreshMut.mutate()
              : activeMode === "preview"
                ? setPreviewNonce((n) => n + 1)
                : void screenshotQuery.refetch()
          }
          disabled={
            !session ||
            refreshMut.isPending ||
            (activeMode === "mirror" && screenshotQuery.isFetching)
          }
        >
          <RefreshCw
            className={cn(
              "size-3.5",
              refreshMut.isPending && "animate-spin",
            )}
          />
        </ToolbarIconButton>
        <ToolbarIconButton
          label={t("browser_screenshot")}
          onClick={handleScreenshot}
          disabled={!session}
        >
          <Camera className="size-3.5" />
        </ToolbarIconButton>
        <ToolbarIconButton
          label={t("browser_close_session")}
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

      {/* Body — Snapshot (accessibility tree), Preview (live iframe), or
          Mirror (agent-browser pixels, immune to framing blocks) */}
      <div className="min-h-0 flex-1">
        {!session ? (
          openMut.isPending ? (
            <SnapshotSkeleton />
          ) : (
            <EmptyState onQuickLink={handleQuickLink} />
          )
        ) : activeMode === "preview" ? (
          <PreviewView url={session.url} nonce={previewNonce} trust={session.trust} />
        ) : activeMode === "mirror" ? (
          <MirrorView
            url={session.url}
            trust={session.trust}
            dataUrl={screenshotQuery.data?.dataUrl ?? null}
            loading={screenshotQuery.isFetching}
            error={
              screenshotQuery.isError
                ? toErrorMessage(screenshotQuery.error)
                : null
            }
            onRetry={() => void screenshotQuery.refetch()}
          />
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

      {/* Action bar — hidden in Preview/Mirror mode (click/type/press only
          work in Snapshot mode). Shows a hint instead. */}
      {(activeMode === "preview" || activeMode === "mirror") && session ? (
        <div className="flex h-10 shrink-0 items-center gap-2 border-t px-3 text-[11px] text-muted-foreground">
          <Info className="size-3 text-brand" />
          <span>{t("browser_switch_to_snapshot")}</span>
          <Button
            size="sm"
            variant="outline"
            className="ms-auto h-7 gap-1 text-[11px]"
            onClick={() => {
              handleModeChange("snapshot");
              setAgentViewOverride("snapshot");
            }}
          >
            <ListTree className="size-3" />
            {t("browser_snapshot")}
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
            aria-label={t("browser_element_ref")}
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
            placeholder={t("browser_type_text_placeholder")}
            className="h-7 flex-1 font-mono text-xs"
            aria-label={t("browser_text_to_type")}
            spellCheck={false}
            autoComplete="off"
          />
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1 px-2 text-[11px]"
            onClick={handleActionBarClick}
            disabled={!session || clickMut.isPending || !refDraft || browserAgentActive}
            aria-label={t("browser_click_element")}
          >
            {clickMut.isPending ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <MousePointerClick className="size-3" />
            )}
            {t("click")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1 px-2 text-[11px]"
            onClick={handleActionBarType}
            disabled={!session || typeMut.isPending || !refDraft || browserAgentActive}
            aria-label={t("browser_type_into_element")}
          >
            {typeMut.isPending ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <Keyboard className="size-3" />
            )}
            {t("type")}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="sm"
                variant="outline"
                className="h-7 gap-1 px-2 text-[11px]"
                disabled={!session || pressMut.isPending || browserAgentActive}
                aria-label={t("browser_press_key")}
              >
                {pressMut.isPending ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <Keyboard className="size-3" />
                )}
                {t("browser_press")}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>{t("browser_press_key")}</DropdownMenuLabel>
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
              label={t("scroll_left")}
              onClick={() => handleScroll("left")}
              disabled={!session || scrollMut.isPending || browserAgentActive}
            >
              <ChevronLeft className="size-3" />
            </ScrollBtn>
            <ScrollBtn
              label={t("scroll_up")}
              onClick={() => handleScroll("up")}
              disabled={!session || scrollMut.isPending || browserAgentActive}
            >
              <ChevronUp className="size-3" />
            </ScrollBtn>
            <ScrollBtn
              label={t("scroll_down")}
              onClick={() => handleScroll("down")}
              disabled={!session || scrollMut.isPending || browserAgentActive}
            >
              <ChevronDown className="size-3" />
            </ScrollBtn>
            <ScrollBtn
              label={t("scroll_right")}
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
          aria-label={t("browser_action_in_progress")}
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

function TrustBadge({ trust }: { trust?: BrowserTrustTier }) {
  const { t } = useTranslation();
  const tier: BrowserTrustTier = trust ?? "public";
  const label =
    tier === "trusted-loopback"
      ? t("browser_trust_trusted_loopback")
      : tier === "local-network"
        ? t("browser_trust_local_network")
        : t("browser_trust_public");
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-px text-[10px] font-medium",
        tier === "trusted-loopback" && "border-emerald-500/40 text-emerald-600 dark:text-emerald-400",
        tier === "local-network" && "border-amber-500/40 text-amber-600 dark:text-amber-400",
        tier === "public" && "border-sky-500/40 text-sky-600 dark:text-sky-400",
      )}
      title={tier}
    >
      <ShieldCheck className="size-2.5" />
      {label}
    </span>
  );
}

/* PreviewView — live iframe of the current browser session URL.
 *
 * Sandboxing: the iframe ALWAYS carries a `sandbox` attribute derived from
 * the server-classified trust tier (see src/lib/browser-trust.ts). Local
 * tiers keep `allow-same-origin` so dev apps work (localStorage, HMR,
 * same-origin fetch); the public tier renders with an opaque origin. No
 * tier ever allows top-navigation or downloads, so framed content — even a
 * compromised or attacker-controlled page the agent was tricked into
 * opening — cannot navigate or script the IDE window.
 *
 * Routing: public URLs render through /api/browser/proxy (which strips
 * upstream framing headers and re-serves with an opaque-origin CSP);
 * local URLs load directly so HMR/websockets keep working. Sites that send
 * X-Frame-Options/CSP frame-ancestors (like a hardened local app) still
 * refuse the iframe — Mirror mode covers exactly that case.
 *
 * Many sites block iframe embedding via X-Frame-Options or
 * frame-ancestors CSP. The iframe still renders in those cases, but
 * shows the browser's own "refused to connect" error. We can't detect
 * the block from JS (the iframe's onLoad fires even for blocked
 * loads), so we render a small, always-visible notice bar above the
 * iframe with trust badge + "Open in new tab" link. If the iframe is still
 * blank after 6 seconds, we additionally overlay a fallback panel
 * with the same guidance.
 */
function PreviewView({
  url,
  nonce,
  trust,
}: {
  url: string;
  nonce: number;
  trust?: BrowserTrustTier;
}) {
  const { t } = useTranslation();
  const [showFallback, setShowFallback] = React.useState(false);
  const timerRef = React.useRef<number | null>(null);

  // Reset the fallback timer whenever the URL or nonce (manual reload /
  // agent navigation) changes. If onLoad hasn't fired within 6s, we surface
  // the fallback.
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

  // Fail closed when the tier is unknown (pre-1.1 session payloads): proxy +
  // strict sandbox.
  const tier: BrowserTrustTier = trust ?? "public";
  const iframeSrc =
    tier === "public" ? `/api/browser/proxy?url=${encodeURIComponent(url)}` : url;

  return (
    <div className="relative flex h-full flex-col bg-background">
      {/* Small notice bar — always visible so the user has the trust badge
          and "open in new tab" affordance regardless of load state. */}
      <div className="flex shrink-0 items-center gap-1.5 border-b bg-muted/30 px-2 py-1 text-[10px] text-muted-foreground">
        <Info className="size-2.5 shrink-0 text-brand" />
        <span className="truncate font-mono">{url}</span>
        <TrustBadge trust={tier} />
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="ms-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-brand hover:bg-accent transition-colors"
          aria-label={t("browser_open_new_tab")}
        >
          <ExternalLink className="size-2.5" />
          <span>{t("open")}</span>
        </a>
      </div>
      <div className="relative min-h-0 flex-1">
        <iframe
          key={`${tier}:${url}-${nonce}`}
          src={iframeSrc}
          title={`Preview of ${url}`}
          className="size-full border-0 bg-white"
          sandbox={sandboxForTier(tier)}
          referrerPolicy="no-referrer"
          onLoad={handleLoad}
        />
        {/* Overlay fallback — shown only after the 6s timer fires with
            no onLoad. Covers the iframe so the user isn't staring at a
            blank rectangle. */}
        {showFallback && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background/95 p-6 text-center backdrop-blur-sm">
            <AlertTriangle className="size-6 text-amber-500" />
            <p className="text-sm font-medium">{t("browser_cant_preview")}</p>
            <p className="max-w-sm text-xs text-muted-foreground">
              {t("browser_cant_preview_desc")}
            </p>
            <div className="mt-2 flex items-center gap-2">
              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-brand px-3 text-xs font-medium text-white hover:bg-brand/90 transition-colors"
              >
                <ExternalLink className="size-3" />
                {t("browser_open_new_tab")}
              </a>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* MirrorView — live pixels of the agent's headless browser.
 *
 * Unlike Preview (a second renderer: direct iframe or proxy re-fetch), the
 * mirror shows EXACTLY what the agent sees, because it is a screenshot of
 * the agent's own page. It is immune to X-Frame-Options / frame-ancestors
 * blocks (no framing involved) and to cookie/storage divergence. View-only
 * by design: interaction stays in Snapshot mode.
 */
function MirrorView({
  url,
  trust,
  dataUrl,
  loading,
  error,
  onRetry,
}: {
  url: string;
  trust?: BrowserTrustTier;
  dataUrl: string | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="relative flex h-full flex-col bg-background">
      <div className="flex shrink-0 items-center gap-1.5 border-b bg-muted/30 px-2 py-1 text-[10px] text-muted-foreground">
        <Monitor className="size-2.5 shrink-0 text-brand" />
        <span className="truncate font-mono">{url}</span>
        <TrustBadge trust={trust} />
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="ms-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-brand hover:bg-accent transition-colors"
          aria-label={t("browser_open_new_tab")}
        >
          <ExternalLink className="size-2.5" />
          <span>{t("open")}</span>
        </a>
      </div>
      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-auto bg-muted/20 p-2">
        {error && !dataUrl ? (
          <div className="flex flex-col items-center gap-2 text-center">
            <AlertTriangle className="size-5 text-amber-500" />
            <p className="max-w-sm text-xs text-amber-600 dark:text-amber-400">{error}</p>
            <Button size="sm" variant="outline" onClick={onRetry}>
              {t("retry")}
            </Button>
          </div>
        ) : !dataUrl && loading ? (
          <div className="flex flex-col items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
            <span>{t("browser_mirror_desc")}</span>
          </div>
        ) : dataUrl ? (
          <img
            src={dataUrl}
            alt={`Mirror of ${url}`}
            className="max-h-full max-w-full rounded border object-contain shadow-sm"
          />
        ) : (
          <p className="max-w-sm px-4 text-center text-xs text-muted-foreground">
            {t("browser_mirror_desc")}
          </p>
        )}
        {loading && dataUrl && (
          <div className="absolute end-3 top-3 flex items-center gap-1 rounded bg-background/80 px-1.5 py-0.5 text-[10px] text-muted-foreground backdrop-blur-sm">
            <Loader2 className="size-2.5 animate-spin" />
            <span>{t("live")}</span>
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
  const { t } = useTranslation();
  return (
    <div className="flex h-full flex-col items-center justify-center p-6 text-center">
      <Globe className="size-9 text-muted-foreground/40" />
      <p className="mt-2 text-sm font-medium">{t("browse_the_web")}</p>
      <p className="mt-1 text-xs text-muted-foreground">
        {t("browse_the_web_desc")}
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
  const { t } = useTranslation();
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
      <AlertTriangle className="size-5 text-amber-500" />
      <p className="max-w-sm text-xs text-amber-600 dark:text-amber-400">
        {message}
      </p>
      <Button size="sm" variant="outline" onClick={onRetry}>
        {t("retry")}
      </Button>
    </div>
  );
}
