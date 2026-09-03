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
  Plus,
  Trash2,
  Copy,
  ChevronLeft,
  ChevronRight,
  Maximize2,
  Minimize2,
  Edit3,
  Layers,
  MessageSquare,
  Check,
  Columns,
  LayoutGrid,
  Table as TableIcon,
  Quote as QuoteIcon,
  Clock,
  Image as ImageIcon,
  ExternalLink,
  ChevronDown,
  Info,
  AlertCircle,
  FileSpreadsheet,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
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
import { openExternalUrl } from "@/lib/open-external";
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
  const openFileTab = useAppStore((s) => s.openFileTab);
  const setComposerDraft = useAppStore((s) => s.setComposerDraft);

  // Studio state
  const [documents, setDocuments] = React.useState<WorkspaceOfficeDoc[]>([]);
  const [loadingDocs, setLoadingDocs] = React.useState(false);
  const [currentSlideIndex, setCurrentSlideIndex] = React.useState(0);
  const [activeTab, setActiveTab] = React.useState<"edit" | "notes" | "preview">("edit");
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
            // Fetch its manifest specifically
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
    } catch (err) {
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

  // Add new slide
  const handleAddSlide = () => {
    if (!activeOfficeDoc || !activeOfficeDoc.slides) return;
    const newSlide: PptSlide = {
      id: `slide-${activeOfficeDoc.slides.length + 1}`,
      title: "New Key Point",
      subtitle: "Overview & Details",
      layout: "bullets",
      bullets: ["First major finding", "Supporting detail or metric"],
    };
    setActiveOfficeDoc({
      ...activeOfficeDoc,
      slides: [...activeOfficeDoc.slides, newSlide],
      updatedAt: Date.now(),
    });
    setCurrentSlideIndex(activeOfficeDoc.slides.length);
    toast.success("Added new slide");
  };

  // Duplicate slide
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

  // Re-order slides
  const handleMoveSlide = (idx: number, dir: -1 | 1) => {
    if (!activeOfficeDoc || !activeOfficeDoc.slides) return;
    const targetIdx = idx + dir;
    if (targetIdx < 0 || targetIdx >= activeOfficeDoc.slides.length) return;
    const next = [...activeOfficeDoc.slides];
    const [removed] = next.splice(idx, 1);
    next.splice(targetIdx, 0, removed);
    setActiveOfficeDoc({
      ...activeOfficeDoc,
      slides: next,
      updatedAt: Date.now(),
    });
    setCurrentSlideIndex(targetIdx);
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
        <div className="flex-1 flex flex-col items-center justify-center p-8 text-center max-w-lg mx-auto">
          <div className="w-16 h-16 rounded-2xl bg-brand/10 border border-brand/20 flex items-center justify-center text-brand mb-6 shadow-sm">
            <Presentation className="w-8 h-8" />
          </div>
          <h2 className="text-xl font-semibold tracking-tight text-foreground mb-2">
            HermOS Office Studio
          </h2>
          <p className="text-xs text-muted-foreground leading-relaxed mb-8">
            Your AI agent generates executive presentations, Word specifications, and PDF reports.
            Created documents render natively right here with live 16:9 slide canvases, theme switchers,
            and interactive visual editing.
          </p>

          <div className="w-full space-y-2.5 text-left">
            <div className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider px-1">
              Quick Agent Starters:
            </div>

            <button
              onClick={() => {
                handleTriggerPrompt(
                  "Generate an executive 6-slide presentation (presentation.pptx) on our architecture, roadmap, and performance metrics."
                );
              }}
              className="w-full p-3 rounded-xl border border-border bg-card/60 hover:bg-accent/40 hover:border-brand/40 transition-all text-left group flex items-start gap-3 cursor-pointer"
            >
              <div className="p-2 rounded-lg bg-emerald-500/10 text-emerald-500 group-hover:scale-105 transition-transform">
                <Presentation className="w-4 h-4" />
              </div>
              <div>
                <div className="text-xs font-medium text-foreground">Create a Presentation</div>
                <div className="text-[11px] text-muted-foreground mt-0.5">
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
              className="w-full p-3 rounded-xl border border-border bg-card/60 hover:bg-accent/40 hover:border-brand/40 transition-all text-left group flex items-start gap-3 cursor-pointer"
            >
              <div className="p-2 rounded-lg bg-rose-500/10 text-rose-500 group-hover:scale-105 transition-transform">
                <FileText className="w-4 h-4" />
              </div>
              <div>
                <div className="text-xs font-medium text-foreground">Generate a PDF Report</div>
                <div className="text-[11px] text-muted-foreground mt-0.5">
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
              className="w-full p-3 rounded-xl border border-border bg-card/60 hover:bg-accent/40 hover:border-brand/40 transition-all text-left group flex items-start gap-3 cursor-pointer"
            >
              <div className="p-2 rounded-lg bg-blue-500/10 text-blue-500 group-hover:scale-105 transition-transform">
                <FileType className="w-4 h-4" />
              </div>
              <div>
                <div className="text-xs font-medium text-foreground">Draft a Word Document</div>
                <div className="text-[11px] text-muted-foreground mt-0.5">
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
  // STUDIO INTERFACE (Kimi / GLM Style)
  // =========================================================================
  return (
    <div className="flex flex-col h-full bg-background border-l border-border select-none overflow-hidden">
      {/* 1. TOP STUDIO BAR */}
      <div className="h-12 border-b border-border px-3 flex items-center justify-between gap-2 shrink-0 bg-card/40 backdrop-blur-sm">
        {/* Left: Document Selector */}
        <div className="flex items-center gap-2 min-w-0">
          <Select
            value={activeOfficeDoc?.path || ""}
            onValueChange={(val) => handleSelectDoc(val)}
          >
            <SelectTrigger className="h-8 text-xs font-medium border-border/70 bg-background/80 max-w-[220px]">
              <div className="flex items-center gap-2 truncate">
                {activeOfficeDoc?.type === "presentation" ? (
                  <Presentation className="w-3.5 h-3.5 text-brand shrink-0" />
                ) : activeOfficeDoc?.type === "pdf" ? (
                  <FileText className="w-3.5 h-3.5 text-rose-500 shrink-0" />
                ) : (
                  <FileType className="w-3.5 h-3.5 text-blue-500 shrink-0" />
                )}
                <span className="truncate">{activeOfficeDoc?.title || "Select Document"}</span>
              </div>
            </SelectTrigger>
            <SelectContent>
              {documents.map((d) => (
                <SelectItem key={d.path} value={d.path} className="text-xs">
                  <div className="flex items-center gap-2">
                    {d.type === "presentation" ? (
                      <Presentation className="w-3.5 h-3.5 text-brand shrink-0" />
                    ) : d.type === "pdf" ? (
                      <FileText className="w-3.5 h-3.5 text-rose-500 shrink-0" />
                    ) : (
                      <FileType className="w-3.5 h-3.5 text-blue-500 shrink-0" />
                    )}
                    <span className="font-medium">{d.name}</span>
                    <span className="text-[10px] text-muted-foreground ml-auto">{d.relPath}</span>
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Badge variant="outline" className="text-[10px] uppercase font-mono tracking-wider px-1.5 py-0">
            {activeOfficeDoc?.type === "presentation" ? "PPTX" : activeOfficeDoc?.type === "pdf" ? "PDF" : "DOCX"}
          </Badge>
        </div>

        {/* Right: Studio Controls */}
        <div className="flex items-center gap-1.5 shrink-0">
          {/* Live Theme Palette Switcher */}
          <Select
            value={activeThemeId}
            onValueChange={(val) => setActiveOfficeTheme(val as OfficeThemeId)}
          >
            <SelectTrigger className="h-8 text-xs font-medium border-border/70 bg-background/80 w-[140px]">
              <div className="flex items-center gap-1.5 truncate">
                <span
                  className="w-2.5 h-2.5 rounded-full shrink-0"
                  style={{ backgroundColor: `#${theme.primary}` }}
                />
                <span className="truncate">{theme.name}</span>
              </div>
            </SelectTrigger>
            <SelectContent>
              {Object.values(OFFICE_THEMES).map((t) => (
                <SelectItem key={t.id} value={t.id} className="text-xs">
                  <div className="flex items-center gap-2">
                    <span
                      className="w-3 h-3 rounded-full shrink-0 border border-border/40"
                      style={{ backgroundColor: `#${t.primary}` }}
                    />
                    <span>{t.name}</span>
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* Slideshow Button (for presentations) */}
          {activeOfficeDoc?.type === "presentation" && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setIsSlideshow(true)}
                  className="h-8 px-2.5 text-xs gap-1.5"
                >
                  <Play className="w-3.5 h-3.5 text-brand fill-brand/20" />
                  <span className="hidden sm:inline">Present</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Start Slideshow (Full Canvas)</TooltipContent>
            </Tooltip>
          )}

          {/* Ask Agent to Refine */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="sm"
                variant="outline"
                onClick={handleAskAgent}
                className="h-8 px-2.5 text-xs gap-1.5"
              >
                <Sparkles className="w-3.5 h-3.5 text-brand" />
                <span className="hidden sm:inline">Refine</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Ask AI Agent to Refine Document</TooltipContent>
          </Tooltip>

          {/* Export / Download */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  if (activeOfficeDoc?.path) {
                    window.open(`/api/workspace/file?path=${encodeURIComponent(activeOfficeDoc.path)}`, "_blank");
                  }
                }}
                className="h-8 px-2.5 text-xs gap-1.5"
              >
                <Download className="w-3.5 h-3.5 text-muted-foreground" />
                <span className="hidden sm:inline">Export</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Download File</TooltipContent>
          </Tooltip>

          {/* Save & Re-export */}
          <Button
            size="sm"
            onClick={handleSaveChanges}
            disabled={saving}
            className="h-8 px-3 text-xs bg-brand text-brand-foreground hover:bg-brand/90 gap-1.5"
          >
            {saving ? (
              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Check className="w-3.5 h-3.5" />
            )}
            <span>Save</span>
          </Button>
        </div>
      </div>

      {/* =================================================================== */}
      {/* 2. PRESENTATION STUDIO (Kimi Style) */}
      {/* =================================================================== */}
      {activeOfficeDoc?.type === "presentation" && (
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          <div className="flex-1 flex min-h-0 overflow-hidden">
            {/* Left Slide Filmstrip */}
            <div className="w-48 border-r border-border bg-card/20 flex flex-col shrink-0 overflow-hidden">
              <div className="p-2 border-b border-border/60 flex items-center justify-between">
                <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                  Slides ({activeOfficeDoc.slides?.length || 0})
                </span>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={handleAddSlide}
                  className="h-6 w-6 text-brand hover:bg-brand/10"
                >
                  <Plus className="w-3.5 h-3.5" />
                </Button>
              </div>

              <ScrollArea className="flex-1 p-2">
                <div className="space-y-2">
                  {activeOfficeDoc.slides?.map((slide, sIdx) => {
                    const isActive = sIdx === currentSlideIndex;
                    const LayoutIcon = LAYOUT_ICONS[slide.layout || "bullets"] || FileText;

                    return (
                      <div
                        key={slide.id || sIdx}
                        onClick={() => setCurrentSlideIndex(sIdx)}
                        className={cn(
                          "group relative p-2 rounded-lg border transition-all cursor-pointer text-left",
                          isActive
                            ? "border-brand bg-brand/5 ring-1 ring-brand/30 shadow-sm"
                            : "border-border/60 bg-card/60 hover:bg-accent/40 hover:border-border"
                        )}
                      >
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-[10px] font-mono text-muted-foreground font-semibold">
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

                        {/* Slide action buttons */}
                        <div className="absolute right-1.5 top-1.5 hidden group-hover:flex items-center gap-0.5 bg-card/90 border border-border/80 rounded px-0.5 py-0.5 shadow-sm">
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

            {/* Center: 16:9 Interactive Slide Canvas */}
            <div className="flex-1 flex flex-col bg-accent/20 p-4 md:p-6 overflow-y-auto items-center justify-center min-h-0">
              {activeSlide && (
                <div
                  className="w-full max-w-4xl aspect-[16/9] rounded-2xl border shadow-xl flex flex-col justify-between p-8 md:p-10 relative overflow-hidden transition-all duration-300"
                  style={{
                    backgroundColor: `#${activeSlide.layout === "title" && theme.isDarkTheme ? theme.primaryDark : theme.bg}`,
                    borderColor: `#${theme.border}`,
                    color: `#${theme.textDark}`,
                  }}
                >
                  {/* Decorative top accent line */}
                  <div
                    className="absolute top-0 left-0 right-0 h-1.5"
                    style={{ backgroundColor: `#${theme.primary}` }}
                  />

                  {/* Header Area */}
                  {activeSlide.layout === "title" ? (
                    <div className="flex-1 flex flex-col justify-center">
                      <div className="flex items-center gap-2 mb-3">
                        <span
                          className="w-2 h-8 rounded-full"
                          style={{ backgroundColor: `#${theme.accent}` }}
                        />
                        <span className="text-xs uppercase tracking-widest font-mono font-semibold opacity-70">
                          {activeOfficeDoc.author || "HermOS AI Studio"}
                        </span>
                      </div>
                      <h1 className="text-3xl md:text-5xl font-bold tracking-tight mb-3">
                        {activeSlide.title}
                      </h1>
                      {activeSlide.subtitle && (
                        <p className="text-base md:text-xl opacity-80" style={{ color: `#${theme.secondary}` }}>
                          {activeSlide.subtitle}
                        </p>
                      )}
                      <div className="mt-8 flex items-center gap-3">
                        <div
                          className="px-3 py-1 rounded-full text-xs font-medium border"
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
                        <div className="flex items-center gap-2.5 mb-1.5">
                          <span
                            className="w-1.5 h-5 rounded-full shrink-0"
                            style={{ backgroundColor: `#${theme.primary}` }}
                          />
                          <h2 className="text-xl md:text-2xl font-bold tracking-tight">
                            {activeSlide.title}
                          </h2>
                        </div>
                        {activeSlide.subtitle && (
                          <p className="text-xs md:text-sm pl-4 opacity-75" style={{ color: `#${theme.textMuted}` }}>
                            {activeSlide.subtitle}
                          </p>
                        )}
                      </div>

                      {/* Layout-Specific Content Area */}
                      <div className="flex-1 my-4 flex flex-col justify-center overflow-hidden">
                        {/* 1. KPI / FEATURE CARDS */}
                        {activeSlide.layout === "cards" && activeSlide.cards && (
                          <div className="grid grid-cols-2 md:grid-cols-3 gap-3.5">
                            {activeSlide.cards.map((c, cIdx) => (
                              <div
                                key={cIdx}
                                className="p-4 rounded-xl border flex flex-col justify-between relative overflow-hidden"
                                style={{
                                  backgroundColor: `#${theme.cardBg}`,
                                  borderColor: `#${theme.border}`,
                                }}
                              >
                                <div>
                                  {c.badge && (
                                    <span
                                      className="inline-block px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider mb-2 border"
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
                                      className="text-2xl md:text-3xl font-extrabold tracking-tight mb-1"
                                      style={{ color: `#${theme.primary}` }}
                                    >
                                      {c.value}
                                    </div>
                                  )}
                                  <div className="text-xs md:text-sm font-semibold mb-1">
                                    {c.title}
                                  </div>
                                </div>
                                <p className="text-[11px] leading-relaxed opacity-75">
                                  {c.description}
                                </p>
                              </div>
                            ))}
                          </div>
                        )}

                        {/* 2. SPLIT 2-COLUMN COMPARISON */}
                        {activeSlide.layout === "split" && activeSlide.columns && (
                          <div className="grid grid-cols-2 gap-4">
                            {activeSlide.columns.map((col, colIdx) => (
                              <div
                                key={colIdx}
                                className="p-4 rounded-xl border"
                                style={{
                                  backgroundColor: `#${theme.cardBg}`,
                                  borderColor: `#${theme.border}`,
                                }}
                              >
                                <h3
                                  className="text-sm font-bold uppercase tracking-wider mb-3 pb-2 border-b"
                                  style={{
                                    color: colIdx === 0 ? `#${theme.primary}` : `#${theme.secondary}`,
                                    borderColor: `#${theme.border}`,
                                  }}
                                >
                                  {col.heading}
                                </h3>
                                <ul className="space-y-2">
                                  {col.bullets.map((b, bIdx) => (
                                    <li key={bIdx} className="text-xs flex items-start gap-2">
                                      <span
                                        className="w-1.5 h-1.5 rounded-full mt-1.5 shrink-0"
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
                        {activeSlide.layout === "table" && activeSlide.table && (
                          <div className="rounded-xl border overflow-hidden" style={{ borderColor: `#${theme.border}` }}>
                            <table className="w-full text-xs text-left">
                              <thead>
                                <tr style={{ backgroundColor: `#${theme.primary}`, color: "#FFFFFF" }}>
                                  {activeSlide.table.headers.map((h, hIdx) => (
                                    <th key={hIdx} className="px-3 py-2 font-semibold">
                                      {h}
                                    </th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody>
                                {activeSlide.table.rows.map((row, rIdx) => (
                                  <tr
                                    key={rIdx}
                                    className="border-t"
                                    style={{
                                      backgroundColor: rIdx % 2 === 0 ? `#${theme.bg}` : `#${theme.cardBg}`,
                                      borderColor: `#${theme.border}`,
                                    }}
                                  >
                                    {row.map((cell, cIdx) => (
                                      <td key={cIdx} className="px-3 py-2">
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
                          <div className="grid grid-cols-3 md:grid-cols-4 gap-3">
                            {activeSlide.steps.map((st, stIdx) => (
                              <div
                                key={stIdx}
                                className="p-3.5 rounded-xl border flex flex-col justify-between"
                                style={{
                                  backgroundColor: `#${theme.cardBg}`,
                                  borderColor: `#${theme.border}`,
                                }}
                              >
                                <div>
                                  <div
                                    className="w-8 h-8 rounded-lg flex items-center justify-center font-bold text-xs text-white mb-2 shadow-sm"
                                    style={{ backgroundColor: `#${theme.primary}` }}
                                  >
                                    {st.step}
                                  </div>
                                  <div className="text-xs font-bold mb-1">{st.title}</div>
                                </div>
                                <p className="text-[11px] opacity-75 leading-relaxed">{st.description}</p>
                              </div>
                            ))}
                          </div>
                        )}

                        {/* 5. IMPACT QUOTE */}
                        {activeSlide.layout === "quote" && activeSlide.quote && (
                          <div className="px-8 py-6 flex items-start gap-4">
                            <QuoteIcon
                              className="w-10 h-10 shrink-0 opacity-40"
                              style={{ color: `#${theme.accent}` }}
                            />
                            <div>
                              <p className="text-lg md:text-2xl font-serif italic mb-3 leading-relaxed">
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
                          <ul className="space-y-3 pl-2">
                            {activeSlide.bullets?.map((b, bIdx) => (
                              <li key={bIdx} className="text-xs md:text-sm flex items-start gap-2.5 leading-relaxed">
                                <span
                                  className="w-2 h-2 rounded-full mt-1.5 shrink-0"
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
                    className="pt-3 border-t flex items-center justify-between text-[10px] opacity-70"
                    style={{ borderColor: `#${theme.border}` }}
                  >
                    <span>{activeOfficeDoc.title} • HermOS Office Studio</span>
                    <span>
                      Slide {currentSlideIndex + 1} of {activeOfficeDoc.slides?.length || 1}
                    </span>
                  </div>
                </div>
              )}

              {/* Navigation Controls Bar */}
              <div className="mt-4 flex items-center gap-3">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={currentSlideIndex <= 0}
                  onClick={() => setCurrentSlideIndex((c) => Math.max(0, c - 1))}
                  className="h-8 px-2.5 text-xs"
                >
                  <ChevronLeft className="w-3.5 h-3.5 mr-1" /> Prev
                </Button>
                <span className="text-xs font-medium text-muted-foreground">
                  {currentSlideIndex + 1} / {activeOfficeDoc.slides?.length || 1}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={currentSlideIndex >= (activeOfficeDoc.slides?.length || 1) - 1}
                  onClick={() => setCurrentSlideIndex((c) => Math.min((activeOfficeDoc.slides?.length || 1) - 1, c + 1))}
                  className="h-8 px-2.5 text-xs"
                >
                  Next <ChevronRight className="w-3.5 h-3.5 ml-1" />
                </Button>
              </div>
            </div>
          </div>

          {/* Bottom Visual Edit Drawer */}
          <div className="h-44 border-t border-border bg-card/60 flex flex-col shrink-0">
            <div className="px-4 py-1.5 border-b border-border flex items-center justify-between">
              <div className="flex items-center gap-4">
                <button
                  onClick={() => setActiveTab("edit")}
                  className={cn(
                    "text-xs font-medium pb-1 transition-colors",
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
                    "text-xs font-medium pb-1 transition-colors",
                    activeTab === "notes"
                      ? "text-brand border-b-2 border-brand"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  Speaker Notes
                </button>
              </div>

              {activeSlide && (
                <div className="flex items-center gap-2">
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
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 max-w-4xl">
                  <div>
                    <Label className="text-[11px] text-muted-foreground">Slide Title</Label>
                    <Input
                      value={activeSlide.title}
                      onChange={(e) => updateActiveOfficeSlide(currentSlideIndex, { title: e.target.value })}
                      className="h-7 text-xs mt-1"
                    />
                  </div>
                  <div>
                    <Label className="text-[11px] text-muted-foreground">Subtitle</Label>
                    <Input
                      value={activeSlide.subtitle || ""}
                      onChange={(e) => updateActiveOfficeSlide(currentSlideIndex, { subtitle: e.target.value })}
                      className="h-7 text-xs mt-1"
                      placeholder="Optional subtitle"
                    />
                  </div>
                  <div className="md:col-span-2">
                    <Label className="text-[11px] text-muted-foreground">
                      Bullet Points (one per line)
                    </Label>
                    <Textarea
                      value={activeSlide.bullets?.join("\n") || ""}
                      onChange={(e) =>
                        updateActiveOfficeSlide(currentSlideIndex, {
                          bullets: e.target.value.split("\n").filter(Boolean),
                        })
                      }
                      rows={2}
                      className="text-xs mt-1 resize-none"
                    />
                  </div>
                </div>
              )}

              {activeTab === "notes" && activeSlide && (
                <div className="max-w-4xl">
                  <Label className="text-[11px] text-muted-foreground">Speaker Notes</Label>
                  <Textarea
                    value={activeSlide.notes || ""}
                    onChange={(e) => updateActiveOfficeSlide(currentSlideIndex, { notes: e.target.value })}
                    rows={3}
                    placeholder="Enter notes to remember while presenting..."
                    className="text-xs mt-1 resize-none"
                  />
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* =================================================================== */}
      {/* 3. DOCUMENT & PDF STUDIO (GLM Style) */}
      {/* =================================================================== */}
      {(activeOfficeDoc?.type === "document" || activeOfficeDoc?.type === "pdf") && (
        <div className="flex-1 flex flex-col min-h-0 overflow-y-auto p-4 md:p-8 items-center bg-accent/20">
          <div
            className="w-full max-w-3xl rounded-2xl border shadow-xl p-8 md:p-12 mb-8"
            style={{
              backgroundColor: `#${theme.bg}`,
              borderColor: `#${theme.border}`,
              color: `#${theme.textDark}`,
            }}
          >
            {/* Document Header Banner */}
            <div
              className="p-6 rounded-xl mb-8 text-center text-white"
              style={{ backgroundColor: `#${theme.primary}` }}
            >
              <h1 className="text-2xl md:text-3xl font-bold mb-2">{activeOfficeDoc.title}</h1>
              {activeOfficeDoc.subtitle && (
                <p className="text-sm opacity-90">{activeOfficeDoc.subtitle}</p>
              )}
              <div className="text-xs opacity-75 mt-3">
                Prepared by {activeOfficeDoc.author || "HermOS AI Studio"} • {new Date(activeOfficeDoc.updatedAt).toLocaleDateString()}
              </div>
            </div>

            {/* Document Sections */}
            <div className="space-y-8">
              {activeOfficeDoc.sections?.map((sec, secIdx) => (
                <div key={sec.id || secIdx} className="group">
                  <div className="flex items-center justify-between pb-2 border-b mb-3" style={{ borderColor: `#${theme.border}` }}>
                    <h2 className="text-lg font-bold" style={{ color: `#${theme.primary}` }}>
                      {sec.heading}
                    </h2>
                  </div>

                  {sec.subheading && (
                    <p className="text-xs italic mb-3 opacity-75" style={{ color: `#${theme.textMuted}` }}>
                      {sec.subheading}
                    </p>
                  )}

                  {/* Callout box */}
                  {sec.callout && (
                    <div
                      className="p-3.5 rounded-r-lg border-l-4 my-3 text-xs italic"
                      style={{
                        backgroundColor: `#${theme.cardBg}`,
                        borderColor: `#${theme.primary}`,
                      }}
                    >
                      {sec.callout.title && (
                        <div className="font-bold not-italic mb-1" style={{ color: `#${theme.primary}` }}>
                          {sec.callout.title}
                        </div>
                      )}
                      <div>{sec.callout.text}</div>
                    </div>
                  )}

                  {/* Paragraphs */}
                  <div className="space-y-2.5 text-xs leading-relaxed">
                    {sec.paragraphs?.map((p, pIdx) => (
                      <p key={pIdx}>{p}</p>
                    ))}
                  </div>

                  {/* Bullets */}
                  {sec.bullets && sec.bullets.length > 0 && (
                    <ul className="mt-3 space-y-1.5 pl-2 text-xs">
                      {sec.bullets.map((b, bIdx) => (
                        <li key={bIdx} className="flex items-start gap-2">
                          <span
                            className="w-1.5 h-1.5 rounded-full mt-1.5 shrink-0"
                            style={{ backgroundColor: `#${theme.primary}` }}
                          />
                          <span>{b}</span>
                        </li>
                      ))}
                    </ul>
                  )}

                  {/* Table */}
                  {sec.table && sec.table.headers.length > 0 && (
                    <div className="mt-4 rounded-lg border overflow-hidden" style={{ borderColor: `#${theme.border}` }}>
                      <table className="w-full text-xs text-left">
                        <thead>
                          <tr style={{ backgroundColor: `#${theme.primary}`, color: "#FFFFFF" }}>
                            {sec.table.headers.map((h, hIdx) => (
                              <th key={hIdx} className="px-3 py-2 font-semibold">
                                {h}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {sec.table.rows.map((row, rIdx) => (
                            <tr
                              key={rIdx}
                              className="border-t"
                              style={{
                                backgroundColor: rIdx % 2 === 0 ? `#${theme.bg}` : `#${theme.cardBg}`,
                                borderColor: `#${theme.border}`,
                              }}
                            >
                              {row.map((cell, cIdx) => (
                                <td key={cIdx} className="px-3 py-2">
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
            className="fixed inset-0 z-50 bg-black/95 flex flex-col justify-between p-8 select-none"
          >
            {/* Top Bar */}
            <div className="flex items-center justify-between text-white/80">
              <span className="text-sm font-semibold">{activeOfficeDoc?.title}</span>
              <div className="flex items-center gap-3">
                <span className="text-xs font-mono">
                  {currentSlideIndex + 1} / {activeOfficeDoc?.slides?.length}
                </span>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => setIsSlideshow(false)}
                  className="h-8 w-8 text-white hover:bg-white/10"
                >
                  <Minimize2 className="w-4 h-4" />
                </Button>
              </div>
            </div>

            {/* Center Canvas */}
            <div className="flex-1 flex items-center justify-center p-4">
              <div
                className="w-full max-w-5xl aspect-[16/9] rounded-3xl border shadow-2xl p-12 flex flex-col justify-between"
                style={{
                  backgroundColor: `#${activeSlide.layout === "title" && theme.isDarkTheme ? theme.primaryDark : theme.bg}`,
                  borderColor: `#${theme.border}`,
                  color: `#${theme.textDark}`,
                }}
              >
                {activeSlide.layout === "title" ? (
                  <div className="flex-1 flex flex-col justify-center">
                    <h1 className="text-5xl font-bold tracking-tight mb-4">{activeSlide.title}</h1>
                    {activeSlide.subtitle && (
                      <p className="text-2xl opacity-80" style={{ color: `#${theme.secondary}` }}>
                        {activeSlide.subtitle}
                      </p>
                    )}
                  </div>
                ) : (
                  <>
                    <div>
                      <h2 className="text-3xl font-bold tracking-tight mb-2">{activeSlide.title}</h2>
                      {activeSlide.subtitle && (
                        <p className="text-base opacity-75" style={{ color: `#${theme.textMuted}` }}>
                          {activeSlide.subtitle}
                        </p>
                      )}
                    </div>
                    <div className="flex-1 my-6 flex flex-col justify-center">
                      {activeSlide.bullets?.map((b, bIdx) => (
                        <div key={bIdx} className="text-xl flex items-center gap-3 py-2">
                          <span
                            className="w-2.5 h-2.5 rounded-full shrink-0"
                            style={{ backgroundColor: `#${theme.primary}` }}
                          />
                          <span>{b}</span>
                        </div>
                      ))}
                    </div>
                  </>
                )}
                <div className="text-xs opacity-50 flex justify-between border-t pt-4">
                  <span>{activeOfficeDoc?.title}</span>
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
                className="text-white hover:bg-white/10"
              >
                <ChevronLeft className="w-5 h-5" />
              </Button>
              <span className="text-xs text-white/70">Press Space or Arrow keys to navigate • Esc to exit</span>
              <Button
                size="sm"
                variant="ghost"
                disabled={currentSlideIndex >= (activeOfficeDoc?.slides?.length || 1) - 1}
                onClick={() => setCurrentSlideIndex((c) => Math.min((activeOfficeDoc?.slides?.length || 1) - 1, c + 1))}
                className="text-white hover:bg-white/10"
              >
                <ChevronRight className="w-5 h-5" />
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
