"use client";

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  FileText,
  Presentation,
  FileType,
  Plus,
  Trash2,
  Loader2,
  Sparkles,
  RefreshCw,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  FileBox,
  ExternalLink,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
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
import { apiPost, ApiRequestError } from "@/lib/api-client";
import {
  fetchTree,
  baseName,
  type FileNode,
} from "@/components/workspace/types";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ *
 * office-panel.tsx — Office document generation panel.
 *
 * Mounted as a tab in the right panel (after Browser). Lets the user
 * generate professional documents — PPT, Word, PDF — via
 * POST /api/office/generate. The form adapts to the selected document
 * type:
 *
 *   - Presentation (.pptx): title + theme + output path + slides editor
 *   - Document (.docx):     title + output path + sections editor
 *   - PDF (.pdf):           title + output path + sections editor
 *
 * The slides / sections editors are cap'd at MAX_SLIDES / MAX_SECTIONS
 * (50 each). On success the panel toasts "Generated <path>", switches
 * the right panel to the Files tab, and opens the file in the editor.
 *
 * "Recent documents" — bottom of the panel — reads the workspace file
 * tree and lists files matching .pptx/.docx/.pdf with Open buttons.
 *
 * All async surfaces (tree fetch, generation) have loading / empty /
 * error states. The panel is fully usable when no conversation is
 * active (the user can still generate documents); the officeGenerating
 * store flag drives the floating TaskProgress indicator.
 * ------------------------------------------------------------------ */

const MAX_SLIDES = 50;
const MAX_SECTIONS = 50;

const POLL_RECENT_MS = 8000;

type DocType = "presentation" | "document" | "pdf";

type Theme = "professional" | "modern" | "minimal";

interface SlideDraft {
  /** Local-only id; replaced by the backend on save. */
  id: string;
  title: string;
  bullets: string;
}

interface SectionDraft {
  id: string;
  heading: string;
  paragraphs: string;
}

const THEME_OPTIONS: { value: Theme; label: string }[] = [
  { value: "professional", label: "Professional" },
  { value: "modern", label: "Modern" },
  { value: "minimal", label: "Minimal" },
];

const DOC_EXT = new Set([".pptx", ".docx", ".pdf"]);

const TYPE_CARDS: {
  type: DocType;
  label: string;
  description: string;
  icon: React.ElementType;
  defaultPath: string;
}[] = [
  {
    type: "presentation",
    label: "Presentation",
    description: "Slide deck with title, bullets, and theme.",
    icon: Presentation,
    defaultPath: "presentation.pptx",
  },
  {
    type: "document",
    label: "Document",
    description: "Word document with sections and paragraphs.",
    icon: FileType,
    defaultPath: "document.docx",
  },
  {
    type: "pdf",
    label: "PDF",
    description: "Printable PDF with sections and paragraphs.",
    icon: FileText,
    defaultPath: "document.pdf",
  },
];

let _idCounter = 0;
function nextId(): string {
  _idCounter += 1;
  return `draft-${Date.now().toString(36)}-${_idCounter}`;
}

/* ------------------------------------------------------------------ */

export function OfficePanel() {
  const setOfficeGenerating = useAppStore((s) => s.setOfficeGenerating);
  const setRightPanelTab = useAppStore((s) => s.setRightPanelTab);
  const openFileTab = useAppStore((s) => s.openFileTab);

  const [type, setType] = React.useState<DocType | null>(null);

  // Shared form state across all three types.
  const [title, setTitle] = React.useState("");
  const [outputPath, setOutputPath] = React.useState("presentation.pptx");
  const [theme, setTheme] = React.useState<Theme>("professional");
  const [slides, setSlides] = React.useState<SlideDraft[]>([
    { id: nextId(), title: "Introduction", bullets: "Overview\nKey points" },
  ]);
  const [sections, setSections] = React.useState<SectionDraft[]>([
    {
      id: nextId(),
      heading: "Overview",
      paragraphs: "Short introduction to the topic.",
    },
  ]);

  const [generating, setGenerating] = React.useState(false);

  // Selecting a type resets the form fields to sensible defaults for
  // that type. We don't blow away user-edited PPT slides when the user
  // switches to Document and back — instead we keep them in state and
  // just swap the default output path on the first switch.
  const handleSelectType = (t: DocType) => {
    setType(t);
    const card = TYPE_CARDS.find((c) => c.type === t);
    if (card) {
      // Only overwrite the output path if the user hasn't customized
      // it for the current type (i.e. it still matches one of the
      // default paths).
      setOutputPath((cur) =>
        TYPE_CARDS.some((c) => c.defaultPath === cur) ? card.defaultPath : cur,
      );
    }
  };

  const addSlide = () => {
    setSlides((cur) =>
      cur.length >= MAX_SLIDES
        ? cur
        : [...cur, { id: nextId(), title: "", bullets: "" }],
    );
  };
  const updateSlide = (id: string, patch: Partial<SlideDraft>) =>
    setSlides((cur) => cur.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  const removeSlide = (id: string) =>
    setSlides((cur) => cur.filter((s) => s.id !== id));

  const addSection = () => {
    setSections((cur) =>
      cur.length >= MAX_SECTIONS
        ? cur
        : [...cur, { id: nextId(), heading: "", paragraphs: "" }],
    );
  };
  const updateSection = (id: string, patch: Partial<SectionDraft>) =>
    setSections((cur) =>
      cur.map((s) => (s.id === id ? { ...s, ...patch } : s)),
    );
  const removeSection = (id: string) =>
    setSections((cur) => cur.filter((s) => s.id !== id));

  const handleGenerate = async () => {
    if (!type) return;
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      toast.error("Title is required");
      return;
    }
    const trimmedPath = outputPath.trim();
    if (!trimmedPath) {
      toast.error("Output path is required");
      return;
    }
    if (type === "presentation") {
      const validSlides = slides
        .map((s) => ({
          title: s.title.trim(),
          bullets: s.bullets
            .split("\n")
            .map((b) => b.trim())
            .filter(Boolean),
        }))
        .filter((s) => s.title || s.bullets.length > 0);
      if (validSlides.length === 0) {
        toast.error("Add at least one slide");
        return;
      }
      setGenerating(true);
      setOfficeGenerating(true, { path: trimmedPath, type });
      try {
        await apiPost("/api/office/generate", {
          type: "ppt",
          title: trimmedTitle,
          path: trimmedPath,
          theme,
          slides: validSlides,
        }, { timeoutMs: 10 * 60_000 });
        toast.success(`Generated ${trimmedPath}`);
        // Switch to Files tab + open the new file in the editor so the
        // user sees the result immediately.
        setRightPanelTab("files");
        openFileTab(trimmedPath);
      } catch (e) {
        toast.error(
          e instanceof ApiRequestError
            ? e.message
            : "Failed to generate presentation",
        );
      } finally {
        setGenerating(false);
        setOfficeGenerating(false, { path: trimmedPath, type });
      }
      return;
    }

    // document | pdf
    const validSections = sections
      .map((s) => ({
        heading: s.heading.trim(),
        paragraphs: s.paragraphs
          .split("\n")
          .map((p) => p.trim())
          .filter(Boolean),
      }))
      .filter((s) => s.heading || s.paragraphs.length > 0);
    if (validSections.length === 0) {
      toast.error("Add at least one section");
      return;
    }
    setGenerating(true);
    setOfficeGenerating(true, { path: trimmedPath, type });
    try {
      await apiPost("/api/office/generate", {
        type: type === "document" ? "doc" : "pdf",
        title: trimmedTitle,
        path: trimmedPath,
        sections: validSections,
      }, { timeoutMs: 10 * 60_000 });
      toast.success(`Generated ${trimmedPath}`);
      setRightPanelTab("files");
      openFileTab(trimmedPath);
    } catch (e) {
      toast.error(
        e instanceof ApiRequestError
          ? e.message
          : `Failed to generate ${type}`,
      );
    } finally {
      setGenerating(false);
      setOfficeGenerating(false, { path: trimmedPath, type });
    }
  };

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b">
        <div className="flex items-center gap-2">
          <FileText className="size-4 text-brand" />
          <span className="text-sm font-medium">Office</span>
          {type && (
            <Badge variant="secondary" className="text-[10px] h-4 capitalize">
              {type}
            </Badge>
          )}
        </div>
        {type && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-[11px] gap-1"
                onClick={() => setType(null)}
                aria-label="Back to document type picker"
              >
                Change type
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              Back to document type picker
            </TooltipContent>
          </Tooltip>
        )}
      </div>

      <ScrollArea className="flex-1 min-h-0">
        <div className="p-3 space-y-3">
          <AnimatePresence mode="wait">
            {type === null ? (
              <motion.div
                key="picker"
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.15 }}
                className="space-y-2"
              >
                <p className="text-[11px] text-muted-foreground">
                  Choose a document type to generate.
                </p>
                {TYPE_CARDS.map((c) => (
                  <button
                    key={c.type}
                    type="button"
                    onClick={() => handleSelectType(c.type)}
                    className="group w-full text-left rounded-md border bg-background p-3 hover:border-brand/40 hover:bg-accent/40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label={`Generate ${c.label}`}
                  >
                    <div className="flex items-start gap-2.5">
                      <div className="size-7 rounded-md bg-brand/10 flex items-center justify-center shrink-0">
                        <c.icon className="size-3.5 text-brand" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-medium">{c.label}</div>
                        <div className="text-[11px] text-muted-foreground mt-0.5">
                          {c.description}
                        </div>
                      </div>
                      <ChevronRight className="size-3.5 text-muted-foreground/50 group-hover:text-brand transition-colors shrink-0 mt-0.5" />
                    </div>
                  </button>
                ))}
              </motion.div>
            ) : type === "presentation" ? (
              <motion.div
                key="ppt"
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.15 }}
                className="space-y-3"
              >
                <FormField label="Title" htmlFor="office-title">
                  <Input
                    id="office-title"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="Q4 Strategy Review"
                    className="h-8 text-xs"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </FormField>

                <FormField label="Theme" htmlFor="office-theme">
                  <Select value={theme} onValueChange={(v) => setTheme(v as Theme)}>
                    <SelectTrigger
                      id="office-theme"
                      size="sm"
                      className="h-8 w-full text-xs"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {THEME_OPTIONS.map((t) => (
                        <SelectItem key={t.value} value={t.value} className="text-xs">
                          {t.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FormField>

                <FormField label="Output path" htmlFor="office-path">
                  <Input
                    id="office-path"
                    value={outputPath}
                    onChange={(e) => setOutputPath(e.target.value)}
                    placeholder="presentation.pptx"
                    className="h-8 text-xs font-mono"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </FormField>

                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label className="text-[11px] text-muted-foreground">
                      Slides{" "}
                      <span className="font-mono text-[10px]">
                        ({slides.length}/{MAX_SLIDES})
                      </span>
                    </Label>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 gap-1 text-[11px]"
                      onClick={addSlide}
                      disabled={slides.length >= MAX_SLIDES}
                      aria-label="Add slide"
                    >
                      <Plus className="size-3" />
                      Add slide
                    </Button>
                  </div>
                  <div className="space-y-1.5">
                    <AnimatePresence initial={false}>
                      {slides.map((s, i) => (
                        <SlideCard
                          key={s.id}
                          index={i}
                          slide={s}
                          onChange={(patch) => updateSlide(s.id, patch)}
                          onRemove={() => removeSlide(s.id)}
                          disabled={generating}
                        />
                      ))}
                    </AnimatePresence>
                    {slides.length === 0 && (
                      <div className="rounded-md border border-dashed p-3 text-center text-[11px] text-muted-foreground">
                        No slides yet. Click &ldquo;Add slide&rdquo; to start.
                      </div>
                    )}
                  </div>
                </div>
              </motion.div>
            ) : (
              <motion.div
                key="doc"
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.15 }}
                className="space-y-3"
              >
                <FormField label="Title" htmlFor="office-title">
                  <Input
                    id="office-title"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="Project Specification"
                    className="h-8 text-xs"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </FormField>

                <FormField label="Output path" htmlFor="office-path">
                  <Input
                    id="office-path"
                    value={outputPath}
                    onChange={(e) => setOutputPath(e.target.value)}
                    placeholder={
                      type === "pdf" ? "document.pdf" : "document.docx"
                    }
                    className="h-8 text-xs font-mono"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </FormField>

                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label className="text-[11px] text-muted-foreground">
                      Sections{" "}
                      <span className="font-mono text-[10px]">
                        ({sections.length}/{MAX_SECTIONS})
                      </span>
                    </Label>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 gap-1 text-[11px]"
                      onClick={addSection}
                      disabled={sections.length >= MAX_SECTIONS}
                      aria-label="Add section"
                    >
                      <Plus className="size-3" />
                      Add section
                    </Button>
                  </div>
                  <div className="space-y-1.5">
                    <AnimatePresence initial={false}>
                      {sections.map((s, i) => (
                        <SectionCard
                          key={s.id}
                          index={i}
                          section={s}
                          onChange={(patch) => updateSection(s.id, patch)}
                          onRemove={() => removeSection(s.id)}
                          disabled={generating}
                        />
                      ))}
                    </AnimatePresence>
                    {sections.length === 0 && (
                      <div className="rounded-md border border-dashed p-3 text-center text-[11px] text-muted-foreground">
                        No sections yet. Click &ldquo;Add section&rdquo; to start.
                      </div>
                    )}
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {type !== null && (
            <Button
              size="sm"
              className="w-full gap-1.5 bg-brand text-brand-foreground hover:bg-brand/90"
              onClick={() => void handleGenerate()}
              disabled={generating}
              aria-label={`Generate ${type ?? "document"}`}
            >
              {generating ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" />
                  Generating…
                </>
              ) : (
                <>
                  <Sparkles className="size-3.5" />
                  Generate {type === "presentation" ? "presentation" : type === "pdf" ? "PDF" : "document"}
                </>
              )}
            </Button>
          )}

          <RecentDocuments />
        </div>
      </ScrollArea>
    </div>
  );
}

/* ------------------------------ Sub-components ------------------------------ */

function FormField({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={htmlFor} className="text-[11px] text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  );
}

function SlideCard({
  index,
  slide,
  onChange,
  onRemove,
  disabled,
}: {
  index: number;
  slide: SlideDraft;
  onChange: (patch: Partial<SlideDraft>) => void;
  onRemove: () => void;
  disabled: boolean;
}) {
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: -2 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: -8 }}
      transition={{ duration: 0.15 }}
      className="group rounded-md border bg-background p-2"
    >
      <div className="flex items-center gap-1.5">
        <span className="font-mono text-[10px] text-muted-foreground w-5 shrink-0 text-right">
          {index + 1}
        </span>
        <Input
          value={slide.title}
          onChange={(e) => onChange({ title: e.target.value })}
          placeholder="Slide title"
          className="h-7 text-xs flex-1"
          disabled={disabled}
          autoComplete="off"
          spellCheck={false}
        />
        <Button
          size="sm"
          variant="ghost"
          className="size-7 p-0 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity shrink-0"
          onClick={onRemove}
          disabled={disabled}
          aria-label={`Remove slide ${index + 1}`}
        >
          <Trash2 className="size-3" />
        </Button>
      </div>
      <Textarea
        value={slide.bullets}
        onChange={(e) => onChange({ bullets: e.target.value })}
        placeholder="One bullet per line"
        className="mt-1.5 min-h-[56px] text-[11px] font-mono leading-relaxed resize-y"
        disabled={disabled}
        spellCheck={false}
      />
    </motion.div>
  );
}

function SectionCard({
  index,
  section,
  onChange,
  onRemove,
  disabled,
}: {
  index: number;
  section: SectionDraft;
  onChange: (patch: Partial<SectionDraft>) => void;
  onRemove: () => void;
  disabled: boolean;
}) {
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: -2 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: -8 }}
      transition={{ duration: 0.15 }}
      className="group rounded-md border bg-background p-2"
    >
      <div className="flex items-center gap-1.5">
        <span className="font-mono text-[10px] text-muted-foreground w-5 shrink-0 text-right">
          {index + 1}
        </span>
        <Input
          value={section.heading}
          onChange={(e) => onChange({ heading: e.target.value })}
          placeholder="Section heading"
          className="h-7 text-xs flex-1"
          disabled={disabled}
          autoComplete="off"
          spellCheck={false}
        />
        <Button
          size="sm"
          variant="ghost"
          className="size-7 p-0 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity shrink-0"
          onClick={onRemove}
          disabled={disabled}
          aria-label={`Remove section ${index + 1}`}
        >
          <Trash2 className="size-3" />
        </Button>
      </div>
      <Textarea
        value={section.paragraphs}
        onChange={(e) => onChange({ paragraphs: e.target.value })}
        placeholder="One paragraph per line"
        className="mt-1.5 min-h-[64px] text-[11px] leading-relaxed resize-y"
        disabled={disabled}
        spellCheck={false}
      />
    </motion.div>
  );
}

/* --------------------------- Recent documents --------------------------- */

interface RecentDoc {
  path: string;
  name: string;
  ext: string;
  size?: number;
}

function flattenDocFiles(nodes: FileNode[]): RecentDoc[] {
  const out: RecentDoc[] = [];
  const walk = (ns: FileNode[]) => {
    for (const n of ns) {
      if (n.type === "file") {
        const lower = n.name.toLowerCase();
        const dot = lower.lastIndexOf(".");
        const ext = dot >= 0 ? lower.slice(dot) : "";
        if (DOC_EXT.has(ext)) {
          out.push({
            path: n.path,
            name: n.name,
            ext,
            size: n.size,
          });
        }
      } else if (n.children && n.children.length > 0) {
        walk(n.children);
      }
    }
  };
  walk(nodes);
  return out;
}

function RecentDocuments() {
  const openFileTab = useAppStore((s) => s.openFileTab);
  const setRightPanelTab = useAppStore((s) => s.setRightPanelTab);

  const [docs, setDocs] = React.useState<RecentDoc[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [expanded, setExpanded] = React.useState(true);

  const refresh = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchTree();
      const flat = flattenDocFiles(data.tree ?? []);
      // Sort by path (alphabetic) — stable for the user.
      flat.sort((a, b) => a.path.localeCompare(b.path));
      setDocs(flat);
    } catch (e) {
      if (e instanceof ApiRequestError && (e.status === 404 || e.status === 405)) {
        // Workspace not open yet — show empty state, not an error.
        setDocs([]);
        return;
      }
      setError(
        e instanceof ApiRequestError ? e.message : "Failed to list documents",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => {
      void refresh();
    }, POLL_RECENT_MS);
    return () => window.clearInterval(interval);
  }, [refresh]);

  const handleOpen = (path: string) => {
    setRightPanelTab("files");
    openFileTab(path);
  };

  const IconFor = (ext: string) => {
    if (ext === ".pptx") return Presentation;
    if (ext === ".pdf") return FileText;
    return FileType;
  };

  return (
    <div className="rounded-md border">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between px-2.5 py-1.5 hover:bg-accent/40 transition-colors"
        aria-expanded={expanded}
        aria-label={expanded ? "Collapse recent documents" : "Expand recent documents"}
      >
        <div className="flex items-center gap-1.5">
          {expanded ? (
            <ChevronDown className="size-3 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3 text-muted-foreground" />
          )}
          <FileBox className="size-3 text-brand" />
          <span className="text-[11px] font-medium">Recent documents</span>
          {docs.length > 0 && (
            <Badge variant="outline" className="text-[9px] h-3.5 font-mono">
              {docs.length}
            </Badge>
          )}
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation();
                void refresh();
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.stopPropagation();
                  void refresh();
                }
              }}
              className="inline-flex items-center justify-center size-5 rounded hover:bg-accent transition-colors"
              aria-label="Refresh recent documents"
            >
              <RefreshCw className={cn("size-3", loading && "animate-spin")} />
            </span>
          </TooltipTrigger>
          <TooltipContent side="left">Refresh</TooltipContent>
        </Tooltip>
      </button>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="overflow-hidden"
          >
            <div className="border-t px-1 py-1 max-h-64 overflow-y-auto">
              {loading && docs.length === 0 ? (
                <div className="space-y-1 p-1">
                  <Skeleton className="h-6 w-full" />
                  <Skeleton className="h-6 w-full" />
                </div>
              ) : error ? (
                <div className="flex items-start gap-1.5 p-2 text-[11px] text-amber-700 dark:text-amber-300">
                  <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                  <span>{error}</span>
                </div>
              ) : docs.length === 0 ? (
                <div className="p-2 text-[11px] text-muted-foreground">
                  No .pptx / .docx / .pdf files in the workspace yet.
                </div>
              ) : (
                <ul className="space-y-0.5">
                  {docs.map((d) => {
                    const Icon = IconFor(d.ext);
                    return (
                      <li
                        key={d.path}
                        className="group flex items-center gap-1.5 rounded px-1.5 py-1 hover:bg-accent/40 transition-colors"
                      >
                        <Icon
                          className={cn(
                            "size-3.5 shrink-0",
                            d.ext === ".pptx"
                              ? "text-brand"
                              : d.ext === ".pdf"
                                ? "text-rose-500"
                                : "text-amber-600 dark:text-amber-500",
                          )}
                        />
                        <span
                          className="text-[11px] font-mono truncate flex-1 min-w-0"
                          title={d.path}
                        >
                          {baseName(d.path)}
                        </span>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="size-6 p-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity shrink-0"
                          onClick={() => handleOpen(d.path)}
                          aria-label={`Open ${d.name}`}
                        >
                          <ExternalLink className="size-3" />
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
