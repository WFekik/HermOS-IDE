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
  Layers,
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

export function OfficePanel() {
  const activeOfficeDoc = useAppStore((s) => s.activeOfficeDoc);
  const setActiveOfficeDoc = useAppStore((s) => s.setActiveOfficeDoc);
  const updateActiveOfficeSlide = useAppStore((s) => s.updateActiveOfficeSlide);
  const updateActiveOfficeSection = useAppStore((s) => s.updateActiveOfficeSection);
  const setActiveOfficeTheme = useAppStore((s) => s.setActiveOfficeTheme);
  const setComposerDraft = useAppStore((s) => s.setComposerDraft);

  // Studio state
  const [documents, setDocuments] = React.useState<WorkspaceOfficeDoc[]>([]);
  const [loadingDocs, setLoadingDocs] = React.useState(false);
  const [currentSlideIndex, setCurrentSlideIndex] = React.useState(0);
  const [activeTab, setActiveTab] = React.useState<"edit" | "notes">("edit");
  const [isSlideshow, setIsSlideshow] = React.useState(false);
  const [saving, setSaving] = React.useState(false);

  // Active theme resolution
  const activeThemeId = (activeOfficeDoc?.theme as OfficeThemeId) || "executive";
  const theme = resolveOfficeTheme(activeThemeId);

  // 1. Fetch workspace office documents list
  const fetchDocuments = React.useCallback(async () => {
    setLoadingDocs(true);
    try {
      const res = await apiGet<{ ok: boolean; documents: WorkspaceOfficeDoc[] }>(
        "/api/office/document?action=list"
      );
      if (res.ok && Array.isArray(res.documents)) {
        setDocuments(res.documents);

        // If no active doc in store, pick the most recent one
        if (!activeOfficeDoc && res.documents.length > 0) {
          const first = res.documents[0];
          if (first.manifest) {
            setActiveOfficeDoc(first.manifest);
          } else {
            const docRes = await apiGet<{ ok: boolean; document: { manifest?: OfficeDocManifest } }>(
              `/api/office/document?path=${encodeURIComponent(first.path)}`
            );
            if (docRes.ok && docRes.document.manifest) {
              setActiveOfficeDoc(docRes.document.manifest);
            }
          }
        }
      }
    } catch {
      /* ignore background poll failures */
    } finally {
      setLoadingDocs(false);
    }
  }, [activeOfficeDoc, setActiveOfficeDoc]);

  React.useEffect(() => {
    fetchDocuments();
    const interval = setInterval(fetchDocuments, 8000);
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

  // Document switcher handler
  const handleSelectDoc = async (docPath: string) => {
    try {
      const res = await apiGet<{ ok: boolean; document: { manifest?: OfficeDocManifest } }>(
        `/api/office/document?path=${encodeURIComponent(docPath)}`
      );
      if (res.ok && res.document.manifest) {
        setActiveOfficeDoc(res.document.manifest);
        setCurrentSlideIndex(0);
      }
    } catch {
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
            Your AI agent generates executive presentations, Word specifications, and PDF reports.
            Created documents render natively right here with live 16:9 slide canvases, theme switchers,
            and interactive visual editing.
          </p>

          <div className="w-full space-y-2.5 text-left">
            <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider px-1">
              Quick Agent Starters:
            </div>

            <button
              onClick={() => {
                handleTriggerPrompt(
                  "Generate an executive 6-slide presentation (presentation.pptx) on our architecture, roadmap, and performance metrics."
                );
              }}
              className="w-full p-3 rounded-xl border border-border bg-card/60 hover:bg-accent/40 hover:border-brand/40 transition-all text-left group flex items-start gap-3 cursor-pointer shadow-xs"
            >
              <div className="p-2 rounded-lg bg-emerald-500/10 text-emerald-500 group-hover:scale-105 transition-transform shrink-0">
                <Presentation className="w-4 h-4" />
              </div>
              <div className="min-w-0">
                <div className="text-xs font-semibold text-foreground">Create a Presentation</div>
                <div className="text-[11px] text-muted-foreground mt-0.5 line-clamp-2">
                  "Generate an executive 6-slide deck on our architecture and roadmap"
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
  // STUDIO INTERFACE (Kimi / GLM Style with Best-Practice UI Components)
  // =========================================================================
  return (
    <div className="flex flex-col h-full bg-background border-l border-border select-none overflow-hidden">
      {/* 1. TOP STUDIO BAR — Best Practice Responsive Layout */}
      <div className="h-10 border-b border-border px-2.5 flex items-center justify-between gap-1.5 shrink-0 bg-card/50 backdrop-blur-sm">
        {/* Left: Document Selector & Type Badge */}
        <div className="flex items-center gap-1.5 min-w-0 flex-1 overflow-hidden">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs font-medium gap-1.5 max-w-[200px] truncate hover:bg-accent/60 shrink-0"
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
        </div>

        {/* Right: Studio Controls (Icon Toolbar with Tooltips + Compact Save) */}
        <div className="flex items-center gap-1 shrink-0">
          {/* Theme Switcher via Dropdown */}
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 rounded-md hover:bg-accent/60"
                  >
                    <span
                      className="w-3.5 h-3.5 rounded-full border border-border/80 shadow-xs"
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
            <TooltipContent side="bottom">Theme: {theme.name}</TooltipContent>
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
      {/* 2. PRESENTATION STUDIO (Responsive Canvas & Dynamic Editor) */}
      {/* =================================================================== */}
      {activeOfficeDoc?.type === "presentation" && (
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          <div className="flex-1 flex min-h-0 overflow-hidden">
            {/* Left Slide Filmstrip — No Manual Add Button */}
            <div className="w-36 border-r border-border bg-card/20 flex flex-col shrink-0 overflow-hidden">
              <div className="p-2 border-b border-border/60 flex items-center justify-between">
                <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                  Slides ({activeOfficeDoc.slides?.length || 0})
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
                          "group relative p-2 rounded-md border transition-all cursor-pointer text-left",
                          isActive
                            ? "border-brand bg-brand/5 ring-1 ring-brand/30 shadow-xs"
                            : "border-border/60 bg-card/50 hover:bg-accent/40 hover:border-border"
                        )}
                      >
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-[9px] font-mono text-muted-foreground font-semibold">
                            {sIdx + 1}
                          </span>
                          <LayoutIcon className="w-3 h-3 text-muted-foreground group-hover:text-brand transition-colors" />
                        </div>

                        <div className="text-[11px] font-medium text-foreground truncate">
                          {slide.title}
                        </div>

                        <div className="text-[9px] text-muted-foreground capitalize mt-0.5">
                          {slide.layout || "bullets"}
                        </div>

                        {/* Slide action buttons: duplicate and delete */}
                        <div className="absolute right-1 top-1 hidden group-hover:flex items-center gap-0.5 bg-card/90 border border-border/80 rounded px-0.5 py-0.5 shadow-xs">
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

            {/* Center: Interactive Slide Canvas (Self-Adapting Height, No Clipped Content) */}
            <div className="flex-1 flex flex-col bg-accent/15 p-3 md:p-6 overflow-y-auto items-center justify-center min-h-0">
              {activeSlide && (
                <div
                  className="w-full max-w-3xl min-h-[280px] rounded-xl border shadow-lg flex flex-col justify-between p-6 relative transition-all duration-200"
                  style={{
                    backgroundColor: `#${activeSlide.layout === "title" && theme.isDarkTheme ? theme.primaryDark : theme.bg}`,
                    borderColor: `#${theme.border}`,
                    color: `#${theme.textDark}`,
                  }}
                >
                  {/* Decorative top accent line */}
                  <div
                    className="absolute top-0 left-0 right-0 h-1 rounded-t-xl"
                    style={{ backgroundColor: `#${theme.primary}` }}
                  />

                  {/* Header Area */}
                  {activeSlide.layout === "title" ? (
                    <div className="flex-1 flex flex-col justify-center py-4">
                      <div className="flex items-center gap-2 mb-2">
                        <span
                          className="w-1.5 h-6 rounded-full"
                          style={{ backgroundColor: `#${theme.accent}` }}
                        />
                        <span className="text-[10px] uppercase tracking-widest font-mono font-semibold opacity-75">
                          {activeOfficeDoc.author || "HermOS AI Studio"}
                        </span>
                      </div>
                      <h1 className="text-2xl md:text-4xl font-bold tracking-tight mb-2">
                        {activeSlide.title}
                      </h1>
                      {activeSlide.subtitle && (
                        <p className="text-sm md:text-lg opacity-85" style={{ color: `#${theme.secondary}` }}>
                          {activeSlide.subtitle}
                        </p>
                      )}
                      <div className="mt-6 flex items-center gap-2">
                        <div
                          className="px-2.5 py-0.5 rounded-full text-[10px] font-medium border"
                          style={{
                            backgroundColor: `#${theme.cardBg}`,
                            borderColor: `#${theme.border}`,
                          }}
                        >
                          {activeOfficeDoc.slides?.length || 0} Slides Deck
                        </div>
                      </div>
                    </div>
                  ) : (
                    <>
                      {/* Slide Title & Subtitle */}
                      <div>
                        <div className="flex items-center gap-2 mb-1">
                          <span
                            className="w-1 h-4 rounded-full shrink-0"
                            style={{ backgroundColor: `#${theme.primary}` }}
                          />
                          <h2 className="text-lg md:text-xl font-bold tracking-tight">
                            {activeSlide.title}
                          </h2>
                        </div>
                        {activeSlide.subtitle && (
                          <p className="text-xs pl-3 opacity-75" style={{ color: `#${theme.textMuted}` }}>
                            {activeSlide.subtitle}
                          </p>
                        )}
                      </div>

                      {/* Layout-Specific Content Area (Adaptive, Scrollable If Overflowing) */}
                      <div className="flex-1 my-3 flex flex-col justify-center min-h-0 overflow-y-auto max-h-[380px]">
                        {/* 1. KPI / FEATURE CARDS */}
                        {activeSlide.layout === "cards" && activeSlide.cards && (
                          <div className="grid grid-cols-2 md:grid-cols-3 gap-2.5 my-auto">
                            {activeSlide.cards.map((c, cIdx) => (
                              <div
                                key={cIdx}
                                className="p-3 rounded-lg border flex flex-col justify-between"
                                style={{
                                  backgroundColor: `#${theme.cardBg}`,
                                  borderColor: `#${theme.border}`,
                                }}
                              >
                                <div>
                                  {c.badge && (
                                    <span
                                      className="inline-block px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wider mb-1.5 border"
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
                                      className="text-xl md:text-2xl font-extrabold tracking-tight mb-0.5"
                                      style={{ color: `#${theme.primary}` }}
                                    >
                                      {c.value}
                                    </div>
                                  )}
                                  <div className="text-xs font-semibold mb-0.5">
                                    {c.title}
                                  </div>
                                </div>
                                <p className="text-[10px] leading-relaxed opacity-75">
                                  {c.description}
                                </p>
                              </div>
                            ))}
                          </div>
                        )}

                        {/* 2. SPLIT 2-COLUMN COMPARISON */}
                        {activeSlide.layout === "split" && activeSlide.columns && (
                          <div className="grid grid-cols-2 gap-3 my-auto">
                            {activeSlide.columns.map((col, colIdx) => (
                              <div
                                key={colIdx}
                                className="p-3 rounded-lg border"
                                style={{
                                  backgroundColor: `#${theme.cardBg}`,
                                  borderColor: `#${theme.border}`,
                                }}
                              >
                                <h3
                                  className="text-xs font-bold uppercase tracking-wider mb-2 pb-1.5 border-b"
                                  style={{
                                    color: colIdx === 0 ? `#${theme.primary}` : `#${theme.secondary}`,
                                    borderColor: `#${theme.border}`,
                                  }}
                                >
                                  {col.heading}
                                </h3>
                                <ul className="space-y-1.5">
                                  {col.bullets.map((b, bIdx) => (
                                    <li key={bIdx} className="text-[11px] flex items-start gap-1.5">
                                      <span
                                        className="w-1 h-1 rounded-full mt-1.5 shrink-0"
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

                        {/* 3. DATA TABLE — Complete Row Rendering */}
                        {activeSlide.layout === "table" && activeSlide.table && (
                          <div
                            className="rounded-lg border overflow-x-auto my-auto max-h-[260px]"
                            style={{ borderColor: `#${theme.border}` }}
                          >
                            <table className="w-full text-xs text-left border-collapse">
                              <thead className="sticky top-0 z-10">
                                <tr style={{ backgroundColor: `#${theme.primary}`, color: "#FFFFFF" }}>
                                  {activeSlide.table.headers.map((h, hIdx) => (
                                    <th key={hIdx} className="px-3 py-2 font-semibold whitespace-nowrap">
                                      {h}
                                    </th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody className="divide-y" style={{ borderColor: `#${theme.border}` }}>
                                {activeSlide.table.rows.map((row, rIdx) => (
                                  <tr
                                    key={rIdx}
                                    style={{
                                      backgroundColor: rIdx % 2 === 0 ? `#${theme.bg}` : `#${theme.cardBg}`,
                                    }}
                                  >
                                    {row.map((cell, cIdx) => (
                                      <td key={cIdx} className="px-3 py-1.5 whitespace-nowrap">
                                        {cell}
                                      </td>
                                    ))}
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}

                        {/* 4. TIMELINE / STEPS */}
                        {activeSlide.layout === "timeline" && activeSlide.steps && (
                          <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5 my-auto">
                            {activeSlide.steps.map((st, stIdx) => (
                              <div
                                key={stIdx}
                                className="p-2.5 rounded-lg border flex flex-col justify-between"
                                style={{
                                  backgroundColor: `#${theme.cardBg}`,
                                  borderColor: `#${theme.border}`,
                                }}
                              >
                                <div>
                                  <div
                                    className="w-6 h-6 rounded-md flex items-center justify-center font-bold text-[10px] text-white mb-1.5"
                                    style={{ backgroundColor: `#${theme.primary}` }}
                                  >
                                    {st.step}
                                  </div>
                                  <div className="text-xs font-bold mb-0.5">{st.title}</div>
                                </div>
                                <p className="text-[10px] opacity-75 leading-relaxed">{st.description}</p>
                              </div>
                            ))}
                          </div>
                        )}

                        {/* 5. IMPACT QUOTE */}
                        {activeSlide.layout === "quote" && activeSlide.quote && (
                          <div className="px-6 py-4 flex items-start gap-3 my-auto">
                            <QuoteIcon
                              className="w-8 h-8 shrink-0 opacity-40"
                              style={{ color: `#${theme.accent}` }}
                            />
                            <div>
                              <p className="text-base md:text-xl font-serif italic mb-2 leading-relaxed">
                                "{activeSlide.quote.text}"
                              </p>
                              <div className="text-xs font-semibold" style={{ color: `#${theme.primary}` }}>
                                — {activeSlide.quote.author || "Anonymous"}
                                {activeSlide.quote.role && (
                                  <span className="opacity-70 font-normal">, {activeSlide.quote.role}</span>
                                )}
                              </div>
                            </div>
                          </div>
                        )}

                        {/* 6. STANDARD BULLETS (Default) */}
                        {(!activeSlide.layout || activeSlide.layout === "bullets") && (
                          <ul className="space-y-2 pl-1 my-auto">
                            {activeSlide.bullets?.map((b, bIdx) => (
                              <li key={bIdx} className="text-xs md:text-sm flex items-start gap-2 leading-relaxed">
                                <span
                                  className="w-1.5 h-1.5 rounded-full mt-1.5 shrink-0"
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

                  {/* Slide Canvas Footer */}
                  <div
                    className="pt-2 border-t flex items-center justify-between text-[9px] opacity-70"
                    style={{ borderColor: `#${theme.border}` }}
                  >
                    <span className="truncate max-w-[200px]">{activeOfficeDoc.title} • HermOS Office Studio</span>
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
                  className="h-7 px-2 text-xs"
                >
                  <ChevronLeft className="w-3 h-3 mr-1" /> Prev
                </Button>
                <span className="text-xs font-mono text-muted-foreground px-1">
                  {currentSlideIndex + 1} / {activeOfficeDoc.slides?.length || 1}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={currentSlideIndex >= (activeOfficeDoc.slides?.length || 1) - 1}
                  onClick={() => setCurrentSlideIndex((c) => Math.min((activeOfficeDoc.slides?.length || 1) - 1, c + 1))}
                  className="h-7 px-2 text-xs"
                >
                  Next <ChevronRight className="w-3 h-3 ml-1" />
                </Button>
              </div>
            </div>
          </div>

          {/* Bottom Dynamic Slide Content Inspector / Editor */}
          <div className="h-44 border-t border-border bg-card/60 flex flex-col shrink-0">
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
                    <SelectTrigger className="h-6 text-[11px] w-[105px] border-border/60">
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

            <div className="flex-1 p-2.5 overflow-y-auto">
              {activeTab === "edit" && activeSlide && (
                <div className="space-y-2 max-w-3xl">
                  {/* Common: Title & Subtitle */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <div>
                      <Label className="text-[10px] text-muted-foreground">Slide Title</Label>
                      <Input
                        value={activeSlide.title}
                        onChange={(e) => updateActiveOfficeSlide(currentSlideIndex, { title: e.target.value })}
                        className="h-7 text-xs mt-0.5"
                      />
                    </div>
                    <div>
                      <Label className="text-[10px] text-muted-foreground">Subtitle</Label>
                      <Input
                        value={activeSlide.subtitle || ""}
                        onChange={(e) => updateActiveOfficeSlide(currentSlideIndex, { subtitle: e.target.value })}
                        className="h-7 text-xs mt-0.5"
                        placeholder="Optional subtitle"
                      />
                    </div>
                  </div>

                  {/* DYNAMIC LAYOUT INSPECTOR: Table Editor */}
                  {activeSlide.layout === "table" && (
                    <div className="space-y-1.5">
                      <div>
                        <Label className="text-[10px] text-muted-foreground">Table Headers (comma-separated)</Label>
                        <Input
                          value={activeSlide.table?.headers.join(", ") || ""}
                          onChange={(e) => {
                            const headers = e.target.value.split(",").map((h) => h.trim()).filter(Boolean);
                            updateActiveOfficeSlide(currentSlideIndex, {
                              table: {
                                headers,
                                rows: activeSlide.table?.rows || [],
                              },
                            });
                          }}
                          className="h-7 text-xs mt-0.5"
                          placeholder="Header 1, Header 2, Header 3"
                        />
                      </div>
                      <div>
                        <Label className="text-[10px] text-muted-foreground">Table Rows (one row per line, comma-separated)</Label>
                        <Textarea
                          value={activeSlide.table?.rows.map((r) => r.join(", ")).join("\n") || ""}
                          onChange={(e) => {
                            const rows = e.target.value
                              .split("\n")
                              .filter(Boolean)
                              .map((line) => line.split(",").map((c) => c.trim()));
                            updateActiveOfficeSlide(currentSlideIndex, {
                              table: {
                                headers: activeSlide.table?.headers || [],
                                rows,
                              },
                            });
                          }}
                          rows={2}
                          className="text-xs mt-0.5 resize-none font-mono"
                          placeholder="Value 1, Value 2, Value 3"
                        />
                      </div>
                    </div>
                  )}

                  {/* DYNAMIC LAYOUT INSPECTOR: Cards Editor */}
                  {activeSlide.layout === "cards" && (
                    <div>
                      <Label className="text-[10px] text-muted-foreground">KPI Cards (one per line: Title | Value | Badge | Description)</Label>
                      <Textarea
                        value={
                          activeSlide.cards
                            ?.map((c) => `${c.title} | ${c.value || ""} | ${c.badge || ""} | ${c.description}`)
                            .join("\n") || ""
                        }
                        onChange={(e) => {
                          const cards = e.target.value
                            .split("\n")
                            .filter(Boolean)
                            .map((line) => {
                              const [title, value, badge, description] = line.split("|").map((s) => s.trim());
                              return {
                                title: title || "Card",
                                value: value || undefined,
                                badge: badge || undefined,
                                description: description || "",
                              };
                            });
                          updateActiveOfficeSlide(currentSlideIndex, { cards });
                        }}
                        rows={2}
                        className="text-xs mt-0.5 resize-none"
                        placeholder="Throughput | 45K req/s | High | Microservices gateway capacity"
                      />
                    </div>
                  )}

                  {/* DYNAMIC LAYOUT INSPECTOR: Quote Editor */}
                  {activeSlide.layout === "quote" && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <div className="sm:col-span-2">
                        <Label className="text-[10px] text-muted-foreground">Quote Text</Label>
                        <Textarea
                          value={activeSlide.quote?.text || ""}
                          onChange={(e) =>
                            updateActiveOfficeSlide(currentSlideIndex, {
                              quote: { ...activeSlide.quote, text: e.target.value },
                            })
                          }
                          rows={2}
                          className="text-xs mt-0.5 resize-none"
                        />
                      </div>
                      <div>
                        <Label className="text-[10px] text-muted-foreground">Author</Label>
                        <Input
                          value={activeSlide.quote?.author || ""}
                          onChange={(e) =>
                            updateActiveOfficeSlide(currentSlideIndex, {
                              quote: { text: activeSlide.quote?.text || "", author: e.target.value, role: activeSlide.quote?.role },
                            })
                          }
                          className="h-7 text-xs mt-0.5"
                        />
                      </div>
                      <div>
                        <Label className="text-[10px] text-muted-foreground">Role / Organization</Label>
                        <Input
                          value={activeSlide.quote?.role || ""}
                          onChange={(e) =>
                            updateActiveOfficeSlide(currentSlideIndex, {
                              quote: { text: activeSlide.quote?.text || "", author: activeSlide.quote?.author, role: e.target.value },
                            })
                          }
                          className="h-7 text-xs mt-0.5"
                        />
                      </div>
                    </div>
                  )}

                  {/* DYNAMIC LAYOUT INSPECTOR: Standard Bullets (Default / Fallback) */}
                  {(activeSlide.layout === "bullets" || activeSlide.layout === "split" || !activeSlide.layout) && (
                    <div>
                      <Label className="text-[10px] text-muted-foreground">Bullet Points (one per line)</Label>
                      <Textarea
                        value={activeSlide.bullets?.join("\n") || ""}
                        onChange={(e) =>
                          updateActiveOfficeSlide(currentSlideIndex, {
                            bullets: e.target.value.split("\n").filter(Boolean),
                          })
                        }
                        rows={2}
                        className="text-xs mt-0.5 resize-none"
                        placeholder="First key point..."
                      />
                    </div>
                  )}
                </div>
              )}

              {activeTab === "notes" && activeSlide && (
                <div className="max-w-3xl">
                  <Label className="text-[10px] text-muted-foreground">Speaker Notes</Label>
                  <Textarea
                    value={activeSlide.notes || ""}
                    onChange={(e) => updateActiveOfficeSlide(currentSlideIndex, { notes: e.target.value })}
                    rows={3}
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
      {(activeOfficeDoc?.type === "document" || activeOfficeDoc?.type === "pdf") && (
        <div className="flex-1 flex flex-col min-h-0 overflow-y-auto p-4 md:p-6 items-center bg-accent/15">
          <div
            className="w-full max-w-2xl rounded-xl border shadow-lg p-6 md:p-10 mb-6"
            style={{
              backgroundColor: `#${theme.bg}`,
              borderColor: `#${theme.border}`,
              color: `#${theme.textDark}`,
            }}
          >
            {/* Document Header Banner */}
            <div
              className="p-5 rounded-lg mb-6 text-center text-white"
              style={{ backgroundColor: `#${theme.primary}` }}
            >
              <h1 className="text-xl md:text-2xl font-bold mb-1.5">{activeOfficeDoc.title}</h1>
              {activeOfficeDoc.subtitle && (
                <p className="text-xs md:text-sm opacity-90">{activeOfficeDoc.subtitle}</p>
              )}
              <div className="text-[11px] opacity-75 mt-2.5 font-mono">
                Prepared by {activeOfficeDoc.author || "HermOS AI Studio"} • {new Date(activeOfficeDoc.updatedAt).toLocaleDateString()}
              </div>
            </div>

            {/* Document Sections */}
            <div className="space-y-6">
              {activeOfficeDoc.sections?.map((sec, secIdx) => (
                <div key={sec.id || secIdx} className="group">
                  <div className="flex items-center justify-between pb-1.5 border-b mb-2.5" style={{ borderColor: `#${theme.border}` }}>
                    <h2 className="text-base font-bold" style={{ color: `#${theme.primary}` }}>
                      {sec.heading}
                    </h2>
                  </div>

                  {sec.subheading && (
                    <p className="text-xs italic mb-2.5 opacity-75" style={{ color: `#${theme.textMuted}` }}>
                      {sec.subheading}
                    </p>
                  )}

                  {/* Callout box */}
                  {sec.callout && (
                    <div
                      className="p-3 rounded-r-md border-l-4 my-2.5 text-xs italic"
                      style={{
                        backgroundColor: `#${theme.cardBg}`,
                        borderColor: `#${theme.primary}`,
                      }}
                    >
                      {sec.callout.title && (
                        <div className="font-bold not-italic mb-0.5" style={{ color: `#${theme.primary}` }}>
                          {sec.callout.title}
                        </div>
                      )}
                      <div>{sec.callout.text}</div>
                    </div>
                  )}

                  {/* Paragraphs */}
                  <div className="space-y-2 text-xs leading-relaxed">
                    {sec.paragraphs?.map((p, pIdx) => (
                      <p key={pIdx}>{p}</p>
                    ))}
                  </div>

                  {/* Bullets */}
                  {sec.bullets && sec.bullets.length > 0 && (
                    <ul className="mt-2.5 space-y-1 pl-2 text-xs">
                      {sec.bullets.map((b, bIdx) => (
                        <li key={bIdx} className="flex items-start gap-1.5">
                          <span
                            className="w-1 h-1 rounded-full mt-1.5 shrink-0"
                            style={{ backgroundColor: `#${theme.primary}` }}
                          />
                          <span>{b}</span>
                        </li>
                      ))}
                    </ul>
                  )}

                  {/* Table */}
                  {sec.table && sec.table.headers.length > 0 && (
                    <div className="mt-3 rounded-lg border overflow-hidden" style={{ borderColor: `#${theme.border}` }}>
                      <table className="w-full text-xs text-left">
                        <thead>
                          <tr style={{ backgroundColor: `#${theme.primary}`, color: "#FFFFFF" }}>
                            {sec.table.headers.map((h, hIdx) => (
                              <th key={hIdx} className="px-2.5 py-1.5 font-semibold">
                                {h}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody className="divide-y" style={{ borderColor: `#${theme.border}` }}>
                          {sec.table.rows.map((row, rIdx) => (
                            <tr
                              key={rIdx}
                              style={{
                                backgroundColor: rIdx % 2 === 0 ? `#${theme.bg}` : `#${theme.cardBg}`,
                              }}
                            >
                              {row.map((cell, cIdx) => (
                                <td key={cIdx} className="px-2.5 py-1.5">
                                  {cell}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

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
                      <h2 className="text-2xl md:text-3xl font-bold tracking-tight mb-1.5">{activeSlide.title}</h2>
                      {activeSlide.subtitle && (
                        <p className="text-sm opacity-75" style={{ color: `#${theme.textMuted}` }}>
                          {activeSlide.subtitle}
                        </p>
                      )}
                    </div>
                    <div className="flex-1 my-4 flex flex-col justify-center">
                      {activeSlide.bullets?.map((b, bIdx) => (
                        <div key={bIdx} className="text-base md:text-lg flex items-center gap-2.5 py-1.5">
                          <span
                            className="w-2 h-2 rounded-full shrink-0"
                            style={{ backgroundColor: `#${theme.primary}` }}
                          />
                          <span>{b}</span>
                        </div>
                      ))}
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
