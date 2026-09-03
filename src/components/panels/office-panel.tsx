"use client";

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Presentation,
  FileText,
  FileType,
  Play,
  Download,
  RefreshCw,
  Palette,
  Sparkles,
  Trash2,
  Copy,
  Plus,
  ChevronLeft,
  ChevronRight,
  Minimize2,
  Check,
  Columns,
  LayoutGrid,
  Table as TableIcon,
  Quote as QuoteIcon,
  Clock,
  Image as ImageIcon,
  ChevronDown,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAppStore } from "@/stores/app-store";
import { apiGet, apiPost } from "@/lib/api-client";
import {
  type OfficeDocManifest,
  type PptSlide,
  type DocSection,
  type OfficeThemeId,
  type SlideLayout,
} from "@/lib/office/types";
import {
  OFFICE_THEMES,
  resolveOfficeTheme,
} from "@/lib/office/themes";
import {
  resolveSlideCards,
  resolveSlideColumns,
  resolveSlideTable,
  resolveSlideSteps,
  resolveSlideQuote,
} from "@/lib/office/resolvers";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

interface WorkspaceOfficeDoc {
  path: string;
  relPath: string;
  name: string;
  type: "presentation" | "document" | "pdf";
  size: number;
  updatedAt: number;
  manifest?: OfficeDocManifest;
}

const LAYOUT_ICONS: Record<SlideLayout, React.ElementType> = {
  title: Presentation,
  bullets: FileText,
  cards: LayoutGrid,
  split: Columns,
  image_split: ImageIcon,
  table: TableIcon,
  timeline: Clock,
  quote: QuoteIcon,
};

function renderStatusCell(cell: string) {
  const c = cell.trim().toLowerCase();
  if (c === "on track" || c === "complete" || c === "pass" || c === "healthy") {
    return (
      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/15 text-emerald-600 border border-emerald-500/30">
        {cell}
      </span>
    );
  }
  if (c === "exceeding" || c === "optimal" || c === "high") {
    return (
      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-purple-500/15 text-purple-600 border border-purple-500/30">
        {cell}
      </span>
    );
  }
  if (c === "near target" || c === "pending" || c === "in progress" || c === "warning") {
    return (
      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-500/15 text-amber-600 border border-amber-500/30">
        {cell}
      </span>
    );
  }
  if (c === "at risk" || c === "delayed" || c === "failed" || c === "critical") {
    return (
      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-rose-500/15 text-rose-600 border border-rose-500/30">
        {cell}
      </span>
    );
  }
  return <span>{cell}</span>;
}

interface PaginatedDocPage {
  pageNumber: number;
  isCover: boolean;
  sections: Array<{ sec: DocSection; secIndex: number }>;
}

function paginateDocSections(doc: OfficeDocManifest | null): PaginatedDocPage[] {
  if (!doc) return [];
  const sections = doc.sections || [];
  if (sections.length === 0) {
    return [{ pageNumber: 1, isCover: true, sections: [] }];
  }

  const pages: PaginatedDocPage[] = [];
  const PAGE_CAPACITY = 780;
  const BANNER_WEIGHT = 340;

  let currentPageNumber = 1;
  let currentSections: Array<{ sec: DocSection; secIndex: number }> = [];
  let currentWeight = BANNER_WEIGHT;

  const estimateSectionWeight = (sec: DocSection) => {
    let w = 80;
    if (sec.subheading) w += 30;
    if (sec.callout) w += 120;
    w += (sec.paragraphs?.length || 0) * 85;
    w += (sec.bullets?.length || 0) * 28;
    if (sec.table) {
      w += 80 + (sec.table.rows?.length || 0) * 26;
    }
    return w;
  };

  sections.forEach((sec, idx) => {
    const secWeight = estimateSectionWeight(sec);
    if (currentSections.length > 0 && currentWeight + secWeight > PAGE_CAPACITY) {
      pages.push({
        pageNumber: currentPageNumber,
        isCover: currentPageNumber === 1,
        sections: currentSections,
      });
      currentPageNumber++;
      currentSections = [];
      currentWeight = 60;
    }

    currentSections.push({ sec, secIndex: idx });
    currentWeight += secWeight;
  });

  if (currentSections.length > 0 || pages.length === 0) {
    pages.push({
      pageNumber: currentPageNumber,
      isCover: currentPageNumber === 1,
      sections: currentSections,
    });
  }

  return pages;
}

// --- Path matching helpers -------------------------------------------------
// Companion manifests historically stored absolute filesystem paths while the
// list API returns workspace-relative paths. The server now normalizes
// manifest.path to workspace-relative, so strict matching is safe again.

// Normalize a manifest's path to the workspace-relative form used by the list
// API so subsequent comparisons and save payloads stay consistent.
function withRelPath(manifest: OfficeDocManifest, relPath: string): OfficeDocManifest {
  if (!manifest || !relPath) return manifest;
  if (manifest.path === relPath) return manifest;
  return { ...manifest, path: relPath };
}

export function OfficePanel() {
  const activeOfficeDoc = useAppStore((s) => s.activeOfficeDoc);
  const setActiveOfficeDoc = useAppStore((s) => s.setActiveOfficeDoc);
  const updateActiveOfficeSlide = useAppStore((s) => s.updateActiveOfficeSlide);
  const updateActiveOfficeSection = useAppStore((s) => s.updateActiveOfficeSection);
  const updateActiveOfficeDocMeta = useAppStore((s) => s.updateActiveOfficeDocMeta);
  const addActiveOfficeSection = useAppStore((s) => s.addActiveOfficeSection);
  const deleteActiveOfficeSection = useAppStore((s) => s.deleteActiveOfficeSection);
  const setActiveOfficeTheme = useAppStore((s) => s.setActiveOfficeTheme);
  const setComposerDraft = useAppStore((s) => s.setComposerDraft);
  const activeWorkspace = useAppStore((s) => s.activeWorkspace);

  // Studio state
  const [documents, setDocuments] = React.useState<WorkspaceOfficeDoc[]>([]);
  const [loadingDocs, setLoadingDocs] = React.useState(false);
  const [currentSlideIndex, setCurrentSlideIndex] = React.useState(0);
  const [activeTab, setActiveTab] = React.useState<"edit" | "notes">("edit");
  const [isSlideshow, setIsSlideshow] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [currentDocPage, setCurrentDocPage] = React.useState(1);
  // Guards against out-of-order async responses clobbering a newer selection:
  // only the latest list fetch / doc select may write activeOfficeDoc.
  const fetchSeqRef = React.useRef(0);
  const selectSeqRef = React.useRef(0);

  // Paginate document / PDF sections into clean print pages
  const paginatedPages = React.useMemo(() => {
    return paginateDocSections(activeOfficeDoc);
  }, [activeOfficeDoc]);

  // Active theme resolution
  const activeThemeId = (activeOfficeDoc?.theme as OfficeThemeId) || "executive";
  const theme = resolveOfficeTheme(activeThemeId);

  // 1. Fetch workspace office documents list (strictly scoped to active workspace)
  // Background polls NEVER overwrite the user's active selection or unsaved
  // edits (e.g. theme changes). They only auto-select when nothing is active.
  const fetchDocuments = React.useCallback(
    async (overrideWsId?: string) => {
      const seq = ++fetchSeqRef.current;
      setLoadingDocs(true);
      const wsId = overrideWsId ?? activeWorkspace?.id;
      const wsQuery = wsId ? `&workspaceId=${encodeURIComponent(wsId)}` : "";
      try {
        const res = await apiGet<{ ok: boolean; documents: WorkspaceOfficeDoc[] }>(
          `/api/office/document?action=list${wsQuery}`
        );
        // A newer fetch or manual doc select started while we were in flight —
        // drop this stale response so it can't snap the user back.
        if (seq !== fetchSeqRef.current || seq < selectSeqRef.current) return;
        if (res.ok && Array.isArray(res.documents)) {
          setDocuments(res.documents);

          const curDoc = useAppStore.getState().activeOfficeDoc;
          // No active doc -> auto-select the most recent one (initial load /
          // workspace switch). Otherwise preserve selection + unsaved theme.
          if (!curDoc) {
            if (res.documents.length > 0) {
              const first = res.documents[0];
              if (first.manifest) {
                setActiveOfficeDoc(withRelPath(first.manifest, first.path));
              } else {
                const docRes = await apiGet<{ ok: boolean; document: { manifest?: OfficeDocManifest } }>(
                  `/api/office/document?path=${encodeURIComponent(first.path)}${wsQuery}`
                );
                if (seq !== fetchSeqRef.current) return;
                if (docRes.ok && docRes.document.manifest) {
                  setActiveOfficeDoc(withRelPath(docRes.document.manifest, first.path));
                }
              }
              setCurrentSlideIndex(0);
              setCurrentDocPage(1);
            } else {
              // No office docs in this project -> immediately clear active document so previous project NEVER leaks!
              setActiveOfficeDoc(null);
              setCurrentSlideIndex(0);
              setCurrentDocPage(1);
            }
          }
        }
      } catch {
        /* ignore background poll failures */
      } finally {
        if (seq === fetchSeqRef.current) {
          setLoadingDocs(false);
        }
      }
    },
    [activeWorkspace?.id, setActiveOfficeDoc]
  );

  // Immediate workspace isolation: clear previous project state whenever active workspace changes
  const lastWsIdRef = React.useRef<string | undefined>(activeWorkspace?.id);
  React.useEffect(() => {
    if (activeWorkspace?.id !== lastWsIdRef.current) {
      lastWsIdRef.current = activeWorkspace?.id;
      // Invalidate any in-flight list/select so stale responses from the
      // previous workspace can't repopulate this one.
      fetchSeqRef.current++;
      selectSeqRef.current++;
      setActiveOfficeDoc(null);
      setDocuments([]);
      setCurrentSlideIndex(0);
      setCurrentDocPage(1);
      void fetchDocuments(activeWorkspace?.id);
    }
  }, [activeWorkspace?.id, setActiveOfficeDoc, fetchDocuments]);

  // Initial fetch and background poll scoped to workspace
  React.useEffect(() => {
    void fetchDocuments();
    const interval = setInterval(() => void fetchDocuments(), 8000);
    return () => clearInterval(interval);
  }, [fetchDocuments]);

  // Slideshow keyboard navigation
  React.useEffect(() => {
    if (!isSlideshow || !activeOfficeDoc?.slides) return;
    const max = activeOfficeDoc.slides.length - 1;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key === " " || e.key === "PageDown") {
        e.preventDefault();
        setCurrentSlideIndex((cur) => Math.min(cur + 1, max));
      } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
        e.preventDefault();
        setCurrentSlideIndex((cur) => Math.max(cur - 1, 0));
      } else if (e.key === "Escape") {
        e.preventDefault();
        setIsSlideshow(false);
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [isSlideshow, activeOfficeDoc?.slides]);

  // Reset slide/page when the actual document changes (path change only —
  // theme/slide edits must NOT reset the user's position).
  const activeDocPath = activeOfficeDoc?.path;
  React.useEffect(() => {
    setCurrentSlideIndex(0);
    setCurrentDocPage(1);
  }, [activeDocPath]);

  // Clamp slide index when switching to a shorter deck.
  const slideCount = activeOfficeDoc?.slides?.length ?? 0;
  React.useEffect(() => {
    if (slideCount > 0) {
      setCurrentSlideIndex((cur) => Math.min(cur, slideCount - 1));
    }
  }, [slideCount]);

  // Clamp doc page when pagination changes.
  React.useEffect(() => {
    setCurrentDocPage((cur) => {
      const total = paginatedPages.length || 1;
      return Math.min(Math.max(1, cur), total);
    });
  }, [paginatedPages.length]);

  // Document switcher handler (strictly workspace-scoped)
  // Last-click-wins: rapid pdf <-> ppt switches can't be undone by a slower
  // earlier request resolving after a newer one.
  const handleSelectDoc = async (docPath: string) => {
    const seq = ++selectSeqRef.current;
    // Bump fetch seq so a background poll in flight can't overwrite this select.
    fetchSeqRef.current++;
    try {
      const wsQuery = activeWorkspace?.id ? `&workspaceId=${encodeURIComponent(activeWorkspace.id)}` : "";
      const res = await apiGet<{ ok: boolean; document: { manifest?: OfficeDocManifest } }>(
        `/api/office/document?path=${encodeURIComponent(docPath)}${wsQuery}`
      );
      if (seq !== selectSeqRef.current) return;
      if (res.ok && res.document.manifest) {
        setActiveOfficeDoc(withRelPath(res.document.manifest, docPath));
        setCurrentSlideIndex(0);
        setCurrentDocPage(1);
      }
    } catch {
      if (seq !== selectSeqRef.current) return;
      toast.error("Failed to load document manifest.");
    }
  };

  // Re-export / Save changes back to disk
  const handleSaveChanges = async () => {
    if (!activeOfficeDoc) return;
    setSaving(true);
    try {
      const payload: any = {
        type: activeOfficeDoc.type === "presentation" ? "ppt" : activeOfficeDoc.type === "pdf" ? "pdf" : "doc",
        path: activeOfficeDoc.path,
        title: activeOfficeDoc.title,
        subtitle: activeOfficeDoc.subtitle,
        author: activeOfficeDoc.author,
        theme: activeOfficeDoc.theme,
        workspaceId: activeWorkspace?.id,
      };

      if (activeOfficeDoc.type === "presentation") {
        payload.slides = activeOfficeDoc.slides;
      } else {
        payload.sections = activeOfficeDoc.sections;
      }

      const res = await apiPost<{ ok: boolean; path: string }>("/api/office/generate", payload);
      if (res.ok) {
        toast.success(`Saved changes to ${activeOfficeDoc.path}!`);
        await fetchDocuments();
      }
    } catch (err: any) {
      toast.error(err?.message || "Failed to save document.");
    } finally {
      setSaving(false);
    }
  };

  // Pre-fill prompt into composer and focus
  const handleTriggerPrompt = React.useCallback(
    (prompt: string) => {
      setComposerDraft(prompt);
      requestAnimationFrame(() => {
        const ta = (document.getElementById("hermos-chat-composer") ||
          document.querySelector('textarea[data-composer="true"]') ||
          document.querySelector('textarea[aria-label="Message input"]') ||
          document.querySelector("textarea")) as HTMLTextAreaElement | null;
        if (ta) {
          ta.focus();
          ta.setSelectionRange(prompt.length, prompt.length);
        }
      });
      toast.success("Prompt loaded into composer! Press Enter to send.");
    },
    [setComposerDraft]
  );

  // Ask agent to refine this document
  const handleAskAgent = () => {
    if (!activeOfficeDoc) return;
    handleTriggerPrompt(`In @${activeOfficeDoc.path}, please `);
  };

  // Duplicate slide (modifying agent's presentation)
  const handleDuplicateSlide = (idx: number) => {
    if (!activeOfficeDoc || !activeOfficeDoc.slides) return;
    const target = activeOfficeDoc.slides[idx];
    const dup: PptSlide = {
      ...target,
      id: `slide-${Date.now().toString(36)}`,
      title: `${target.title} (Copy)`,
    };
    const next = [...activeOfficeDoc.slides];
    next.splice(idx + 1, 0, dup);
    setActiveOfficeDoc({
      ...activeOfficeDoc,
      slides: next,
      updatedAt: Date.now(),
    });
    setCurrentSlideIndex(idx + 1);
  };

  // Delete slide
  const handleDeleteSlide = (idx: number) => {
    if (!activeOfficeDoc || !activeOfficeDoc.slides || activeOfficeDoc.slides.length <= 1) {
      toast.error("Presentation must contain at least 1 slide.");
      return;
    }
    const next = activeOfficeDoc.slides.filter((_, i) => i !== idx);
    setActiveOfficeDoc({
      ...activeOfficeDoc,
      slides: next,
      updatedAt: Date.now(),
    });
    setCurrentSlideIndex(Math.max(0, idx - 1));
  };

  // Active slide
  const activeSlide: PptSlide | undefined =
    activeOfficeDoc?.slides?.[currentSlideIndex] || activeOfficeDoc?.slides?.[0];

  // Resolved layout content (ensures NEVER a blank white slide)
  const resolvedCards = activeSlide ? resolveSlideCards(activeSlide) : [];
  const resolvedColumns = activeSlide ? resolveSlideColumns(activeSlide) : [];
  const resolvedTable = activeSlide ? resolveSlideTable(activeSlide) : { headers: [], rows: [] };
  const resolvedSteps = activeSlide ? resolveSlideSteps(activeSlide) : [];
  const resolvedQuote = activeSlide ? resolveSlideQuote(activeSlide) : { text: "" };

  // =========================================================================
  // EMPTY STATE (When no office docs have been generated yet)
  // =========================================================================
  if (!activeOfficeDoc && documents.length === 0) {
    return (
      <div className="flex flex-col h-full bg-background/50 select-none">
        <div className="flex-1 flex flex-col items-center justify-center p-6 text-center max-w-md mx-auto">
          <div className="w-14 h-14 rounded-2xl bg-brand/10 border border-brand/20 flex items-center justify-center text-brand mb-5 shadow-xs">
            <Presentation className="w-7 h-7" />
          </div>
          <h2 className="text-lg font-semibold tracking-tight text-foreground mb-1.5">
            HermOS Office Studio
          </h2>
          <p className="text-xs text-muted-foreground leading-relaxed mb-6">
            Your AI agent creates company-grade presentations, Word specifications, and PDF reports
            slide-by-slide with executive layouts, live theme switchers, and real-time visual inspection.
          </p>

          <div className="w-full space-y-2.5 text-left">
            <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider px-1">
              Step-by-Step Agent Starters:
            </div>

            <button
              onClick={() => {
                handleTriggerPrompt(
                  "Outline and create an executive 6-slide presentation (presentation.pptx) on our platform architecture, roadmap, and performance metrics. Build it slide-by-slide with tailored layouts (KPI cards, split architecture, metrics table, roadmap timeline, and executive quote)."
                );
              }}
              className="w-full p-3 rounded-xl border border-border bg-card/60 hover:bg-accent/40 hover:border-brand/40 transition-all text-left group flex items-start gap-3 cursor-pointer shadow-xs"
            >
              <div className="p-2 rounded-lg bg-emerald-500/10 text-emerald-500 group-hover:scale-105 transition-transform shrink-0">
                <Presentation className="w-4 h-4" />
              </div>
              <div className="min-w-0">
                <div className="text-xs font-semibold text-foreground">Create a Presentation (Slide-by-Slide)</div>
                <div className="text-[11px] text-muted-foreground mt-0.5 line-clamp-2">
                  "Build an executive 6-slide deck carefully slide-by-slide with cards, tables, and roadmaps"
                </div>
              </div>
            </button>

            <button
              onClick={() => {
                handleTriggerPrompt(
                  "Generate a formal technical assessment PDF report (report.pdf) with executive summary, callouts, and benchmark tables."
                );
              }}
              className="w-full p-3 rounded-xl border border-border bg-card/60 hover:bg-accent/40 hover:border-brand/40 transition-all text-left group flex items-start gap-3 cursor-pointer shadow-xs"
            >
              <div className="p-2 rounded-lg bg-rose-500/10 text-rose-500 group-hover:scale-105 transition-transform shrink-0">
                <FileText className="w-4 h-4" />
              </div>
              <div className="min-w-0">
                <div className="text-xs font-semibold text-foreground">Generate a PDF Report</div>
                <div className="text-[11px] text-muted-foreground mt-0.5 line-clamp-2">
                  "Generate a formal technical assessment PDF with callouts and tables"
                </div>
              </div>
            </button>

            <button
              onClick={() => {
                handleTriggerPrompt(
                  "Draft an executive engineering specification Word document (spec.docx) with sections, tables, and metric highlights."
                );
              }}
              className="w-full p-3 rounded-xl border border-border bg-card/60 hover:bg-accent/40 hover:border-brand/40 transition-all text-left group flex items-start gap-3 cursor-pointer shadow-xs"
            >
              <div className="p-2 rounded-lg bg-blue-500/10 text-blue-500 group-hover:scale-105 transition-transform shrink-0">
                <FileType className="w-4 h-4" />
              </div>
              <div className="min-w-0">
                <div className="text-xs font-semibold text-foreground">Draft a Word Document</div>
                <div className="text-[11px] text-muted-foreground mt-0.5 line-clamp-2">
                  "Draft an engineering specification Word doc with comparison tables"
                </div>
              </div>
            </button>
          </div>
        </div>
      </div>
    );
  }

  // =========================================================================
  // STUDIO INTERFACE (Kimi / GLM Style with Company-Grade Aesthetics)
  // =========================================================================
  return (
    <div className="flex flex-col h-full bg-background border-l border-border select-none overflow-hidden">
      {/* 1. TOP STUDIO BAR — Zero Collision, Clear Affordances */}
      <div className="h-10 border-b border-border px-2.5 flex items-center justify-between gap-1.5 shrink-0 bg-card/50 backdrop-blur-sm">
        {/* Left: Document Selector & Type Badge */}
        <div className="flex items-center gap-1.5 min-w-0 flex-1 overflow-hidden">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs font-medium gap-1.5 max-w-[220px] truncate hover:bg-accent/60 shrink-0"
              >
                {activeOfficeDoc?.type === "presentation" ? (
                  <Presentation className="w-3.5 h-3.5 text-brand shrink-0" />
                ) : activeOfficeDoc?.type === "pdf" ? (
                  <FileText className="w-3.5 h-3.5 text-rose-500 shrink-0" />
                ) : (
                  <FileType className="w-3.5 h-3.5 text-blue-500 shrink-0" />
                )}
                <span className="truncate font-semibold">{activeOfficeDoc?.title || "Select Document"}</span>
                <ChevronDown className="w-3 h-3 opacity-50 shrink-0 ml-0.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-72">
              <div className="px-2 py-1.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                Workspace Documents ({documents.length})
              </div>
              <DropdownMenuSeparator />
              {documents.map((d) => (
                <DropdownMenuItem
                  key={d.path}
                  onClick={() => handleSelectDoc(d.path)}
                  className="text-xs cursor-pointer flex items-center gap-2"
                >
                  {d.type === "presentation" ? (
                    <Presentation className="w-3.5 h-3.5 text-brand shrink-0" />
                  ) : d.type === "pdf" ? (
                    <FileText className="w-3.5 h-3.5 text-rose-500 shrink-0" />
                  ) : (
                    <FileType className="w-3.5 h-3.5 text-blue-500 shrink-0" />
                  )}
                  <span className="truncate font-medium flex-1">{d.name}</span>
                  {activeOfficeDoc?.path === d.path && (
                    <Check className="w-3.5 h-3.5 text-brand shrink-0" />
                  )}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <Badge variant="outline" className="text-[9px] font-mono px-1.5 py-0 uppercase shrink-0 font-semibold">
            {activeOfficeDoc?.type === "presentation" ? "PPTX" : activeOfficeDoc?.type === "pdf" ? "PDF" : "DOCX"}
          </Badge>

          {activeWorkspace?.name && (
            <Badge variant="secondary" className="text-[9px] font-mono px-1.5 py-0 shrink-0 opacity-80 max-w-[110px] truncate" title={`Active Project: ${activeWorkspace.name}`}>
              {activeWorkspace.name}
            </Badge>
          )}
        </div>

        {/* Right: Studio Controls Toolbar */}
        <div className="flex items-center gap-1 shrink-0">
          {/* Theme Switcher with Palette Icon and Color Indicator */}
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-1.5 gap-1 rounded-md hover:bg-accent/60 text-muted-foreground hover:text-foreground text-xs"
                  >
                    <Palette className="w-3.5 h-3.5" />
                    <span
                      className="w-2.5 h-2.5 rounded-full border border-border/80 shadow-xs"
                      style={{ backgroundColor: `#${theme.primary}` }}
                    />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                  <div className="px-2 py-1.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                    Executive Themes
                  </div>
                  <DropdownMenuSeparator />
                  {Object.values(OFFICE_THEMES).map((t) => (
                    <DropdownMenuItem
                      key={t.id}
                      onClick={() => setActiveOfficeTheme(t.id)}
                      className="text-xs cursor-pointer flex items-center gap-2"
                    >
                      <span
                        className="w-3 h-3 rounded-full shrink-0 border border-border/60"
                        style={{ backgroundColor: `#${t.primary}` }}
                      />
                      <span className="flex-1">{t.name}</span>
                      {activeThemeId === t.id && (
                        <Check className="w-3.5 h-3.5 text-brand shrink-0" />
                      )}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </TooltipTrigger>
            <TooltipContent side="bottom">Change Theme: {theme.name}</TooltipContent>
          </Tooltip>

          {/* Slideshow Button */}
          {activeOfficeDoc?.type === "presentation" && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setIsSlideshow(true)}
                  className="h-7 w-7 text-brand hover:bg-brand/10"
                >
                  <Play className="w-3.5 h-3.5 fill-brand/20" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Start Slideshow (Fullscreen)</TooltipContent>
            </Tooltip>
          )}

          {/* Ask Agent to Refine */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={handleAskAgent}
                className="h-7 w-7 text-muted-foreground hover:text-brand"
              >
                <Sparkles className="w-3.5 h-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Ask Agent to Refine</TooltipContent>
          </Tooltip>

          {/* Export / Download */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => {
                  if (activeOfficeDoc?.path) {
                    window.open(`/api/workspace/file?path=${encodeURIComponent(activeOfficeDoc.path)}`, "_blank");
                  }
                }}
                className="h-7 w-7 text-muted-foreground hover:text-foreground"
              >
                <Download className="w-3.5 h-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Download File</TooltipContent>
          </Tooltip>

          {/* Save Button */}
          <Button
            size="sm"
            onClick={handleSaveChanges}
            disabled={saving}
            className="h-7 px-2.5 text-xs bg-brand text-brand-foreground hover:bg-brand/90 gap-1 shrink-0 font-medium ml-0.5"
          >
            {saving ? (
              <RefreshCw className="w-3 h-3 animate-spin" />
            ) : (
              <Check className="w-3 h-3" />
            )}
            <span>Save</span>
          </Button>
        </div>
      </div>

      {/* =================================================================== */}
      {/* 2. PRESENTATION STUDIO (Widescreen 16:9 Canvas & Dynamic Inspector) */}
      {/* =================================================================== */}
      {activeOfficeDoc?.type === "presentation" && (
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          <div className="flex-1 flex min-h-0 overflow-hidden">
            {/* Left Slide Filmstrip — Wider w-44 for Legible Titles */}
            <div className="w-44 border-r border-border bg-card/20 flex flex-col shrink-0 overflow-hidden">
              <div className="p-2 border-b border-border/60 flex items-center justify-between">
                <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                  Slides ({activeOfficeDoc.slides?.length || 0})
                </span>
                <span className="text-[9px] font-mono text-muted-foreground">
                  {currentSlideIndex + 1}/{activeOfficeDoc.slides?.length || 1}
                </span>
              </div>

              <ScrollArea className="flex-1 p-1.5">
                <div className="space-y-1.5">
                  {activeOfficeDoc.slides?.map((slide, sIdx) => {
                    const isActive = sIdx === currentSlideIndex;
                    const LayoutIcon = LAYOUT_ICONS[slide.layout || "bullets"] || FileText;

                    return (
                      <div
                        key={slide.id || sIdx}
                        onClick={() => setCurrentSlideIndex(sIdx)}
                        className={cn(
                          "group relative p-2.5 rounded-lg border transition-all cursor-pointer text-left",
                          isActive
                            ? "border-brand bg-brand/5 ring-1 ring-brand/30 shadow-xs"
                            : "border-border/60 bg-card/50 hover:bg-accent/40 hover:border-border"
                        )}
                      >
                        <div className="flex items-center justify-between mb-1.5">
                          <span className="text-[9px] font-mono px-1.5 py-0.2 rounded bg-background/80 border text-muted-foreground font-semibold">
                            {sIdx + 1}
                          </span>
                          <span className="text-[9px] font-medium text-muted-foreground capitalize flex items-center gap-1">
                            <LayoutIcon className="w-3 h-3 text-brand/80" />
                            {slide.layout || "bullets"}
                          </span>
                        </div>

                        <div className="text-xs font-semibold text-foreground line-clamp-2 leading-snug">
                          {slide.title}
                        </div>

                        {/* Slide action buttons: duplicate and delete */}
                        <div className="absolute right-1.5 top-1.5 hidden group-hover:flex items-center gap-0.5 bg-card/95 border border-border/80 rounded px-1 py-0.5 shadow-xs">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDuplicateSlide(sIdx);
                            }}
                            className="p-1 hover:text-brand text-muted-foreground"
                            title="Duplicate slide"
                          >
                            <Copy className="w-2.5 h-2.5" />
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDeleteSlide(sIdx);
                            }}
                            className="p-1 hover:text-rose-500 text-muted-foreground"
                            title="Delete slide"
                          >
                            <Trash2 className="w-2.5 h-2.5" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </ScrollArea>
            </div>

            {/* Center: Interactive Slide Canvas (Company-Grade 16:9 Aspect, Zero Blank Slides) */}
            <div className="flex-1 flex flex-col bg-accent/15 p-3 md:p-6 overflow-y-auto items-center justify-center min-h-0">
              {activeSlide && (
                <div
                  className="w-full max-w-3xl min-h-[320px] rounded-xl border shadow-xl flex flex-col justify-between p-6 relative transition-all duration-200"
                  style={{
                    backgroundColor: `#${activeSlide.layout === "title" && theme.isDarkTheme ? theme.primaryDark : theme.bg}`,
                    borderColor: `#${theme.border}`,
                    color: `#${theme.textDark}`,
                  }}
                >
                  {/* Decorative top accent line */}
                  <div
                    className="absolute top-0 left-0 right-0 h-1.5 rounded-t-xl"
                    style={{ backgroundColor: `#${theme.primary}` }}
                  />

                  {/* Header Area */}
                  {activeSlide.layout === "title" ? (
                    <div className="flex-1 flex flex-col justify-center py-6">
                      <div className="flex items-center gap-2 mb-3">
                        <span
                          className="w-2 h-7 rounded-full"
                          style={{ backgroundColor: `#${theme.accent}` }}
                        />
                        <span className="text-[11px] uppercase tracking-widest font-mono font-semibold opacity-75">
                          {activeOfficeDoc.author || "HermOS AI Studio"} • Executive Briefing
                        </span>
                      </div>
                      <h1
                        contentEditable
                        suppressContentEditableWarning
                        onBlur={(e) => {
                          const text = e.currentTarget.textContent?.trim();
                          if (text && text !== activeSlide.title) {
                            updateActiveOfficeSlide(currentSlideIndex, { title: text });
                          }
                        }}
                        className="text-2xl md:text-4xl font-extrabold tracking-tight mb-2.5 outline-none hover:bg-black/5 dark:hover:bg-white/5 focus:bg-black/5 dark:focus:bg-white/5 focus:ring-1 focus:ring-brand/40 rounded px-1 -mx-1 transition-colors cursor-text"
                        title="Click to edit title"
                      >
                        {activeSlide.title}
                      </h1>
                      {activeSlide.subtitle && (
                        <p
                          contentEditable
                          suppressContentEditableWarning
                          onBlur={(e) => {
                            const text = e.currentTarget.textContent?.trim();
                            if (text !== undefined && text !== activeSlide.subtitle) {
                              updateActiveOfficeSlide(currentSlideIndex, { subtitle: text });
                            }
                          }}
                          className="text-sm md:text-lg opacity-85 leading-relaxed outline-none hover:bg-black/5 dark:hover:bg-white/5 focus:bg-black/5 dark:focus:bg-white/5 focus:ring-1 focus:ring-brand/40 rounded px-1 -mx-1 transition-colors cursor-text"
                          style={{ color: `#${theme.secondary}` }}
                          title="Click to edit subtitle"
                        >
                          {activeSlide.subtitle}
                        </p>
                      )}
                      <div className="mt-6 flex items-center gap-2">
                        <div
                          className="px-3 py-1 rounded-full text-[11px] font-medium border shadow-xs"
                          style={{
                            backgroundColor: `#${theme.cardBg}`,
                            borderColor: `#${theme.border}`,
                          }}
                        >
                          {activeOfficeDoc.slides?.length || 0} Slides Deck • {theme.name} Palette
                        </div>
                      </div>
                    </div>
                  ) : (
                    <>
                      {/* Slide Title & Subtitle */}
                      <div>
                        <div className="flex items-center justify-between mb-1.5">
                          <div className="flex items-center gap-2.5">
                            <span
                              className="w-1.5 h-6 rounded-full shrink-0"
                              style={{ backgroundColor: `#${theme.primary}` }}
                            />
                            <h2
                              contentEditable
                              suppressContentEditableWarning
                              onBlur={(e) => {
                                const text = e.currentTarget.textContent?.trim();
                                if (text && text !== activeSlide.title) {
                                  updateActiveOfficeSlide(currentSlideIndex, { title: text });
                                }
                              }}
                              className="text-xl md:text-2xl font-bold tracking-tight outline-none hover:bg-black/5 dark:hover:bg-white/5 focus:bg-black/5 dark:focus:bg-white/5 focus:ring-1 focus:ring-brand/40 rounded px-1 -mx-1 transition-colors cursor-text"
                              title="Click to edit slide title"
                            >
                              {activeSlide.title}
                            </h2>
                          </div>
                          <span
                            className="text-[10px] uppercase font-mono tracking-wider px-2.5 py-1 rounded border font-medium"
                            style={{
                              backgroundColor: `#${theme.cardBg}`,
                              borderColor: `#${theme.border}`,
                              color: `#${theme.textMuted}`,
                            }}
                          >
                            {activeSlide.layout || "bullets"}
                          </span>
                        </div>
                        {activeSlide.subtitle && (
                          <p
                            contentEditable
                            suppressContentEditableWarning
                            onBlur={(e) => {
                              const text = e.currentTarget.textContent?.trim();
                              if (text !== undefined && text !== activeSlide.subtitle) {
                                updateActiveOfficeSlide(currentSlideIndex, { subtitle: text });
                              }
                            }}
                            className="text-xs md:text-sm pl-4 opacity-85 outline-none hover:bg-black/5 dark:hover:bg-white/5 focus:bg-black/5 dark:focus:bg-white/5 focus:ring-1 focus:ring-brand/40 rounded px-1 -mx-1 transition-colors cursor-text"
                            style={{ color: `#${theme.textMuted}` }}
                            title="Click to edit subtitle"
                          >
                            {activeSlide.subtitle}
                          </p>
                        )}
                      </div>

                      {/* Layout-Specific Content Area (Adaptive, Guaranteed Render) */}
                      <div className="flex-1 my-3.5 flex flex-col justify-center min-h-0 overflow-y-auto max-h-[420px]">
                        {/* 1. KPI / FEATURE CARDS LAYOUT */}
                        {activeSlide.layout === "cards" && (
                          <div className="grid grid-cols-2 md:grid-cols-3 gap-3.5 my-auto">
                            {resolvedCards.map((c, cIdx) => (
                              <div
                                key={cIdx}
                                className="p-4 rounded-xl border flex flex-col justify-between shadow-xs transition-all hover:shadow-md"
                                style={{
                                  backgroundColor: `#${theme.cardBg}`,
                                  borderColor: `#${theme.border}`,
                                }}
                              >
                                <div>
                                  {c.badge && (
                                    <span
                                      contentEditable
                                      suppressContentEditableWarning
                                      onBlur={(e) => {
                                        const val = e.currentTarget.textContent?.trim();
                                        if (val && val !== c.badge) {
                                          const next = [...resolvedCards];
                                          next[cIdx] = { ...c, badge: val };
                                          updateActiveOfficeSlide(currentSlideIndex, { cards: next });
                                        }
                                      }}
                                      className="inline-block px-2.5 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider mb-2.5 border outline-none cursor-text hover:opacity-80"
                                      style={{
                                        backgroundColor: `#${theme.tagBg}`,
                                        borderColor: `#${theme.accent}`,
                                        color: `#${theme.primaryDark}`,
                                      }}
                                      title="Click to edit badge"
                                    >
                                      {c.badge}
                                    </span>
                                  )}
                                  {c.value && (
                                    <div
                                      contentEditable
                                      suppressContentEditableWarning
                                      onBlur={(e) => {
                                        const val = e.currentTarget.textContent?.trim();
                                        if (val && val !== c.value) {
                                          const next = [...resolvedCards];
                                          next[cIdx] = { ...c, value: val };
                                          updateActiveOfficeSlide(currentSlideIndex, { cards: next });
                                        }
                                      }}
                                      className="text-3xl md:text-4xl font-extrabold tracking-tight mb-1 outline-none focus:ring-1 focus:ring-brand/40 rounded cursor-text"
                                      style={{ color: `#${theme.primary}` }}
                                      title="Click to edit value"
                                    >
                                      {c.value}
                                    </div>
                                  )}
                                  <div
                                    contentEditable
                                    suppressContentEditableWarning
                                    onBlur={(e) => {
                                      const val = e.currentTarget.textContent?.trim();
                                      if (val && val !== c.title) {
                                        const next = [...resolvedCards];
                                        next[cIdx] = { ...c, title: val };
                                        updateActiveOfficeSlide(currentSlideIndex, { cards: next });
                                      }
                                    }}
                                    className="text-sm md:text-base font-bold mb-1.5 outline-none focus:ring-1 focus:ring-brand/40 rounded cursor-text"
                                    title="Click to edit card title"
                                  >
                                    {c.title}
                                  </div>
                                </div>
                                <p
                                  contentEditable
                                  suppressContentEditableWarning
                                  onBlur={(e) => {
                                    const val = e.currentTarget.textContent?.trim();
                                    if (val !== undefined && val !== c.description) {
                                      const next = [...resolvedCards];
                                      next[cIdx] = { ...c, description: val };
                                      updateActiveOfficeSlide(currentSlideIndex, { cards: next });
                                    }
                                  }}
                                  className="text-xs md:text-sm leading-relaxed opacity-80 outline-none focus:ring-1 focus:ring-brand/40 rounded cursor-text"
                                  title="Click to edit description"
                                >
                                  {c.description}
                                </p>
                              </div>
                            ))}
                          </div>
                        )}

                        {/* 2. SPLIT 2-COLUMN COMPARISON LAYOUT */}
                        {activeSlide.layout === "split" && (
                          <div className="grid grid-cols-2 gap-4 my-auto">
                            {resolvedColumns.map((col, colIdx) => (
                              <div
                                key={colIdx}
                                className="p-4.5 rounded-xl border shadow-xs"
                                style={{
                                  backgroundColor: `#${theme.cardBg}`,
                                  borderColor: `#${theme.border}`,
                                }}
                              >
                                <h3
                                  contentEditable
                                  suppressContentEditableWarning
                                  onBlur={(e) => {
                                    const val = e.currentTarget.textContent?.trim();
                                    if (val && val !== col.heading) {
                                      const next = [...resolvedColumns];
                                      next[colIdx] = { ...col, heading: val };
                                      updateActiveOfficeSlide(currentSlideIndex, { columns: next });
                                    }
                                  }}
                                  className="text-sm md:text-base font-bold uppercase tracking-wider mb-3 pb-2 border-b outline-none cursor-text"
                                  style={{
                                    color: colIdx === 0 ? `#${theme.primary}` : `#${theme.secondary}`,
                                    borderColor: `#${theme.border}`,
                                  }}
                                  title="Click to edit column heading"
                                >
                                  {col.heading}
                                </h3>
                                <ul className="space-y-3">
                                  {col.bullets.map((b, bIdx) => (
                                    <li key={bIdx} className="text-xs md:text-sm flex items-start gap-2.5 leading-relaxed">
                                      <span
                                        className="w-2 h-2 rounded-full mt-1.5 shrink-0"
                                        style={{ backgroundColor: `#${theme.primary}` }}
                                      />
                                      <span
                                        contentEditable
                                        suppressContentEditableWarning
                                        onBlur={(e) => {
                                          const val = e.currentTarget.textContent?.trim();
                                          if (val && val !== b) {
                                            const nextCols = [...resolvedColumns];
                                            const nextBullets = [...col.bullets];
                                            nextBullets[bIdx] = val;
                                            nextCols[colIdx] = { ...col, bullets: nextBullets };
                                            updateActiveOfficeSlide(currentSlideIndex, { columns: nextCols });
                                          }
                                        }}
                                        className="flex-1 outline-none focus:ring-1 focus:ring-brand/40 rounded cursor-text"
                                        title="Click to edit bullet"
                                      >
                                        {b}
                                      </span>
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            ))}
                          </div>
                        )}

                        {/* 3. DATA TABLE LAYOUT */}
                        {activeSlide.layout === "table" && (
                          <div
                            className="rounded-xl border overflow-x-auto my-auto max-h-[340px] shadow-xs"
                            style={{ borderColor: `#${theme.border}` }}
                          >
                            <table className="w-full text-xs md:text-sm text-left border-collapse">
                              <thead className="sticky top-0 z-10">
                                <tr style={{ backgroundColor: `#${theme.primary}`, color: "#FFFFFF" }}>
                                  {resolvedTable.headers.map((h, hIdx) => (
                                    <th
                                      key={hIdx}
                                      contentEditable
                                      suppressContentEditableWarning
                                      onBlur={(e) => {
                                        const val = e.currentTarget.textContent?.trim();
                                        if (val && val !== h) {
                                          const nextHeaders = [...resolvedTable.headers];
                                          nextHeaders[hIdx] = val;
                                          updateActiveOfficeSlide(currentSlideIndex, {
                                            table: { headers: nextHeaders, rows: resolvedTable.rows },
                                          });
                                        }
                                      }}
                                      className="px-4 py-3 font-bold whitespace-nowrap outline-none cursor-text hover:bg-black/10"
                                      title="Click to edit table header"
                                    >
                                      {h}
                                    </th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody className="divide-y" style={{ borderColor: `#${theme.border}` }}>
                                {resolvedTable.rows.map((row, rIdx) => (
                                  <tr
                                    key={rIdx}
                                    style={{
                                      backgroundColor: rIdx % 2 === 0 ? `#${theme.bg}` : `#${theme.cardBg}`,
                                    }}
                                  >
                                    {row.map((cell, cIdx) => (
                                      <td
                                        key={cIdx}
                                        contentEditable
                                        suppressContentEditableWarning
                                        onBlur={(e) => {
                                          const val = e.currentTarget.textContent?.trim();
                                          if (val !== undefined && val !== cell) {
                                            const nextRows = resolvedTable.rows.map((r, ri) =>
                                              ri === rIdx ? r.map((c, ci) => (ci === cIdx ? val : c)) : r
                                            );
                                            updateActiveOfficeSlide(currentSlideIndex, {
                                              table: { headers: resolvedTable.headers, rows: nextRows },
                                            });
                                          }
                                        }}
                                        className="px-4 py-2.5 whitespace-nowrap outline-none hover:bg-black/5 dark:hover:bg-white/5 focus:bg-black/5 cursor-text"
                                        title="Click to edit cell"
                                      >
                                        {cell}
                                      </td>
                                    ))}
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}

                        {/* 4. TIMELINE / ROADMAP STEPS LAYOUT */}
                        {activeSlide.layout === "timeline" && (
                          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 my-auto">
                            {resolvedSteps.map((st, stIdx) => (
                              <div
                                key={stIdx}
                                className="p-3.5 rounded-xl border flex flex-col justify-between shadow-xs transition-all hover:shadow-md"
                                style={{
                                  backgroundColor: `#${theme.cardBg}`,
                                  borderColor: `#${theme.border}`,
                                }}
                              >
                                <div>
                                  <div
                                    contentEditable
                                    suppressContentEditableWarning
                                    onBlur={(e) => {
                                      const val = e.currentTarget.textContent?.trim();
                                      if (val && val !== st.step) {
                                        const next = [...resolvedSteps];
                                        next[stIdx] = { ...st, step: val };
                                        updateActiveOfficeSlide(currentSlideIndex, { steps: next });
                                      }
                                    }}
                                    className="w-8 h-8 rounded-lg flex items-center justify-center font-bold text-xs text-white mb-2 shadow-xs outline-none focus:ring-2 focus:ring-brand cursor-text"
                                    style={{ backgroundColor: `#${theme.primary}` }}
                                    title="Click to edit phase/step"
                                  >
                                    {st.step}
                                  </div>
                                  <div
                                    contentEditable
                                    suppressContentEditableWarning
                                    onBlur={(e) => {
                                      const val = e.currentTarget.textContent?.trim();
                                      if (val && val !== st.title) {
                                        const next = [...resolvedSteps];
                                        next[stIdx] = { ...st, title: val };
                                        updateActiveOfficeSlide(currentSlideIndex, { steps: next });
                                      }
                                    }}
                                    className="text-xs md:text-sm font-bold mb-1.5 outline-none focus:ring-1 focus:ring-brand/40 rounded cursor-text"
                                    title="Click to edit milestone title"
                                  >
                                    {st.title}
                                  </div>
                                </div>
                                <p
                                  contentEditable
                                  suppressContentEditableWarning
                                  onBlur={(e) => {
                                    const val = e.currentTarget.textContent?.trim();
                                    if (val !== undefined && val !== st.description) {
                                      const next = [...resolvedSteps];
                                      next[stIdx] = { ...st, description: val };
                                      updateActiveOfficeSlide(currentSlideIndex, { steps: next });
                                    }
                                  }}
                                  className="text-[11px] md:text-xs opacity-80 leading-relaxed outline-none focus:ring-1 focus:ring-brand/40 rounded cursor-text"
                                  title="Click to edit description"
                                >
                                  {st.description}
                                </p>
                              </div>
                            ))}
                          </div>
                        )}

                        {/* 5. IMPACT QUOTE LAYOUT */}
                        {activeSlide.layout === "quote" && (
                          <div className="px-6 py-5 flex items-start gap-4 my-auto">
                            <QuoteIcon
                              className="w-10 h-10 shrink-0 opacity-30"
                              style={{ color: `#${theme.accent}` }}
                            />
                            <div className="flex-1">
                              <p
                                contentEditable
                                suppressContentEditableWarning
                                onBlur={(e) => {
                                  const val = e.currentTarget.textContent?.trim();
                                  if (val && val !== resolvedQuote.text) {
                                    updateActiveOfficeSlide(currentSlideIndex, {
                                      quote: { ...resolvedQuote, text: val },
                                    });
                                  }
                                }}
                                className="text-lg md:text-2xl font-serif italic mb-3 leading-relaxed outline-none focus:ring-1 focus:ring-brand/40 rounded cursor-text"
                                title="Click to edit quote text"
                              >
                                "{resolvedQuote.text}"
                              </p>
                              <div className="text-xs md:text-sm font-bold" style={{ color: `#${theme.primary}` }}>
                                —{" "}
                                <span
                                  contentEditable
                                  suppressContentEditableWarning
                                  onBlur={(e) => {
                                    const val = e.currentTarget.textContent?.trim();
                                    if (val && val !== resolvedQuote.author) {
                                      updateActiveOfficeSlide(currentSlideIndex, {
                                        quote: { ...resolvedQuote, author: val },
                                      });
                                    }
                                  }}
                                  className="outline-none focus:ring-1 focus:ring-brand/40 rounded cursor-text"
                                  title="Click to edit author"
                                >
                                  {resolvedQuote.author || "Anonymous"}
                                </span>
                                {resolvedQuote.role && (
                                  <span
                                    contentEditable
                                    suppressContentEditableWarning
                                    onBlur={(e) => {
                                      const val = e.currentTarget.textContent?.trim();
                                      if (val !== undefined && val !== resolvedQuote.role) {
                                        updateActiveOfficeSlide(currentSlideIndex, {
                                          quote: { ...resolvedQuote, role: val },
                                        });
                                      }
                                    }}
                                    className="opacity-75 font-normal outline-none focus:ring-1 focus:ring-brand/40 rounded cursor-text"
                                    title="Click to edit role"
                                  >
                                    , {resolvedQuote.role}
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>
                        )}

                        {/* 6. STANDARD BULLETS LAYOUT (Default Fallback) */}
                        {(!activeSlide.layout || activeSlide.layout === "bullets") && (
                          <ul className="space-y-2.5 pl-1 my-auto">
                            {(activeSlide.bullets && activeSlide.bullets.length > 0
                              ? activeSlide.bullets
                              : ["Core platform architecture pattern", "High-velocity delivery pipeline", "Continuous quality verification"]
                            ).map((b, bIdx) => (
                              <li key={bIdx} className="text-xs md:text-sm flex items-start gap-2.5 leading-relaxed">
                                <span
                                  className="w-2 h-2 rounded-full mt-1.5 shrink-0 shadow-xs"
                                  style={{ backgroundColor: `#${theme.primary}` }}
                                />
                                <span
                                  contentEditable
                                  suppressContentEditableWarning
                                  onBlur={(e) => {
                                    const val = e.currentTarget.textContent?.trim();
                                    if (val && val !== b) {
                                      const next = [...(activeSlide.bullets || [])];
                                      next[bIdx] = val;
                                      updateActiveOfficeSlide(currentSlideIndex, { bullets: next });
                                    }
                                  }}
                                  className="flex-1 outline-none focus:ring-1 focus:ring-brand/40 rounded cursor-text"
                                  title="Click to edit bullet point"
                                >
                                  {b}
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </>
                  )}

                  {/* Slide Canvas Footer */}
                  <div
                    className="pt-2.5 border-t flex items-center justify-between text-[10px] opacity-70 font-mono"
                    style={{ borderColor: `#${theme.border}` }}
                  >
                    <span className="truncate max-w-[240px]">{activeOfficeDoc.title}</span>
                    <span className="shrink-0">
                      Slide {currentSlideIndex + 1} of {activeOfficeDoc.slides?.length || 1}
                    </span>
                  </div>
                </div>
              )}

              {/* Navigation Controls Bar */}
              <div className="mt-3 flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={currentSlideIndex <= 0}
                  onClick={() => setCurrentSlideIndex((c) => Math.max(0, c - 1))}
                  className="h-7 px-2.5 text-xs"
                >
                  <ChevronLeft className="w-3 h-3 mr-1" /> Prev
                </Button>
                <span className="text-xs font-mono text-muted-foreground px-2">
                  {currentSlideIndex + 1} / {activeOfficeDoc.slides?.length || 1}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={currentSlideIndex >= (activeOfficeDoc.slides?.length || 1) - 1}
                  onClick={() => setCurrentSlideIndex((c) => Math.min((activeOfficeDoc.slides?.length || 1) - 1, c + 1))}
                  className="h-7 px-2.5 text-xs"
                >
                  Next <ChevronRight className="w-3 h-3 ml-1" />
                </Button>
              </div>
            </div>
          </div>

          {/* Bottom Dynamic Slide Content Inspector / Editor */}
          <div className="h-64 border-t border-border bg-card/80 flex flex-col shrink-0">
            <div className="px-3 py-1.5 border-b border-border flex items-center justify-between">
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setActiveTab("edit")}
                  className={cn(
                    "text-xs font-medium pb-0.5 transition-colors cursor-pointer",
                    activeTab === "edit"
                      ? "text-brand border-b-2 border-brand"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  Edit Slide Content
                </button>
                <button
                  onClick={() => setActiveTab("notes")}
                  className={cn(
                    "text-xs font-medium pb-0.5 transition-colors cursor-pointer",
                    activeTab === "notes"
                      ? "text-brand border-b-2 border-brand"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  Speaker Notes
                </button>
              </div>

              {activeSlide && (
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] text-muted-foreground font-medium">Layout:</span>
                  <Select
                    value={activeSlide.layout || "bullets"}
                    onValueChange={(val) =>
                      updateActiveOfficeSlide(currentSlideIndex, { layout: val as SlideLayout })
                    }
                  >
                    <SelectTrigger className="h-6 text-[11px] w-[110px] border-border/60">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="title">Title / Cover</SelectItem>
                      <SelectItem value="bullets">Bullets</SelectItem>
                      <SelectItem value="cards">KPI Cards</SelectItem>
                      <SelectItem value="split">2-Col Split</SelectItem>
                      <SelectItem value="table">Table</SelectItem>
                      <SelectItem value="timeline">Timeline</SelectItem>
                      <SelectItem value="quote">Quote</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>

            <div className="flex-1 p-3 overflow-y-auto">
              {activeTab === "edit" && activeSlide && (
                <div className="space-y-3 max-w-4xl">
                  {/* Common: Title & Subtitle */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <div>
                      <Label className="text-[10px] text-muted-foreground font-semibold">Slide Title</Label>
                      <Input
                        value={activeSlide.title}
                        onChange={(e) => updateActiveOfficeSlide(currentSlideIndex, { title: e.target.value })}
                        className="h-7 text-xs mt-0.5"
                        placeholder="Slide title"
                      />
                    </div>
                    <div>
                      <Label className="text-[10px] text-muted-foreground font-semibold">Subtitle</Label>
                      <Input
                        value={activeSlide.subtitle || ""}
                        onChange={(e) => updateActiveOfficeSlide(currentSlideIndex, { subtitle: e.target.value })}
                        className="h-7 text-xs mt-0.5"
                        placeholder="Optional subtitle"
                      />
                    </div>
                  </div>

                  {/* 1. TIMELINE / ROADMAP EDITOR */}
                  {activeSlide.layout === "timeline" && (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <Label className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wider">
                          Timeline Milestones ({resolvedSteps.length})
                        </Label>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 text-[11px] px-2.5"
                          onClick={() => {
                            const next = [
                              ...resolvedSteps,
                              {
                                step: `0${resolvedSteps.length + 1}`,
                                title: `Phase ${resolvedSteps.length + 1}`,
                                description: "Milestone deliverable details",
                              },
                            ];
                            updateActiveOfficeSlide(currentSlideIndex, { steps: next });
                          }}
                        >
                          <Plus className="w-3 h-3 mr-1" /> Add Milestone
                        </Button>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
                        {resolvedSteps.map((st, sIdx) => (
                          <div
                            key={sIdx}
                            className="p-2 rounded-lg border border-border/80 bg-background/60 space-y-1.5 relative group"
                          >
                            <div className="flex items-center gap-1.5">
                              <Input
                                value={st.step}
                                onChange={(e) => {
                                  const next = [...resolvedSteps];
                                  next[sIdx] = { ...st, step: e.target.value };
                                  updateActiveOfficeSlide(currentSlideIndex, { steps: next });
                                }}
                                className="h-6 w-12 text-xs font-mono font-bold text-center"
                                placeholder="01"
                              />
                              <Input
                                value={st.title}
                                onChange={(e) => {
                                  const next = [...resolvedSteps];
                                  next[sIdx] = { ...st, title: e.target.value };
                                  updateActiveOfficeSlide(currentSlideIndex, { steps: next });
                                }}
                                className="h-6 text-xs flex-1 font-semibold"
                                placeholder="Phase Title"
                              />
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-6 w-6 text-muted-foreground hover:text-destructive shrink-0"
                                onClick={() => {
                                  if (resolvedSteps.length <= 1) return;
                                  const next = resolvedSteps.filter((_, i) => i !== sIdx);
                                  updateActiveOfficeSlide(currentSlideIndex, { steps: next });
                                }}
                                title="Remove milestone"
                              >
                                <Trash2 className="w-3 h-3" />
                              </Button>
                            </div>
                            <Textarea
                              value={st.description}
                              onChange={(e) => {
                                const next = [...resolvedSteps];
                                next[sIdx] = { ...st, description: e.target.value };
                                updateActiveOfficeSlide(currentSlideIndex, { steps: next });
                              }}
                              rows={3}
                              className="text-xs resize-none"
                              placeholder="Milestone description..."
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* 2. SPLIT 2-COLUMN EDITOR */}
                  {activeSlide.layout === "split" && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                      {resolvedColumns.map((col, colIdx) => (
                        <div
                          key={colIdx}
                          className="p-2.5 rounded-lg border border-border/80 bg-background/60 space-y-1.5"
                        >
                          <Label className="text-[10px] text-muted-foreground font-semibold uppercase">
                            Column {colIdx + 1} Heading
                          </Label>
                          <Input
                            value={col.heading}
                            onChange={(e) => {
                              const next = [...resolvedColumns];
                              next[colIdx] = { ...col, heading: e.target.value };
                              updateActiveOfficeSlide(currentSlideIndex, { columns: next });
                            }}
                            className="h-7 text-xs font-semibold"
                            placeholder={`Column ${colIdx + 1} Heading`}
                          />
                          <Label className="text-[10px] text-muted-foreground font-semibold uppercase">
                            Column {colIdx + 1} Bullets (one per line)
                          </Label>
                          <Textarea
                            value={col.bullets.join("\n")}
                            onChange={(e) => {
                              const next = [...resolvedColumns];
                              next[colIdx] = { ...col, bullets: e.target.value.split("\n").filter(Boolean) };
                              updateActiveOfficeSlide(currentSlideIndex, { columns: next });
                            }}
                            rows={3}
                            className="text-xs resize-none"
                            placeholder="Key point 1&#10;Key point 2&#10;Key point 3"
                          />
                        </div>
                      ))}
                    </div>
                  )}

                  {/* 3. KPI / FEATURE CARDS EDITOR */}
                  {activeSlide.layout === "cards" && (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <Label className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wider">
                          Metric / KPI Cards ({resolvedCards.length})
                        </Label>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 text-[11px] px-2.5"
                          onClick={() => {
                            if (resolvedCards.length >= 4) {
                              toast.error("Maximum 4 cards per slide for executive clarity.");
                              return;
                            }
                            const next = [
                              ...resolvedCards,
                              {
                                title: "New Metric",
                                value: "100%",
                                badge: "TARGET",
                                description: "Performance indicator details",
                              },
                            ];
                            updateActiveOfficeSlide(currentSlideIndex, { cards: next });
                          }}
                        >
                          <Plus className="w-3 h-3 mr-1" /> Add Card
                        </Button>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
                        {resolvedCards.map((c, cIdx) => (
                          <div
                            key={cIdx}
                            className="p-2.5 rounded-lg border border-border/80 bg-background/60 space-y-1.5"
                          >
                            <div className="flex items-center justify-between">
                              <span className="text-[10px] font-bold text-brand uppercase">Card {cIdx + 1}</span>
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-5 w-5 text-muted-foreground hover:text-destructive"
                                onClick={() => {
                                  if (resolvedCards.length <= 1) return;
                                  const next = resolvedCards.filter((_, i) => i !== cIdx);
                                  updateActiveOfficeSlide(currentSlideIndex, { cards: next });
                                }}
                              >
                                <Trash2 className="w-3 h-3" />
                              </Button>
                            </div>
                            <div className="grid grid-cols-2 gap-1.5">
                              <Input
                                value={c.value || ""}
                                onChange={(e) => {
                                  const next = [...resolvedCards];
                                  next[cIdx] = { ...c, value: e.target.value };
                                  updateActiveOfficeSlide(currentSlideIndex, { cards: next });
                                }}
                                className="h-6 text-xs font-bold font-mono"
                                placeholder="Value (e.g. 99.9%)"
                              />
                              <Input
                                value={c.badge || ""}
                                onChange={(e) => {
                                  const next = [...resolvedCards];
                                  next[cIdx] = { ...c, badge: e.target.value };
                                  updateActiveOfficeSlide(currentSlideIndex, { cards: next });
                                }}
                                className="h-6 text-xs"
                                placeholder="Badge (e.g. HIGH SLA)"
                              />
                            </div>
                            <Input
                              value={c.title}
                              onChange={(e) => {
                                const next = [...resolvedCards];
                                next[cIdx] = { ...c, title: e.target.value };
                                updateActiveOfficeSlide(currentSlideIndex, { cards: next });
                              }}
                              className="h-6 text-xs font-semibold"
                              placeholder="Card Title"
                            />
                            <Textarea
                              value={c.description}
                              onChange={(e) => {
                                const next = [...resolvedCards];
                                next[cIdx] = { ...c, description: e.target.value };
                                updateActiveOfficeSlide(currentSlideIndex, { cards: next });
                              }}
                              rows={2}
                              className="text-xs resize-none"
                              placeholder="Card description..."
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* 4. DATA TABLE EDITOR */}
                  {activeSlide.layout === "table" && (
                    <div className="space-y-1.5">
                      <div>
                        <Label className="text-[10px] text-muted-foreground font-semibold">Table Headers (comma-separated)</Label>
                        <Input
                          value={resolvedTable.headers.join(", ")}
                          onChange={(e) => {
                            const headers = e.target.value.split(",").map((h) => h.trim()).filter(Boolean);
                            updateActiveOfficeSlide(currentSlideIndex, {
                              table: {
                                headers,
                                rows: resolvedTable.rows,
                              },
                            });
                          }}
                          className="h-7 text-xs mt-0.5"
                          placeholder="Header 1, Header 2, Header 3"
                        />
                      </div>
                      <div>
                        <Label className="text-[10px] text-muted-foreground font-semibold">Table Rows (one row per line, comma-separated)</Label>
                        <Textarea
                          value={resolvedTable.rows.map((r) => r.join(", ")).join("\n")}
                          onChange={(e) => {
                            const rows = e.target.value
                              .split("\n")
                              .filter(Boolean)
                              .map((line) => line.split(",").map((c) => c.trim()));
                            updateActiveOfficeSlide(currentSlideIndex, {
                              table: {
                                headers: resolvedTable.headers,
                                rows,
                              },
                            });
                          }}
                          rows={3}
                          className="text-xs mt-0.5 resize-none font-mono"
                          placeholder="Value 1, Value 2, Value 3"
                        />
                      </div>
                    </div>
                  )}

                  {/* 5. IMPACT QUOTE EDITOR */}
                  {activeSlide.layout === "quote" && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <div className="sm:col-span-2">
                        <Label className="text-[10px] text-muted-foreground font-semibold">Quote Text</Label>
                        <Textarea
                          value={resolvedQuote.text}
                          onChange={(e) =>
                            updateActiveOfficeSlide(currentSlideIndex, {
                              quote: { ...resolvedQuote, text: e.target.value },
                            })
                          }
                          rows={2}
                          className="text-xs mt-0.5 resize-none"
                        />
                      </div>
                      <div>
                        <Label className="text-[10px] text-muted-foreground font-semibold">Author</Label>
                        <Input
                          value={resolvedQuote.author || ""}
                          onChange={(e) =>
                            updateActiveOfficeSlide(currentSlideIndex, {
                              quote: { text: resolvedQuote.text, author: e.target.value, role: resolvedQuote.role },
                            })
                          }
                          className="h-7 text-xs mt-0.5"
                        />
                      </div>
                      <div>
                        <Label className="text-[10px] text-muted-foreground font-semibold">Role / Organization</Label>
                        <Input
                          value={resolvedQuote.role || ""}
                          onChange={(e) =>
                            updateActiveOfficeSlide(currentSlideIndex, {
                              quote: { text: resolvedQuote.text, author: resolvedQuote.author, role: e.target.value },
                            })
                          }
                          className="h-7 text-xs mt-0.5"
                        />
                      </div>
                    </div>
                  )}

                  {/* 6. STANDARD BULLETS / COVER (Default Fallback) */}
                  {(!activeSlide.layout || activeSlide.layout === "bullets" || activeSlide.layout === "title") && (
                    <div>
                      <Label className="text-[10px] text-muted-foreground font-semibold">Bullet Points (one per line)</Label>
                      <Textarea
                        value={activeSlide.bullets?.join("\n") || ""}
                        onChange={(e) =>
                          updateActiveOfficeSlide(currentSlideIndex, {
                            bullets: e.target.value.split("\n").filter(Boolean),
                          })
                        }
                        rows={3}
                        className="text-xs mt-0.5 resize-none"
                        placeholder="First key point...&#10;Second key point..."
                      />
                    </div>
                  )}
                </div>
              )}

              {activeTab === "notes" && activeSlide && (
                <div className="max-w-3xl">
                  <Label className="text-[10px] text-muted-foreground font-semibold">Speaker Notes</Label>
                  <Textarea
                    value={activeSlide.notes || ""}
                    onChange={(e) => updateActiveOfficeSlide(currentSlideIndex, { notes: e.target.value })}
                    rows={4}
                    placeholder="Enter notes to remember while presenting..."
                    className="text-xs mt-0.5 resize-none"
                  />
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* =================================================================== */}
      {/* 3. DOCUMENT & PDF STUDIO */}
      {/* =================================================================== */}
      {(activeOfficeDoc?.type === "document" || activeOfficeDoc?.type === "pdf") && (() => {
        const activePage = paginatedPages[Math.min(paginatedPages.length - 1, Math.max(0, currentDocPage - 1))] || paginatedPages[0];

        return (
          <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
            <div className="flex-1 flex min-h-0 overflow-hidden">
              {/* Left Page Filmstrip — Matches Presentation Studio w-44 */}
              <div className="w-48 border-r border-border bg-card/20 flex flex-col shrink-0 overflow-hidden">
                <div className="p-2 border-b border-border/60 flex items-center justify-between">
                  <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                    Pages ({paginatedPages.length})
                  </span>
                  <span className="text-[9px] font-mono text-muted-foreground">
                    {currentDocPage}/{paginatedPages.length}
                  </span>
                </div>

                <ScrollArea className="flex-1 p-1.5">
                  <div className="space-y-1.5">
                    {paginatedPages.map((page) => {
                      const isActive = page.pageNumber === currentDocPage;
                      return (
                        <div
                          key={page.pageNumber}
                          onClick={() => setCurrentDocPage(page.pageNumber)}
                          className={cn(
                            "group relative p-2.5 rounded-lg border transition-all cursor-pointer text-left",
                            isActive
                              ? "border-brand bg-brand/5 ring-1 ring-brand/30 shadow-xs"
                              : "border-border/60 bg-card/50 hover:bg-accent/40 hover:border-border"
                          )}
                        >
                          <div className="flex items-center justify-between mb-1">
                            <span
                              className={cn(
                                "text-[9px] font-mono px-1.5 py-0.2 rounded border font-semibold",
                                isActive
                                  ? "bg-brand/15 text-brand border-brand/30"
                                  : "bg-background/80 text-muted-foreground border-border/60"
                              )}
                            >
                              {page.pageNumber}
                            </span>
                            <span className="text-[9px] font-medium text-muted-foreground capitalize flex items-center gap-1">
                              <FileText className="w-3 h-3 text-muted-foreground" />
                              {page.isCover ? "Cover" : "Section"}
                            </span>
                          </div>

                          <div className="text-xs font-semibold text-foreground line-clamp-2 leading-snug">
                            {page.isCover
                              ? (activeOfficeDoc.title || "Cover Page")
                              : page.sections.map((s) => s.sec.heading).join(", ") || "Untitled Section"}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </ScrollArea>
              </div>

              {/* Center Canvas: Active Page Sheet (Single Page Focus) */}
              <div className="flex-1 flex flex-col bg-accent/15 p-4 md:p-6 overflow-y-auto items-center justify-between min-h-0">
                {activePage && (
                  <div
                    className="w-full max-w-3xl min-h-[540px] rounded-xl border shadow-xl p-6 md:p-10 flex flex-col justify-between my-auto transition-all duration-200 relative"
                    style={{
                      backgroundColor: `#${theme.bg}`,
                      borderColor: `#${theme.border}`,
                      color: `#${theme.textDark}`,
                    }}
                  >
                    {/* Top Decorative Accent Line */}
                    <div
                      className="absolute top-0 left-0 right-0 h-1.5 rounded-t-xl"
                      style={{ backgroundColor: `#${theme.primary}` }}
                    />

                    {/* Page Header Area */}
                    {activePage.isCover ? (
                      /* Refined Executive Cover Banner */
                      <div
                        className="p-5 md:p-6 rounded-xl mb-6 text-center border relative group/header shadow-xs"
                        style={{
                          backgroundColor: `#${theme.cardBg}`,
                          borderColor: `#${theme.border}`,
                        }}
                      >
                        <div className="flex items-center justify-center gap-2 mb-2.5">
                          <span
                            className="w-1.5 h-3.5 rounded-full"
                            style={{ backgroundColor: `#${theme.primary}` }}
                          />
                          <span
                            className="text-[10px] uppercase tracking-widest font-mono font-bold"
                            style={{ color: `#${theme.primary}` }}
                          >
                            Executive Report
                          </span>
                        </div>

                        <h1
                          contentEditable
                          suppressContentEditableWarning
                          onBlur={(e) => {
                            const val = e.currentTarget.textContent?.trim();
                            if (val && val !== activeOfficeDoc.title) {
                              updateActiveOfficeDocMeta({ title: val });
                            }
                          }}
                          className="text-xl md:text-2xl font-extrabold tracking-tight mb-2 outline-none hover:bg-black/5 dark:hover:bg-white/5 focus:ring-1 focus:ring-brand/40 rounded px-1 -mx-1 transition-colors cursor-text"
                          style={{ color: `#${theme.primary}` }}
                          title="Click to edit document title"
                        >
                          {activeOfficeDoc.title}
                        </h1>

                        {activeOfficeDoc.subtitle && (
                          <p
                            contentEditable
                            suppressContentEditableWarning
                            onBlur={(e) => {
                              const val = e.currentTarget.textContent?.trim();
                              if (val !== undefined && val !== activeOfficeDoc.subtitle) {
                                updateActiveOfficeDocMeta({ subtitle: val });
                              }
                            }}
                            className="text-xs md:text-sm max-w-xl mx-auto opacity-80 leading-relaxed outline-none hover:bg-black/5 dark:hover:bg-white/5 focus:ring-1 focus:ring-brand/40 rounded px-1 -mx-1 transition-colors cursor-text"
                            style={{ color: `#${theme.textDark}` }}
                            title="Click to edit subtitle"
                          >
                            {activeOfficeDoc.subtitle}
                          </p>
                        )}

                        <div
                          className="text-[11px] opacity-70 mt-3.5 font-mono flex items-center justify-center gap-2 border-t pt-2.5"
                          style={{ borderColor: `#${theme.border}` }}
                        >
                          <span>Prepared by</span>
                          <span
                            contentEditable
                            suppressContentEditableWarning
                            onBlur={(e) => {
                              const val = e.currentTarget.textContent?.trim();
                              if (val && val !== activeOfficeDoc.author) {
                                updateActiveOfficeDocMeta({ author: val });
                              }
                            }}
                            className="outline-none hover:bg-black/5 dark:hover:bg-white/5 focus:ring-1 focus:ring-brand/40 rounded px-1 cursor-text font-semibold"
                            style={{ color: `#${theme.primary}` }}
                            title="Click to edit author"
                          >
                            {activeOfficeDoc.author || "HermOS AI Studio"}
                          </span>
                          <span>•</span>
                          <span>{new Date(activeOfficeDoc.updatedAt).toLocaleDateString()}</span>
                        </div>
                      </div>
                    ) : (
                      /* Running Top Header for Pages 2+ */
                      <div
                        className="pb-2.5 border-b mb-5 flex items-center justify-between text-xs font-mono opacity-70"
                        style={{ borderColor: `#${theme.border}` }}
                      >
                        <span className="truncate max-w-sm font-semibold" style={{ color: `#${theme.primary}` }}>
                          {activeOfficeDoc.title}
                        </span>
                        <span>Page {activePage.pageNumber} of {paginatedPages.length}</span>
                      </div>
                    )}

                    {/* Content of Sections on this Page */}
                    <div className="space-y-6 flex-1">
                      {activePage.sections.map(({ sec, secIndex }) => (
                        <div key={sec.id || secIndex} className="group/sec">
                          {/* Section Heading */}
                          <div
                            className="flex items-center justify-between pb-1.5 border-b mb-2.5"
                            style={{ borderColor: `#${theme.border}` }}
                          >
                            <div className="flex items-center gap-2 flex-1 min-w-0">
                              <span
                                className="w-1.5 h-4.5 rounded-full shrink-0"
                                style={{ backgroundColor: `#${theme.primary}` }}
                              />
                              <h2
                                contentEditable
                                suppressContentEditableWarning
                                onBlur={(e) => {
                                  const val = e.currentTarget.textContent?.trim();
                                  if (val && val !== sec.heading) {
                                    updateActiveOfficeSection(secIndex, { heading: val });
                                  }
                                }}
                                className="text-base md:text-lg font-bold outline-none focus:ring-1 focus:ring-brand/40 rounded cursor-text flex-1"
                                style={{ color: `#${theme.primary}` }}
                                title="Click to edit heading"
                              >
                                {sec.heading}
                              </h2>
                            </div>
                          </div>

                          {/* Subheading */}
                          {sec.subheading && (
                            <p
                              contentEditable
                              suppressContentEditableWarning
                              onBlur={(e) => {
                                const val = e.currentTarget.textContent?.trim();
                                if (val !== undefined && val !== sec.subheading) {
                                  updateActiveOfficeSection(secIndex, { subheading: val });
                                }
                              }}
                              className="text-xs italic mb-2.5 opacity-75 outline-none focus:ring-1 focus:ring-brand/40 rounded p-0.5 cursor-text"
                              style={{ color: `#${theme.textMuted}` }}
                              title="Click to edit subheading"
                            >
                              {sec.subheading}
                            </p>
                          )}

                          {/* Callout Box */}
                          {sec.callout && (
                            <div
                              className="p-3.5 rounded-r-xl border-l-4 my-2.5 text-xs relative group/callout shadow-xs"
                              style={{
                                backgroundColor: `#${theme.cardBg}`,
                                borderColor: `#${theme.primary}`,
                              }}
                            >
                              <div
                                contentEditable
                                suppressContentEditableWarning
                                onBlur={(e) => {
                                  const val = e.currentTarget.textContent?.trim();
                                  if (val !== undefined && val !== sec.callout?.title) {
                                    updateActiveOfficeSection(secIndex, {
                                      callout: { ...sec.callout!, title: val },
                                    });
                                  }
                                }}
                                className="font-bold mb-1 outline-none focus:ring-1 focus:ring-brand/40 rounded cursor-text"
                                style={{ color: `#${theme.primary}` }}
                                title="Click to edit callout title"
                              >
                                {sec.callout.title || "Key Takeaway"}
                              </div>
                              <div
                                contentEditable
                                suppressContentEditableWarning
                                onBlur={(e) => {
                                  const val = e.currentTarget.textContent?.trim();
                                  if (val && val !== sec.callout?.text) {
                                    updateActiveOfficeSection(secIndex, {
                                      callout: { ...sec.callout!, text: val },
                                    });
                                  }
                                }}
                                className="leading-relaxed outline-none focus:ring-1 focus:ring-brand/40 rounded cursor-text"
                                title="Click to edit callout body"
                              >
                                {sec.callout.text}
                              </div>
                            </div>
                          )}

                          {/* Paragraphs */}
                          <div className="space-y-2.5 text-xs md:text-sm leading-relaxed">
                            {sec.paragraphs?.map((p, pIdx) => (
                              <div key={pIdx} className="group/para relative flex items-start gap-2">
                                <p
                                  contentEditable
                                  suppressContentEditableWarning
                                  onBlur={(e) => {
                                    const val = e.currentTarget.textContent?.trim();
                                    if (val !== undefined && val !== p) {
                                      const nextParas = [...(sec.paragraphs || [])];
                                      nextParas[pIdx] = val;
                                      updateActiveOfficeSection(secIndex, { paragraphs: nextParas });
                                    }
                                  }}
                                  className="flex-1 outline-none focus:ring-1 focus:ring-brand/40 rounded p-1 cursor-text hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                                  title="Click to edit paragraph"
                                >
                                  {p}
                                </p>
                                <button
                                  onClick={() => {
                                    const nextParas = (sec.paragraphs || []).filter((_, idx) => idx !== pIdx);
                                    updateActiveOfficeSection(secIndex, { paragraphs: nextParas });
                                  }}
                                  className="opacity-0 group-hover/para:opacity-100 p-1 text-muted-foreground hover:text-destructive shrink-0 mt-0.5 transition-opacity"
                                  title="Delete paragraph"
                                >
                                  <Trash2 className="w-3 h-3" />
                                </button>
                              </div>
                            ))}
                          </div>

                          {/* Bullets */}
                          {sec.bullets && sec.bullets.length > 0 && (
                            <ul className="mt-3 space-y-1.5 pl-2 text-xs md:text-sm">
                              {sec.bullets.map((b, bIdx) => (
                                <li key={bIdx} className="group/bullet flex items-start gap-2">
                                  <span
                                    className="w-1.5 h-1.5 rounded-full mt-1.5 shrink-0"
                                    style={{ backgroundColor: `#${theme.primary}` }}
                                  />
                                  <span
                                    contentEditable
                                    suppressContentEditableWarning
                                    onBlur={(e) => {
                                      const val = e.currentTarget.textContent?.trim();
                                      if (val !== undefined && val !== b) {
                                        const nextBullets = [...(sec.bullets || [])];
                                        nextBullets[bIdx] = val;
                                        updateActiveOfficeSection(secIndex, { bullets: nextBullets });
                                      }
                                    }}
                                    className="flex-1 outline-none focus:ring-1 focus:ring-brand/40 rounded p-0.5 cursor-text hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                                    title="Click to edit bullet"
                                  >
                                    {b}
                                  </span>
                                  <button
                                    onClick={() => {
                                      const nextBullets = (sec.bullets || []).filter((_, idx) => idx !== bIdx);
                                      updateActiveOfficeSection(secIndex, { bullets: nextBullets });
                                    }}
                                    className="opacity-0 group-hover/bullet:opacity-100 p-0.5 text-muted-foreground hover:text-destructive shrink-0 transition-opacity"
                                    title="Delete bullet"
                                  >
                                    <Trash2 className="w-3 h-3" />
                                  </button>
                                </li>
                              ))}
                            </ul>
                          )}

                          {/* Table */}
                          {sec.table && sec.table.headers.length > 0 && (
                            <div
                              className="mt-3.5 rounded-xl border overflow-hidden shadow-xs"
                              style={{ borderColor: `#${theme.border}` }}
                            >
                              <table className="w-full text-xs text-left border-collapse">
                                <thead>
                                  <tr style={{ backgroundColor: `#${theme.primary}`, color: "#FFFFFF" }}>
                                    {sec.table.headers.map((h, hIdx) => (
                                      <th
                                        key={hIdx}
                                        contentEditable
                                        suppressContentEditableWarning
                                        onBlur={(e) => {
                                          const val = e.currentTarget.textContent?.trim();
                                          if (val && val !== h) {
                                            const nextHeaders = [...sec.table!.headers];
                                            nextHeaders[hIdx] = val;
                                            updateActiveOfficeSection(secIndex, {
                                              table: { headers: nextHeaders, rows: sec.table!.rows },
                                            });
                                          }
                                        }}
                                        className="px-3 py-2 font-semibold outline-none cursor-text hover:bg-black/10"
                                        title="Click to edit table header"
                                      >
                                        {h}
                                      </th>
                                    ))}
                                    <th className="w-6"></th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y" style={{ borderColor: `#${theme.border}` }}>
                                  {sec.table.rows.map((row, rIdx) => (
                                    <tr
                                      key={rIdx}
                                      className="group/row"
                                      style={{
                                        backgroundColor: rIdx % 2 === 0 ? `#${theme.bg}` : `#${theme.cardBg}`,
                                      }}
                                    >
                                      {row.map((cell, cIdx) => (
                                        <td
                                          key={cIdx}
                                          contentEditable
                                          suppressContentEditableWarning
                                          onBlur={(e) => {
                                            const val = e.currentTarget.textContent?.trim();
                                            if (val !== undefined && val !== cell) {
                                              const nextRows = sec.table!.rows.map((r, ri) =>
                                                ri === rIdx ? r.map((c, ci) => (ci === cIdx ? val : c)) : r
                                              );
                                              updateActiveOfficeSection(secIndex, {
                                                table: { headers: sec.table!.headers, rows: nextRows },
                                              });
                                            }
                                          }}
                                          className="px-3 py-1.5 outline-none cursor-text hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                                          title="Click to edit cell"
                                        >
                                          {renderStatusCell(cell)}
                                        </td>
                                      ))}
                                      <td className="px-1 text-center">
                                        <button
                                          onClick={() => {
                                            const nextRows = sec.table!.rows.filter((_, ri) => ri !== rIdx);
                                            updateActiveOfficeSection(secIndex, {
                                              table: { headers: sec.table!.headers, rows: nextRows },
                                            });
                                          }}
                                          className="opacity-0 group-hover/row:opacity-100 p-1 text-muted-foreground hover:text-destructive transition-opacity"
                                          title="Delete table row"
                                        >
                                          <Trash2 className="w-3 h-3" />
                                        </button>
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                              <div
                                className="p-2 border-t flex justify-between items-center bg-card/30"
                                style={{ borderColor: `#${theme.border}` }}
                              >
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => {
                                    const newRow = new Array(sec.table!.headers.length).fill("—");
                                    const nextRows = [...sec.table!.rows, newRow];
                                    updateActiveOfficeSection(secIndex, {
                                      table: { headers: sec.table!.headers, rows: nextRows },
                                    });
                                  }}
                                  className="h-6 text-[11px] gap-1 text-brand hover:bg-brand/10 px-2"
                                >
                                  <Plus className="w-3 h-3" />
                                  <span>Add Row</span>
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => {
                                    updateActiveOfficeSection(secIndex, { table: undefined });
                                  }}
                                  className="h-6 text-[11px] text-muted-foreground hover:text-destructive px-2"
                                >
                                  <span>Remove Table</span>
                                </Button>
                              </div>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>

                    {/* Page Bottom Running Footer */}
                    <div
                      className="pt-3 border-t mt-6 flex items-center justify-between text-[11px] opacity-60 font-mono"
                      style={{ borderColor: `#${theme.border}` }}
                    >
                      <span>HermOS Office Studio</span>
                      <span>Page {activePage.pageNumber} of {paginatedPages.length}</span>
                    </div>
                  </div>
                )}

                {/* Navigation Controls Bar — Matches Presentation Studio */}
                <div className="mt-3 flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={currentDocPage <= 1}
                    onClick={() => setCurrentDocPage((c) => Math.max(1, c - 1))}
                    className="h-7 px-2.5 text-xs"
                  >
                    <ChevronLeft className="w-3 h-3 mr-1" /> Prev
                  </Button>
                  <span className="text-xs font-mono text-muted-foreground px-2">
                    {currentDocPage} / {paginatedPages.length}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={currentDocPage >= paginatedPages.length}
                    onClick={() => setCurrentDocPage((c) => Math.min(paginatedPages.length, c + 1))}
                    className="h-7 px-2.5 text-xs"
                  >
                    Next <ChevronRight className="w-3 h-3 ml-1" />
                  </Button>
                </div>
              </div>
            </div>

            {/* Bottom Dynamic Document / Section Content Toolbar */}
            <div className="h-10 border-t border-border bg-card/80 px-3 flex items-center justify-between shrink-0 text-xs">
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                  Page Actions:
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    const secIdx = activePage.sections[0]?.secIndex ?? 0;
                    const sec = activeOfficeDoc.sections?.[secIdx];
                    if (sec) {
                      const nextParas = [...(sec.paragraphs || []), "New paragraph text..."];
                      updateActiveOfficeSection(secIdx, { paragraphs: nextParas });
                    }
                  }}
                  className="h-7 px-2 text-[11px] gap-1 text-muted-foreground hover:text-foreground"
                >
                  <Plus className="w-3 h-3" />
                  <span>Paragraph</span>
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    const secIdx = activePage.sections[0]?.secIndex ?? 0;
                    const sec = activeOfficeDoc.sections?.[secIdx];
                    if (sec) {
                      const nextBullets = [...(sec.bullets || []), "New key takeaway..."];
                      updateActiveOfficeSection(secIdx, { bullets: nextBullets });
                    }
                  }}
                  className="h-7 px-2 text-[11px] gap-1 text-muted-foreground hover:text-foreground"
                >
                  <Plus className="w-3 h-3" />
                  <span>Bullet</span>
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    const secIdx = activePage.sections[0]?.secIndex ?? 0;
                    updateActiveOfficeSection(secIdx, {
                      table: {
                        headers: ["Metric", "Target", "Status"],
                        rows: [["Performance", "99.9%", "On Track"]],
                      },
                    });
                  }}
                  className="h-7 px-2 text-[11px] gap-1 text-muted-foreground hover:text-foreground"
                >
                  <Plus className="w-3 h-3" />
                  <span>Table</span>
                </Button>
              </div>

              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => addActiveOfficeSection()}
                  className="h-7 px-2.5 text-[11px] gap-1.5"
                >
                  <Plus className="w-3 h-3" />
                  <span>Add Section</span>
                </Button>
                {(activeOfficeDoc.sections?.length || 0) > 1 && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      const secIdx = activePage.sections[0]?.secIndex ?? 0;
                      deleteActiveOfficeSection(secIdx);
                    }}
                    className="h-7 px-2 text-[11px] text-muted-foreground hover:text-destructive gap-1"
                    title="Delete this section"
                  >
                    <Trash2 className="w-3 h-3" />
                    <span>Delete</span>
                  </Button>
                )}
              </div>
            </div>
          </div>
        );
      })()}

      {/* =================================================================== */}
      {/* 4. FULLSCREEN SLIDESHOW OVERLAY */}
      {/* =================================================================== */}
      <AnimatePresence>
        {isSlideshow && activeSlide && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/95 flex flex-col justify-between p-6 select-none"
          >
            {/* Top Bar */}
            <div className="flex items-center justify-between text-white/80">
              <span className="text-sm font-semibold truncate max-w-md">{activeOfficeDoc?.title}</span>
              <div className="flex items-center gap-3">
                <span className="text-xs font-mono">
                  {currentSlideIndex + 1} / {activeOfficeDoc?.slides?.length}
                </span>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => setIsSlideshow(false)}
                  className="h-7 w-7 text-white hover:bg-white/10"
                >
                  <Minimize2 className="w-4 h-4" />
                </Button>
              </div>
            </div>

            {/* Center Canvas */}
            <div className="flex-1 flex items-center justify-center p-4">
              <div
                className="w-full max-w-4xl min-h-[380px] rounded-2xl border shadow-2xl p-8 flex flex-col justify-between"
                style={{
                  backgroundColor: `#${activeSlide.layout === "title" && theme.isDarkTheme ? theme.primaryDark : theme.bg}`,
                  borderColor: `#${theme.border}`,
                  color: `#${theme.textDark}`,
                }}
              >
                {activeSlide.layout === "title" ? (
                  <div className="flex-1 flex flex-col justify-center py-6">
                    <h1 className="text-4xl md:text-5xl font-bold tracking-tight mb-3">{activeSlide.title}</h1>
                    {activeSlide.subtitle && (
                      <p className="text-xl opacity-80" style={{ color: `#${theme.secondary}` }}>
                        {activeSlide.subtitle}
                      </p>
                    )}
                  </div>
                ) : (
                  <>
                    <div>
                      <div className="flex items-center gap-3 mb-2">
                        <span
                          className="w-2 h-8 rounded-full shrink-0"
                          style={{ backgroundColor: `#${theme.primary}` }}
                        />
                        <h2 className="text-3xl md:text-4xl font-bold tracking-tight">{activeSlide.title}</h2>
                      </div>
                      {activeSlide.subtitle && (
                        <p className="text-base md:text-lg pl-5 opacity-80" style={{ color: `#${theme.textMuted}` }}>
                          {activeSlide.subtitle}
                        </p>
                      )}
                    </div>

                    <div className="flex-1 my-6 flex flex-col justify-center min-h-0 overflow-y-auto">
                      {/* 1. KPI / FEATURE CARDS */}
                      {activeSlide.layout === "cards" && (
                        <div className="grid grid-cols-2 md:grid-cols-3 gap-5 my-auto">
                          {resolvedCards.map((c, cIdx) => (
                            <div
                              key={cIdx}
                              className="p-6 rounded-2xl border flex flex-col justify-between shadow-sm"
                              style={{
                                backgroundColor: `#${theme.cardBg}`,
                                borderColor: `#${theme.border}`,
                              }}
                            >
                              <div>
                                {c.badge && (
                                  <span
                                    className="inline-block px-3 py-1 rounded-full text-xs font-semibold uppercase tracking-wider mb-3 border"
                                    style={{
                                      backgroundColor: `#${theme.tagBg}`,
                                      borderColor: `#${theme.accent}`,
                                      color: `#${theme.primaryDark}`,
                                    }}
                                  >
                                    {c.badge}
                                  </span>
                                )}
                                {c.value && (
                                  <div
                                    className="text-4xl md:text-5xl font-extrabold tracking-tight mb-2"
                                    style={{ color: `#${theme.primary}` }}
                                  >
                                    {c.value}
                                  </div>
                                )}
                                <div className="text-lg md:text-xl font-bold mb-2">
                                  {c.title}
                                </div>
                              </div>
                              <p className="text-sm md:text-base leading-relaxed opacity-80">
                                {c.description}
                              </p>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* 2. SPLIT 2-COLUMN COMPARISON */}
                      {activeSlide.layout === "split" && (
                        <div className="grid grid-cols-2 gap-6 my-auto">
                          {resolvedColumns.map((col, colIdx) => (
                            <div
                              key={colIdx}
                              className="p-6 rounded-2xl border shadow-sm"
                              style={{
                                backgroundColor: `#${theme.cardBg}`,
                                borderColor: `#${theme.border}`,
                              }}
                            >
                              <h3
                                className="text-lg md:text-xl font-bold uppercase tracking-wider mb-4 pb-3 border-b"
                                style={{
                                  color: colIdx === 0 ? `#${theme.primary}` : `#${theme.secondary}`,
                                  borderColor: `#${theme.border}`,
                                }}
                              >
                                {col.heading}
                              </h3>
                              <ul className="space-y-3.5">
                                {col.bullets.map((b, bIdx) => (
                                  <li key={bIdx} className="text-sm md:text-base flex items-start gap-3 leading-relaxed">
                                    <span
                                      className="w-2.5 h-2.5 rounded-full mt-1.5 shrink-0"
                                      style={{ backgroundColor: `#${theme.primary}` }}
                                    />
                                    <span>{b}</span>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* 3. DATA TABLE */}
                      {activeSlide.layout === "table" && (
                        <div
                          className="rounded-2xl border overflow-hidden my-auto shadow-md"
                          style={{ borderColor: `#${theme.border}` }}
                        >
                          <table className="w-full text-sm md:text-base text-left border-collapse">
                            <thead>
                              <tr style={{ backgroundColor: `#${theme.primary}`, color: "#FFFFFF" }}>
                                {resolvedTable.headers.map((h, hIdx) => (
                                  <th
                                    key={hIdx}
                                    className={cn(
                                      "px-5 py-3.5 font-bold whitespace-nowrap",
                                      hIdx === 0 ? "text-left" : "text-center"
                                    )}
                                  >
                                    {h}
                                  </th>
                                ))}
                              </tr>
                            </thead>
                            <tbody className="divide-y" style={{ borderColor: `#${theme.border}` }}>
                              {resolvedTable.rows.map((row, rIdx) => (
                                <tr
                                  key={rIdx}
                                  style={{
                                    backgroundColor: rIdx % 2 === 0 ? `#${theme.bg}` : `#${theme.cardBg}`,
                                  }}
                                >
                                  {row.map((cell, cIdx) => (
                                    <td
                                      key={cIdx}
                                      className={cn(
                                        "px-5 py-3 whitespace-nowrap",
                                        cIdx === 0 ? "text-left font-semibold" : "text-center"
                                      )}
                                    >
                                      {renderStatusCell(cell)}
                                    </td>
                                  ))}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}

                      {/* 4. TIMELINE / ROADMAP */}
                      {activeSlide.layout === "timeline" && (
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 my-auto">
                          {resolvedSteps.map((st, stIdx) => (
                            <div
                              key={stIdx}
                              className="p-5 rounded-2xl border flex flex-col justify-between shadow-sm"
                              style={{
                                backgroundColor: `#${theme.cardBg}`,
                                borderColor: `#${theme.border}`,
                              }}
                            >
                              <div>
                                <div
                                  className="w-10 h-10 rounded-xl flex items-center justify-center font-bold text-sm text-white mb-3 shadow-sm"
                                  style={{ backgroundColor: `#${theme.primary}` }}
                                >
                                  {st.step}
                                </div>
                                <div className="text-base font-bold mb-2">{st.title}</div>
                              </div>
                              <p className="text-xs md:text-sm opacity-80 leading-relaxed">{st.description}</p>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* 5. IMPACT QUOTE */}
                      {activeSlide.layout === "quote" && (
                        <div className="px-8 py-8 flex items-start gap-6 my-auto">
                          <QuoteIcon
                            className="w-14 h-14 shrink-0 opacity-30"
                            style={{ color: `#${theme.accent}` }}
                          />
                          <div className="flex-1">
                            <p className="text-2xl md:text-3xl font-serif italic mb-4 leading-relaxed">
                              "{resolvedQuote.text}"
                            </p>
                            <div className="text-base font-bold" style={{ color: `#${theme.primary}` }}>
                              — {resolvedQuote.author || "Anonymous"}
                              {resolvedQuote.role && (
                                <span className="opacity-75 font-normal">, {resolvedQuote.role}</span>
                              )}
                            </div>
                          </div>
                        </div>
                      )}

                      {/* 6. STANDARD BULLETS */}
                      {(!activeSlide.layout || activeSlide.layout === "bullets") && (
                        <ul className="space-y-3.5 pl-2 my-auto">
                          {(activeSlide.bullets && activeSlide.bullets.length > 0
                            ? activeSlide.bullets
                            : ["Core platform architecture pattern", "High-velocity delivery pipeline", "Continuous quality verification"]
                          ).map((b, bIdx) => (
                            <li key={bIdx} className="text-base md:text-lg flex items-start gap-3 leading-relaxed">
                              <span
                                className="w-2.5 h-2.5 rounded-full mt-2 shrink-0 shadow-sm"
                                style={{ backgroundColor: `#${theme.primary}` }}
                              />
                              <span>{b}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </>
                )}
                <div className="text-[11px] opacity-50 flex justify-between border-t pt-3">
                  <span className="truncate">{activeOfficeDoc?.title}</span>
                  <span>{currentSlideIndex + 1} of {activeOfficeDoc?.slides?.length}</span>
                </div>
              </div>
            </div>

            {/* Bottom Scrubber */}
            <div className="flex items-center justify-center gap-4 text-white">
              <Button
                size="sm"
                variant="ghost"
                disabled={currentSlideIndex <= 0}
                onClick={() => setCurrentSlideIndex((c) => Math.max(0, c - 1))}
                className="text-white hover:bg-white/10 h-8 px-2"
              >
                <ChevronLeft className="w-4 h-4 mr-1" /> Prev
              </Button>
              <span className="text-xs text-white/70">Space / Arrow keys to navigate • Esc to exit</span>
              <Button
                size="sm"
                variant="ghost"
                disabled={currentSlideIndex >= (activeOfficeDoc?.slides?.length || 1) - 1}
                onClick={() => setCurrentSlideIndex((c) => Math.min((activeOfficeDoc?.slides?.length || 1) - 1, c + 1))}
                className="text-white hover:bg-white/10 h-8 px-2"
              >
                Next <ChevronRight className="w-4 h-4 ml-1" />
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
