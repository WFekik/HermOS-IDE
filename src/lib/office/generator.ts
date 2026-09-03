import path from "path";
import fs from "fs/promises";
import { existsSync, createWriteStream, readFileSync } from "fs";
import { safePath } from "@/lib/workspace";
import {
  type OfficeDocType,
  type OfficeThemeId,
  type SlideLayout,
  type PptSlide,
  type DocSection,
  type PdfSection,
  type DocCoverPage,
  type OfficeDocManifest,
} from "./types";
import {
  resolveOfficeTheme,
  hexToRgbTuple,
  OFFICE_THEMES,
} from "./themes";

// Lazy dynamic imports for heavy document generation libraries.
async function loadPptxGenJS() {
  const mod = await import("pptxgenjs");
  return mod.default;
}
async function loadDocx() {
  return await import("docx");
}
async function loadPDFKit() {
  const mod = await import("pdfkit");
  return mod.default;
}

/** Hard caps to keep generation bounded and responsive. */
export const MAX_SLIDES = 100;
export const MAX_SECTIONS = 100;
const MAX_BULLET_LEN = 2000;
const MAX_PARA_LEN = 10_000;
const MAX_TITLE_LEN = 300;
const MAX_HEADING_LEN = 300;

export interface GeneratePptOpts {
  title: string;
  subtitle?: string;
  slides: PptSlide[];
  theme?: OfficeThemeId;
  author?: string;
  outputPath: string;
}

export interface GenerateDocOpts {
  title: string;
  subtitle?: string;
  author?: string;
  organization?: string;
  coverPage?: boolean | DocCoverPage;
  sections: DocSection[];
  theme?: OfficeThemeId;
  outputPath: string;
}

export interface GeneratePdfOpts {
  title: string;
  subtitle?: string;
  author?: string;
  organization?: string;
  coverPage?: boolean | DocCoverPage;
  sections: DocSection[];
  theme?: OfficeThemeId;
  outputPath: string;
}

/** Resolve workspace-relative path to safe absolute path, ensuring parent dir exists. */
export async function resolveOutputPath(
  userId: string,
  wsName: string,
  rel: string,
  rootDir?: string,
): Promise<string> {
  const abs = safePath(userId, wsName, rel, rootDir);
  if (!abs) throw new Error("Invalid output path (path traversal or empty).");
  await fs.mkdir(path.dirname(abs), { recursive: true });
  return abs;
}

export function getManifestPath(binaryPath: string): string {
  const dir = path.dirname(binaryPath);
  const base = path.basename(binaryPath);
  return path.join(dir, `.${base}.hermos-office.json`);
}

export async function saveOfficeManifest(manifest: OfficeDocManifest): Promise<void> {
  try {
    const manifestPath = getManifestPath(manifest.path);
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  } catch (err) {
    console.warn("[saveOfficeManifest] Failed to save companion manifest:", err);
  }
}

export async function readOfficeManifest(binaryOrManifestPath: string): Promise<OfficeDocManifest | null> {
  try {
    const targetPath = binaryOrManifestPath.endsWith(".hermos-office.json")
      ? binaryOrManifestPath
      : getManifestPath(binaryOrManifestPath);

    if (!existsSync(targetPath)) return null;
    const content = await fs.readFile(targetPath, "utf8");
    return JSON.parse(content) as OfficeDocManifest;
  } catch {
    return null;
  }
}

function clip(s: string, max: number): string {
  if (typeof s !== "string") return "";
  if (s.length <= max) return s;
  return s.slice(0, max) + "…";
}

function cleanSlides(slides: PptSlide[]): PptSlide[] {
  return slides.slice(0, MAX_SLIDES).map((s, idx) => ({
    id: s.id || `slide-${idx + 1}`,
    title: clip(String(s.title || "").trim(), MAX_TITLE_LEN) || `Slide ${idx + 1}`,
    subtitle: s.subtitle ? clip(String(s.subtitle).trim(), MAX_TITLE_LEN) : undefined,
    layout: s.layout || (idx === 0 && !s.bullets?.length && !s.cards?.length ? "title" : "bullets"),
    bullets: Array.isArray(s.bullets)
      ? s.bullets.map((b) => clip(String(b || "").trim(), MAX_BULLET_LEN)).filter((b) => b.length > 0).slice(0, 20)
      : [],
    cards: Array.isArray(s.cards)
      ? s.cards.slice(0, 6).map((c) => ({
          title: clip(String(c.title || "").trim(), 100),
          description: clip(String(c.description || "").trim(), 500),
          value: c.value ? clip(String(c.value).trim(), 40) : undefined,
          badge: c.badge ? clip(String(c.badge).trim(), 40) : undefined,
          icon: c.icon ? clip(String(c.icon).trim(), 40) : undefined,
        }))
      : undefined,
    columns: Array.isArray(s.columns)
      ? s.columns.slice(0, 2).map((col) => ({
          heading: clip(String(col.heading || "").trim(), 100),
          bullets: Array.isArray(col.bullets)
            ? col.bullets.map((b) => clip(String(b || "").trim(), 500)).filter(Boolean).slice(0, 10)
            : [],
        }))
      : undefined,
    image: s.image
      ? {
          path: String(s.image.path || "").trim(),
          alt: s.image.alt ? clip(String(s.image.alt).trim(), 100) : undefined,
          caption: s.image.caption ? clip(String(s.image.caption).trim(), 200) : undefined,
          position: s.image.position || "right",
        }
      : undefined,
    table: s.table && Array.isArray(s.table.headers) && Array.isArray(s.table.rows)
      ? {
          headers: s.table.headers.slice(0, 8).map((h) => clip(String(h).trim(), 80)),
          rows: s.table.rows.slice(0, 15).map((row) =>
            (Array.isArray(row) ? row : []).slice(0, 8).map((cell) => clip(String(cell).trim(), 200))
          ),
        }
      : undefined,
    steps: Array.isArray(s.steps)
      ? s.steps.slice(0, 5).map((st, sIdx) => ({
          step: clip(String(st.step || `0${sIdx + 1}`).trim(), 10),
          title: clip(String(st.title || "").trim(), 100),
          description: clip(String(st.description || "").trim(), 400),
        }))
      : undefined,
    quote: s.quote
      ? {
          text: clip(String(s.quote.text || "").trim(), 1000),
          author: s.quote.author ? clip(String(s.quote.author).trim(), 100) : undefined,
          role: s.quote.role ? clip(String(s.quote.role).trim(), 100) : undefined,
        }
      : undefined,
    notes: s.notes ? clip(String(s.notes), MAX_PARA_LEN) : undefined,
    accentColor: s.accentColor,
  }));
}

function cleanSections(sections: DocSection[]): DocSection[] {
  return sections.slice(0, MAX_SECTIONS).map((sec, idx) => ({
    id: sec.id || `section-${idx + 1}`,
    heading: clip(String(sec.heading || "").trim(), MAX_HEADING_LEN) || `Section ${idx + 1}`,
    subheading: sec.subheading ? clip(String(sec.subheading).trim(), MAX_HEADING_LEN) : undefined,
    paragraphs: Array.isArray(sec.paragraphs)
      ? sec.paragraphs.map((p) => clip(String(p || "").trim(), MAX_PARA_LEN)).filter((p) => p.length > 0).slice(0, 40)
      : [],
    bullets: Array.isArray(sec.bullets)
      ? sec.bullets.map((b) => clip(String(b || "").trim(), MAX_BULLET_LEN)).filter(Boolean).slice(0, 25)
      : undefined,
    callout: sec.callout
      ? {
          type: sec.callout.type || "info",
          title: sec.callout.title ? clip(String(sec.callout.title).trim(), 100) : undefined,
          text: clip(String(sec.callout.text || "").trim(), 2000),
        }
      : undefined,
    table: sec.table && Array.isArray(sec.table.headers) && Array.isArray(sec.table.rows)
      ? {
          headers: sec.table.headers.slice(0, 8).map((h) => clip(String(h).trim(), 80)),
          rows: sec.table.rows.slice(0, 20).map((row) =>
            (Array.isArray(row) ? row : []).slice(0, 8).map((cell) => clip(String(cell).trim(), 200))
          ),
        }
      : undefined,
    metrics: Array.isArray(sec.metrics)
      ? sec.metrics.slice(0, 4).map((m) => ({
          label: clip(String(m.label || "").trim(), 80),
          value: clip(String(m.value || "").trim(), 40),
          change: m.change ? clip(String(m.change).trim(), 40) : undefined,
        }))
      : undefined,
    image: sec.image
      ? {
          path: String(sec.image.path || "").trim(),
          caption: sec.image.caption ? clip(String(sec.image.caption).trim(), 200) : undefined,
        }
      : undefined,
  }));
}

export function resolveSlideCards(slide: PptSlide): Array<{ title: string; description: string; value?: string; badge?: string }> {
  if (slide.cards && slide.cards.length > 0) return slide.cards;
  if (slide.bullets && slide.bullets.length > 0) {
    return slide.bullets.map((b, i) => ({
      title: `Key Highlight ${i + 1}`,
      description: b,
      badge: `Key Point`,
    }));
  }
  return [
    { title: "Strategic Objective", description: "Core platform milestone and architectural deliverables", badge: "Milestone" },
    { title: "Performance Impact", description: "High-throughput processing with sub-100ms response targets", badge: "Metrics" },
    { title: "Operational Excellence", description: "End-to-end observability, automated testing, and zero-downtime releases", badge: "Operations" },
  ];
}

export function resolveSlideColumns(slide: PptSlide): Array<{ heading: string; bullets: string[] }> {
  if (slide.columns && slide.columns.length === 2) return slide.columns;
  if (slide.bullets && slide.bullets.length > 1) {
    const mid = Math.ceil(slide.bullets.length / 2);
    return [
      { heading: "Current Overview", bullets: slide.bullets.slice(0, mid) },
      { heading: "Target State", bullets: slide.bullets.slice(mid) },
    ];
  }
  return [
    { heading: "Core Capabilities", bullets: ["Modern architectural design", "Scalable, resilient processing"] },
    { heading: "Strategic Focus", bullets: ["Continuous quality verification", "Enterprise compliance and telemetry"] },
  ];
}

export function resolveSlideTable(slide: PptSlide): { headers: string[]; rows: string[][] } {
  if (slide.table && slide.table.headers && slide.table.headers.length > 0) return slide.table;
  if (slide.bullets && slide.bullets.length > 0) {
    return {
      headers: ["Metric", "Target Value", "Status"],
      rows: slide.bullets.map((b, i) => [`Key Metric ${i + 1}`, b, "On Track"]),
    };
  }
  return {
    headers: ["Component", "Throughput", "Latency (p95)", "Status"],
    rows: [
      ["API Gateway", "50K req/s", "12ms", "On Track"],
      ["Compute Engine", "120 nodes", "45ms", "On Track"],
      ["Data Pipeline", "1.2 TB/hr", "80ms", "Exceeding"],
    ],
  };
}

export function resolveSlideSteps(slide: PptSlide): Array<{ step: string; title: string; description: string }> {
  if (slide.steps && slide.steps.length > 0) return slide.steps;
  if (slide.bullets && slide.bullets.length > 0) {
    return slide.bullets.map((b, i) => ({
      step: `0${i + 1}`,
      title: `Phase ${i + 1}`,
      description: b,
    }));
  }
  return [
    { step: "01", title: "Discovery", description: "Baseline discovery and architectural scoping" },
    { step: "02", title: "Execution", description: "Core service implementation and automated testing" },
    { step: "03", title: "Delivery", description: "Progressive staged rollout with live observability" },
  ];
}

export function resolveSlideQuote(slide: PptSlide): { text: string; author?: string; role?: string } {
  if (slide.quote && slide.quote.text) return slide.quote;
  if (slide.bullets && slide.bullets.length > 0) {
    return { text: slide.bullets[0], author: "Executive Leadership", role: "HermOS Platform" };
  }
  return {
    text: "Excellence is not an exception, it is a prevailing attitude. Design with purpose and deliver with velocity.",
    author: "Executive Leadership",
    role: "Engineering & Architecture",
  };
}

/**
 * High-fidelity PowerPoint generator (.pptx) supporting 8 distinct slide layouts,
 * executive theme palettes, KPI cards, tables, split comparisons, images, and notes.
 */
export async function generatePpt(
  opts: GeneratePptOpts,
): Promise<{ path: string; slides: number; manifest: OfficeDocManifest }> {
  const title = clip(String(opts.title || "Executive Presentation").trim(), MAX_TITLE_LEN);
  const subtitle = opts.subtitle ? clip(String(opts.subtitle).trim(), MAX_TITLE_LEN) : undefined;
  const slides = cleanSlides(opts.slides || []);
  const theme = resolveOfficeTheme(opts.theme);

  const PptxGenJS = await loadPptxGenJS();
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_16x9";
  pptx.author = opts.author || "HermOS AI Studio";
  pptx.company = "HermOS";
  pptx.subject = title;
  pptx.title = title;

  const totalSlides = slides.length;

  for (let i = 0; i < slides.length; i++) {
    const sData = slides[i];
    const s = pptx.addSlide();
    const isFirst = i === 0;
    const isTitleLayout = sData.layout === "title" || (isFirst && totalSlides > 1 && sData.layout !== "cards");

    // Set background color based on theme
    s.background = { color: isTitleLayout && theme.isDarkTheme ? theme.primaryDark : theme.bg };

    // Slide footer & page numbering (except cover)
    if (!isTitleLayout) {
      s.addShape("rect", {
        x: 0.6,
        y: 7.0,
        w: 12.13,
        h: 0.02,
        fill: { color: theme.border },
        line: { color: theme.border, width: 0 },
      });
      s.addText(`${title} • HermOS Office`, {
        x: 0.6,
        y: 7.05,
        w: 8.0,
        h: 0.35,
        fontSize: 10,
        color: theme.textMuted,
        fontFace: "Calibri",
      });
      s.addText(`${i + 1} / ${totalSlides}`, {
        x: 10.0,
        y: 7.05,
        w: 2.73,
        h: 0.35,
        align: "right",
        fontSize: 10,
        color: theme.textMuted,
        fontFace: "Calibri",
      });
    }

    if (isTitleLayout) {
      // ===== COVER SLIDE LAYOUT =====
      // Top executive accent bar
      s.addShape("rect", {
        x: 0,
        y: 0,
        w: "100%",
        h: 0.35,
        fill: { color: theme.primary },
        line: { color: theme.primary, width: 0 },
      });

      // Subtle decorative accent block
      s.addShape("rect", {
        x: 0.8,
        y: 1.5,
        w: 0.15,
        h: 2.4,
        fill: { color: theme.accent },
        line: { color: theme.accent, width: 0 },
      });

      s.addText(sData.title || title, {
        x: 1.2,
        y: 1.4,
        w: 10.5,
        h: 1.8,
        bold: true,
        fontSize: 40,
        color: theme.textDark,
        fontFace: "Calibri",
      });

      const coverSub = sData.subtitle || subtitle || `${totalSlides} Slides • Prepared with HermOS AI`;
      s.addText(coverSub, {
        x: 1.2,
        y: 3.2,
        w: 10.5,
        h: 0.8,
        fontSize: 18,
        color: theme.secondary,
        fontFace: "Calibri",
      });

      // Metadata pill badge
      s.addShape("roundRect", {
        x: 1.2,
        y: 4.8,
        w: 4.5,
        h: 0.6,
        rectRadius: 0.1,
        fill: { color: theme.cardBg },
        line: { color: theme.border, width: 1 },
      });
      s.addText(`Author: ${opts.author || "HermOS AI"}  •  ${new Date().toLocaleDateString()}`, {
        x: 1.4,
        y: 4.9,
        w: 4.1,
        h: 0.4,
        fontSize: 11,
        color: theme.textMuted,
        fontFace: "Calibri",
      });
    } else {
      // Header for content slides
      s.addShape("rect", {
        x: 0.6,
        y: 0.5,
        w: 0.12,
        h: 0.55,
        fill: { color: sData.accentColor || theme.primary },
        line: { color: sData.accentColor || theme.primary, width: 0 },
      });

      s.addText(sData.title, {
        x: 0.9,
        y: 0.45,
        w: 11.5,
        h: 0.65,
        bold: true,
        fontSize: 24,
        color: theme.textDark,
        fontFace: "Calibri",
      });

      if (sData.subtitle) {
        s.addText(sData.subtitle, {
          x: 0.9,
          y: 1.05,
          w: 11.5,
          h: 0.4,
          fontSize: 13,
          color: theme.textMuted,
          fontFace: "Calibri",
        });
      }

      const contentY = sData.subtitle ? 1.55 : 1.35;

      // Layout Dispatcher
      if (sData.layout === "cards") {
        // ===== KPI / FEATURE CARDS LAYOUT =====
        const resolvedCards = resolveSlideCards(sData);
        const count = Math.min(resolvedCards.length, 4);
        const cardW = count === 2 ? 5.5 : count === 3 ? 3.6 : 2.7;
        const gap = 0.3;
        const totalW = count * cardW + (count - 1) * gap;
        const startX = 0.6 + Math.max(0, (12.13 - totalW) / 2);

        for (let cIdx = 0; cIdx < count; cIdx++) {
          const card = resolvedCards[cIdx];
          const cx = startX + cIdx * (cardW + gap);

          s.addShape("roundRect", {
            x: cx,
            y: contentY + 0.2,
            w: cardW,
            h: 4.6,
            rectRadius: 0.12,
            fill: { color: theme.cardBg },
            line: { color: theme.border, width: 1 },
          });

          // Card top accent line
          s.addShape("rect", {
            x: cx + 0.3,
            y: contentY + 0.45,
            w: 0.8,
            h: 0.05,
            fill: { color: theme.primary },
            line: { color: theme.primary, width: 0 },
          });

          if (card.value) {
            s.addText(card.value, {
              x: cx + 0.3,
              y: contentY + 0.65,
              w: cardW - 0.6,
              h: 0.8,
              bold: true,
              fontSize: 32,
              color: theme.primary,
              fontFace: "Calibri",
            });
          }

          if (card.badge) {
            s.addShape("roundRect", {
              x: cx + 0.3,
              y: contentY + (card.value ? 1.5 : 0.65),
              w: Math.min(cardW - 0.6, 2.0),
              h: 0.35,
              rectRadius: 0.06,
              fill: { color: theme.tagBg },
              line: { color: theme.accent, width: 1 },
            });
            s.addText(card.badge, {
              x: cx + 0.4,
              y: contentY + (card.value ? 1.52 : 0.67),
              w: Math.min(cardW - 0.8, 1.8),
              h: 0.3,
              fontSize: 10,
              bold: true,
              color: theme.primaryDark,
              fontFace: "Calibri",
            });
          }

          const titleY = contentY + (card.value ? (card.badge ? 2.0 : 1.6) : (card.badge ? 1.15 : 0.65));
          s.addText(card.title, {
            x: cx + 0.3,
            y: titleY,
            w: cardW - 0.6,
            h: 0.6,
            bold: true,
            fontSize: 16,
            color: theme.textDark,
            fontFace: "Calibri",
          });

          s.addText(card.description, {
            x: cx + 0.3,
            y: titleY + 0.6,
            w: cardW - 0.6,
            h: 2.2,
            fontSize: 12,
            color: theme.textMuted,
            fontFace: "Calibri",
          });
        }
      } else if (sData.layout === "split") {
        // ===== 2-COLUMN SPLIT COMPARISON =====
        const columns = resolveSlideColumns(sData);
        const colW = 5.7;
        for (let colIdx = 0; colIdx < 2; colIdx++) {
          const col = columns[colIdx];
          const cx = 0.6 + colIdx * 6.3;

          s.addShape("roundRect", {
            x: cx,
            y: contentY + 0.1,
            w: colW,
            h: 4.8,
            rectRadius: 0.1,
            fill: { color: theme.cardBg },
            line: { color: theme.border, width: 1 },
          });

          s.addText(col.heading, {
            x: cx + 0.4,
            y: contentY + 0.3,
            w: colW - 0.8,
            h: 0.5,
            bold: true,
            fontSize: 18,
            color: colIdx === 0 ? theme.primary : theme.secondary,
            fontFace: "Calibri",
          });

          const bulletItems = col.bullets.map((b) => ({
            text: b,
            options: { fontSize: 13, color: theme.textDark, bullet: true, spacing: { after: 12 } },
          }));
          s.addText(bulletItems, {
            x: cx + 0.4,
            y: contentY + 0.9,
            w: colW - 0.8,
            h: 3.8,
            fontFace: "Calibri",
          });
        }
      } else if (sData.layout === "table") {
        // ===== DATA TABLE LAYOUT =====
        const table = resolveSlideTable(sData);
        const headers = table.headers;
        const rows = table.rows || [];
        const tableRows: any[] = [];

        // Header row
        tableRows.push(
          headers.map((h) => ({
            text: h,
            options: {
              bold: true,
              color: "FFFFFF",
              fill: { color: theme.primary },
              fontSize: 12,
              align: "center",
            },
          }))
        );

        // Data rows
        for (let rIdx = 0; rIdx < rows.length; rIdx++) {
          const row = rows[rIdx];
          const isEven = rIdx % 2 === 0;
          tableRows.push(
            row.map((cell) => ({
              text: cell,
              options: {
                color: theme.textDark,
                fill: { color: isEven ? theme.bg : theme.cardBg },
                fontSize: 11,
              },
            }))
          );
        }

        s.addTable(tableRows, {
          x: 0.8,
          y: contentY + 0.2,
          w: 11.73,
          border: { pt: 0.5, color: theme.border },
          autoPage: false,
        });
      } else if (sData.layout === "quote") {
        // ===== IMPACT QUOTE LAYOUT =====
        const quote = resolveSlideQuote(sData);
        s.addShape("rect", {
          x: 1.5,
          y: contentY + 0.6,
          w: 0.15,
          h: 2.8,
          fill: { color: theme.accent },
          line: { color: theme.accent, width: 0 },
        });

        s.addText(`“${quote.text}”`, {
          x: 1.9,
          y: contentY + 0.5,
          w: 9.5,
          h: 2.2,
          italic: true,
          fontSize: 24,
          color: theme.textDark,
          fontFace: "Calibri",
        });

        const attribution = quote.role
          ? `— ${quote.author || "Anonymous"}, ${quote.role}`
          : `— ${quote.author || "Anonymous"}`;
        s.addText(attribution, {
          x: 1.9,
          y: contentY + 2.7,
          w: 9.5,
          h: 0.5,
          bold: true,
          fontSize: 14,
          color: theme.primary,
          fontFace: "Calibri",
        });
      } else if (sData.layout === "timeline") {
        // ===== TIMELINE / STEPS LAYOUT =====
        const steps = resolveSlideSteps(sData);
        const stepCount = Math.min(steps.length, 5);
        const stepW = 11.5 / stepCount;

        for (let stIdx = 0; stIdx < stepCount; stIdx++) {
          const step = steps[stIdx];
          const stX = 0.9 + stIdx * stepW;

          // Step circle badge
          s.addShape("roundRect", {
            x: stX,
            y: contentY + 0.3,
            w: 1.1,
            h: 0.6,
            rectRadius: 0.1,
            fill: { color: theme.primary },
            line: { color: theme.primary, width: 0 },
          });
          s.addText(step.step, {
            x: stX,
            y: contentY + 0.38,
            w: 1.1,
            h: 0.5,
            align: "center",
            bold: true,
            fontSize: 14,
            color: "FFFFFF",
            fontFace: "Calibri",
          });

          // Step title
          s.addText(step.title, {
            x: stX,
            y: contentY + 1.1,
            w: stepW - 0.4,
            h: 0.6,
            bold: true,
            fontSize: 15,
            color: theme.textDark,
            fontFace: "Calibri",
          });

          // Step description
          s.addText(step.description, {
            x: stX,
            y: contentY + 1.7,
            w: stepW - 0.4,
            h: 2.8,
            fontSize: 12,
            color: theme.textMuted,
            fontFace: "Calibri",
          });
        }
      } else if (sData.layout === "image_split" && sData.image?.path) {
        // ===== IMAGE SPLIT LAYOUT =====
        const imgPath = sData.image.path;
        const hasLocalImg = existsSync(imgPath);

        if (hasLocalImg) {
          try {
            s.addImage({
              path: imgPath,
              x: 0.8,
              y: contentY + 0.2,
              w: 5.2,
              h: 4.5,
            });
          } catch {
            // Fallback placeholder card
            s.addShape("roundRect", {
              x: 0.8,
              y: contentY + 0.2,
              w: 5.2,
              h: 4.5,
              rectRadius: 0.1,
              fill: { color: theme.cardBg },
              line: { color: theme.border, width: 1 },
            });
            s.addText(`[Image: ${sData.image.caption || path.basename(imgPath)}]`, {
              x: 1.0,
              y: contentY + 2.0,
              w: 4.8,
              h: 1.0,
              align: "center",
              fontSize: 12,
              color: theme.textMuted,
            });
          }
        }

        // Bullets on right side
        const bulletItems = (sData.bullets || []).map((b) => ({
          text: b,
          options: { fontSize: 14, color: theme.textDark, bullet: true, spacing: { after: 14 } },
        }));
        s.addText(bulletItems, {
          x: 6.4,
          y: contentY + 0.3,
          w: 5.8,
          h: 4.5,
          fontFace: "Calibri",
        });
      } else {
        // ===== STANDARD BULLETS LAYOUT (Default) =====
        const bulletItems = (sData.bullets || []).map((b) => ({
          text: b,
          options: {
            fontSize: 15,
            color: theme.textDark,
            bullet: true,
            spacing: { after: 16 },
          },
        }));

        s.addText(bulletItems, {
          x: 0.9,
          y: contentY + 0.3,
          w: 11.5,
          h: 4.8,
          fontFace: "Calibri",
        });
      }
    }

    // Speaker notes
    if (sData.notes) {
      s.addNotes(sData.notes);
    }
  }

  const out = (await pptx.write({ outputType: "nodebuffer" })) as Buffer;
  await fs.writeFile(opts.outputPath, out);

  const manifest: OfficeDocManifest = {
    version: 1,
    path: opts.outputPath,
    type: "presentation",
    title,
    subtitle,
    theme: (opts.theme as OfficeThemeId) || "executive",
    author: opts.author,
    slides,
    updatedAt: Date.now(),
  };
  await saveOfficeManifest(manifest);

  return { path: opts.outputPath, slides: slides.length, manifest };
}

export interface InitPresentationOpts {
  path: string;
  title: string;
  subtitle?: string;
  theme?: OfficeThemeId;
  author?: string;
  initialSlide?: PptSlide;
}

/**
 * Initialize a presentation deck file (.pptx) with title, subtitle, theme, and optional cover slide.
 * Enables the Kimi/GLM step-by-step workflow: initialize deck, then add slides one-by-one.
 */
export async function initPresentation(
  opts: InitPresentationOpts,
): Promise<{ path: string; slides: number; manifest: OfficeDocManifest }> {
  const initialSlide: PptSlide = opts.initialSlide ?? {
    id: "slide-1",
    title: opts.title,
    subtitle: opts.subtitle,
    layout: "title",
    bullets: [],
  };

  return await generatePpt({
    title: opts.title,
    subtitle: opts.subtitle,
    theme: opts.theme,
    author: opts.author,
    slides: [initialSlide],
    outputPath: opts.path,
  });
}

export interface AddPresentationSlideOpts {
  path: string;
  slide: PptSlide;
}

/**
 * Append a single, carefully crafted slide to an existing presentation.
 * Immediately regenerates the .pptx binary and companion manifest so the Office Studio updates live.
 */
export async function addPresentationSlide(
  opts: AddPresentationSlideOpts,
): Promise<{ path: string; slideIndex: number; totalSlides: number; manifest: OfficeDocManifest }> {
  let manifest = await readOfficeManifest(opts.path);
  if (!manifest || manifest.type !== "presentation") {
    manifest = {
      version: 1,
      path: opts.path,
      type: "presentation",
      title: opts.slide.title || "Executive Presentation",
      theme: "executive",
      slides: [],
      updatedAt: Date.now(),
    };
  }

  const slides = [...(manifest.slides || [])];
  const slideWithId: PptSlide = {
    ...opts.slide,
    id: opts.slide.id || `slide-${slides.length + 1}`,
  };
  slides.push(slideWithId);

  const res = await generatePpt({
    title: manifest.title,
    subtitle: manifest.subtitle,
    theme: manifest.theme as OfficeThemeId,
    author: manifest.author,
    slides,
    outputPath: opts.path,
  });

  return {
    path: opts.path,
    slideIndex: slides.length - 1,
    totalSlides: slides.length,
    manifest: res.manifest,
  };
}

export interface UpdatePresentationSlideOpts {
  path: string;
  slideIndex: number;
  slide: Partial<PptSlide>;
}

/**
 * Update or refine an existing slide in a presentation by slide index (1-based or 0-based).
 */
export async function updatePresentationSlide(
  opts: UpdatePresentationSlideOpts,
): Promise<{ path: string; slideIndex: number; totalSlides: number; manifest: OfficeDocManifest }> {
  const manifest = await readOfficeManifest(opts.path);
  if (!manifest || !manifest.slides || manifest.slides.length === 0) {
    throw new Error(`Presentation not found or has no slides: ${opts.path}`);
  }

  const idx =
    opts.slideIndex >= 1 && opts.slideIndex <= manifest.slides.length
      ? opts.slideIndex - 1
      : opts.slideIndex;

  if (idx < 0 || idx >= manifest.slides.length) {
    throw new Error(
      `Invalid slide index: ${opts.slideIndex}. Total slides in deck: ${manifest.slides.length}`
    );
  }

  const slides = [...manifest.slides];
  slides[idx] = { ...slides[idx], ...opts.slide };

  const res = await generatePpt({
    title: manifest.title,
    subtitle: manifest.subtitle,
    theme: manifest.theme as OfficeThemeId,
    author: manifest.author,
    slides,
    outputPath: opts.path,
  });

  return {
    path: opts.path,
    slideIndex: idx,
    totalSlides: slides.length,
    manifest: res.manifest,
  };
}

/**
 * Generate formatted .docx document at outputPath supporting cover pages,
 * headers/footers with page numbers, callout boxes, tables, and metric summaries.
 */
export async function generateDoc(
  opts: GenerateDocOpts,
): Promise<{ path: string; sections: number; manifest: OfficeDocManifest }> {
  const {
    Document,
    Packer,
    Paragraph,
    TextRun,
    HeadingLevel,
    AlignmentType,
    Table,
    TableRow,
    TableCell,
    WidthType,
    BorderStyle,
    ShadingType,
    Header,
    Footer,
    PageNumber,
    ImageRun,
  } = await loadDocx();

  const title = clip(String(opts.title || "Document").trim(), MAX_TITLE_LEN);
  const subtitle = opts.subtitle ? clip(String(opts.subtitle).trim(), MAX_TITLE_LEN) : undefined;
  const sections = cleanSections(opts.sections || []);
  const theme = resolveOfficeTheme(opts.theme);

  const children: any[] = [];

  // 1. Cover / Title Header
  children.push(
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({
          text: title,
          bold: true,
          size: 44, // 22pt
          color: theme.primary,
        }),
      ],
      spacing: { before: 240, after: 160 },
    }),
  );

  if (subtitle) {
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [
          new TextRun({
            text: subtitle,
            italics: true,
            size: 24, // 12pt
            color: theme.secondary,
          }),
        ],
        spacing: { after: 240 },
      }),
    );
  }

  // Metadata line
  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({
          text: `Prepared by ${opts.author || "HermOS AI Studio"}${opts.organization ? ` • ${opts.organization}` : ""} • ${new Date().toLocaleDateString()}`,
          size: 20, // 10pt
          color: theme.textMuted,
        }),
      ],
      spacing: { after: 480 },
    }),
  );

  // 2. Document Sections
  for (const sec of sections) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        children: [
          new TextRun({
            text: sec.heading,
            bold: true,
            size: 28, // 14pt
            color: theme.primary,
          }),
        ],
        spacing: { before: 360, after: 120 },
      }),
    );

    if (sec.subheading) {
      children.push(
        new Paragraph({
          children: [
            new TextRun({
              text: sec.subheading,
              italics: true,
              size: 22,
              color: theme.textMuted,
            }),
          ],
          spacing: { after: 120 },
        }),
      );
    }

    // Callout box
    if (sec.callout) {
      children.push(
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          borders: {
            left: { style: BorderStyle.SINGLE, size: 24, color: theme.primary },
            top: { style: BorderStyle.NONE },
            right: { style: BorderStyle.NONE },
            bottom: { style: BorderStyle.NONE },
          },
          rows: [
            new TableRow({
              children: [
                new TableCell({
                  shading: { type: ShadingType.CLEAR, fill: theme.cardBg },
                  margins: { top: 140, bottom: 140, left: 200, right: 200 },
                  children: [
                    ...(sec.callout.title
                      ? [
                          new Paragraph({
                            children: [
                              new TextRun({
                                text: sec.callout.title,
                                bold: true,
                                size: 20,
                                color: theme.primary,
                              }),
                            ],
                            spacing: { after: 60 },
                          }),
                        ]
                      : []),
                    new Paragraph({
                      children: [
                        new TextRun({
                          text: sec.callout.text,
                          italics: true,
                          size: 20,
                          color: theme.textDark,
                        }),
                      ],
                    }),
                  ],
                }),
              ],
            }),
          ],
        }),
      );
      children.push(new Paragraph({ spacing: { after: 160 } }));
    }

    // Paragraphs
    for (const p of sec.paragraphs || []) {
      children.push(
        new Paragraph({
          children: [
            new TextRun({
              text: p,
              size: 22, // 11pt
              color: theme.textDark,
            }),
          ],
          spacing: { after: 140, line: 276 },
        }),
      );
    }

    // Bullets
    if (sec.bullets && sec.bullets.length > 0) {
      for (const b of sec.bullets) {
        children.push(
          new Paragraph({
            bullet: { level: 0 },
            children: [
              new TextRun({
                text: b,
                size: 22,
                color: theme.textDark,
              }),
            ],
            spacing: { after: 80 },
          }),
        );
      }
      children.push(new Paragraph({ spacing: { after: 120 } }));
    }

    // Data Table
    if (sec.table && sec.table.headers.length > 0) {
      const tableRows: any[] = [];
      tableRows.push(
        new TableRow({
          children: sec.table.headers.map(
            (h) =>
              new TableCell({
                shading: { type: ShadingType.CLEAR, fill: theme.primary },
                margins: { top: 100, bottom: 100, left: 140, right: 140 },
                children: [
                  new Paragraph({
                    children: [new TextRun({ text: h, bold: true, color: "FFFFFF", size: 20 })],
                  }),
                ],
              })
          ),
        })
      );

      for (const r of sec.table.rows || []) {
        tableRows.push(
          new TableRow({
            children: r.map(
              (c) =>
                new TableCell({
                  margins: { top: 80, bottom: 80, left: 140, right: 140 },
                  children: [
                    new Paragraph({
                      children: [new TextRun({ text: c, color: theme.textDark, size: 20 })],
                    }),
                  ],
                })
            ),
          })
        );
      }

      children.push(
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: tableRows,
        })
      );
      children.push(new Paragraph({ spacing: { after: 200 } }));
    }

    // Embedded Image
    if (sec.image?.path && existsSync(sec.image.path)) {
      try {
        const imgBuffer = readFileSync(sec.image.path);
        children.push(
          new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [
              new ImageRun({
                data: imgBuffer,
                transformation: { width: 500, height: 300 },
                type: "png",
              }),
            ],
            spacing: { before: 160, after: sec.image.caption ? 80 : 200 },
          })
        );
        if (sec.image.caption) {
          children.push(
            new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [
                new TextRun({
                  text: sec.image.caption,
                  italics: true,
                  size: 18,
                  color: theme.textMuted,
                }),
              ],
              spacing: { after: 200 },
            })
          );
        }
      } catch {
        /* skip broken image */
      }
    }
  }

  const doc = new Document({
    creator: opts.author || "HermOS AI Studio",
    title,
    description: subtitle || title,
    sections: [
      {
        headers: {
          default: new Header({
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                children: [
                  new TextRun({
                    text: `${title} • HermOS Office`,
                    size: 16,
                    color: theme.textMuted,
                  }),
                ],
              }),
            ],
          }),
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                children: [
                  new TextRun({ text: "Page ", size: 16, color: theme.textMuted }),
                  new TextRun({ children: [PageNumber.CURRENT], size: 16, color: theme.textMuted }),
                  new TextRun({ text: " of ", size: 16, color: theme.textMuted }),
                  new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 16, color: theme.textMuted }),
                ],
              }),
            ],
          }),
        },
        properties: {
          page: { margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } },
        },
        children,
      },
    ],
  });

  const buffer = await Packer.toBuffer(doc);
  await fs.writeFile(opts.outputPath, buffer);

  const manifest: OfficeDocManifest = {
    version: 1,
    path: opts.outputPath,
    type: "document",
    title,
    subtitle,
    theme: (opts.theme as OfficeThemeId) || "executive",
    author: opts.author,
    organization: opts.organization,
    sections,
    updatedAt: Date.now(),
  };
  await saveOfficeManifest(manifest);

  return { path: opts.outputPath, sections: sections.length, manifest };
}

/**
 * Generate styled .pdf document at outputPath via PDFKit write stream,
 * supporting running headers/footers, callout boxes, metric summaries, and tables.
 */
export async function generatePdf(
  opts: GeneratePdfOpts,
): Promise<{ path: string; sections: number; manifest: OfficeDocManifest }> {
  const PDFDocument = await loadPDFKit();
  const title = clip(String(opts.title || "PDF Report").trim(), MAX_TITLE_LEN);
  const subtitle = opts.subtitle ? clip(String(opts.subtitle).trim(), MAX_TITLE_LEN) : undefined;
  const sections = cleanSections(opts.sections || []);
  const theme = resolveOfficeTheme(opts.theme);

  const manifest: OfficeDocManifest = {
    version: 1,
    path: opts.outputPath,
    type: "pdf",
    title,
    subtitle,
    theme: (opts.theme as OfficeThemeId) || "executive",
    author: opts.author,
    organization: opts.organization,
    sections,
    updatedAt: Date.now(),
  };

  return new Promise<{ path: string; sections: number; manifest: OfficeDocManifest }>((resolve, reject) => {
    const doc = new PDFDocument({
      info: {
        Title: title,
        Author: opts.author || "HermOS AI Studio",
        Subject: subtitle || title,
        Creator: "HermOS Office",
      },
      size: "LETTER",
      margins: { top: 72, bottom: 72, left: 72, right: 72 },
      bufferPages: true,
    });

    const stream = createWriteStream(opts.outputPath);
    stream.on("error", (err) => {
      try { doc.destroy(); } catch {}
      reject(new Error(`Failed to write PDF: ${err.message}`));
    });
    stream.on("finish", async () => {
      await saveOfficeManifest(manifest);
      resolve({ path: opts.outputPath, sections: sections.length, manifest });
    });

    doc.pipe(stream);

    const primaryRgb = hexToRgbTuple(theme.primary);
    const cardBgRgb = hexToRgbTuple(theme.cardBg);
    const textDarkRgb = hexToRgbTuple(theme.textDark);
    const textMutedRgb = hexToRgbTuple(theme.textMuted);
    const borderRgb = hexToRgbTuple(theme.border);

    // Cover / Header Banner
    doc.fillColor(primaryRgb).rect(0, 0, doc.page.width, 140).fill();

    doc.fillColor([255, 255, 255]).font("Helvetica-Bold").fontSize(26).text(title, 72, 40, {
      width: doc.page.width - 144,
      align: "center",
    });

    if (subtitle) {
      doc.fillColor([230, 240, 255]).font("Helvetica").fontSize(13).text(subtitle, 72, 78, {
        width: doc.page.width - 144,
        align: "center",
      });
    }

    doc.fillColor([200, 220, 245]).font("Helvetica-Oblique").fontSize(10).text(
      `Prepared by ${opts.author || "HermOS AI Studio"} • ${new Date().toLocaleDateString()}`,
      72,
      105,
      { width: doc.page.width - 144, align: "center" }
    );

    let y = 170;
    const pageBottom = doc.page.height - 72;
    const pageWidth = doc.page.width - 144;

    const ensureSpace = (needed: number) => {
      if (y + needed > pageBottom) {
        doc.addPage();
        y = 72;
      }
    };

    for (const sec of sections) {
      ensureSpace(40);

      // Heading
      doc.fillColor(primaryRgb).font("Helvetica-Bold").fontSize(16).text(sec.heading, 72, y, { width: pageWidth });
      const hHeight = doc.heightOfString(sec.heading, { width: pageWidth });
      y += hHeight + 6;

      // Subtle underline
      doc.strokeColor(borderRgb).lineWidth(1).moveTo(72, y).lineTo(doc.page.width - 72, y).stroke();
      y += 12;

      // Subheading
      if (sec.subheading) {
        doc.fillColor(textMutedRgb).font("Helvetica-Oblique").fontSize(11).text(sec.subheading, 72, y, { width: pageWidth });
        y += doc.heightOfString(sec.subheading, { width: pageWidth }) + 8;
      }

      // Callout box
      if (sec.callout) {
        const calloutText = sec.callout.text;
        const calloutHeight = doc.heightOfString(calloutText, { width: pageWidth - 32 }) + 24;
        ensureSpace(calloutHeight + 12);

        doc.fillColor(cardBgRgb).rect(72, y, pageWidth, calloutHeight).fill();
        doc.fillColor(primaryRgb).rect(72, y, 4, calloutHeight).fill();

        doc.fillColor(textDarkRgb).font("Helvetica-Oblique").fontSize(10).text(calloutText, 88, y + 12, {
          width: pageWidth - 32,
          lineGap: 3,
        });
        y += calloutHeight + 14;
      }

      // Paragraphs
      for (const p of sec.paragraphs || []) {
        const pHeight = doc.heightOfString(p, { width: pageWidth, lineGap: 4 });
        ensureSpace(pHeight + 8);
        doc.fillColor(textDarkRgb).font("Helvetica").fontSize(11).text(p, 72, y, { width: pageWidth, lineGap: 4 });
        y += pHeight + 8;
      }

      // Bullets
      if (sec.bullets) {
        for (const b of sec.bullets) {
          const bHeight = doc.heightOfString(b, { width: pageWidth - 16, lineGap: 3 });
          ensureSpace(bHeight + 6);
          doc.fillColor(primaryRgb).circle(78, y + 6, 2.5).fill();
          doc.fillColor(textDarkRgb).font("Helvetica").fontSize(10).text(b, 88, y, { width: pageWidth - 16, lineGap: 3 });
          y += bHeight + 6;
        }
        y += 8;
      }

      // Table
      if (sec.table && sec.table.headers.length > 0) {
        ensureSpace(60);
        const colCount = sec.table.headers.length;
        const colW = pageWidth / colCount;

        // Table Header
        doc.fillColor(primaryRgb).rect(72, y, pageWidth, 22).fill();
        doc.fillColor([255, 255, 255]).font("Helvetica-Bold").fontSize(10);
        for (let colIdx = 0; colIdx < colCount; colIdx++) {
          doc.text(sec.table.headers[colIdx], 72 + colIdx * colW + 4, y + 6, { width: colW - 8 });
        }
        y += 22;

        // Table Rows
        doc.font("Helvetica").fontSize(9);
        for (let rIdx = 0; rIdx < (sec.table.rows || []).length; rIdx++) {
          ensureSpace(20);
          const row = sec.table.rows[rIdx];
          const isEven = rIdx % 2 === 0;
          doc.fillColor(isEven ? [255, 255, 255] : cardBgRgb).rect(72, y, pageWidth, 18).fill();
          doc.fillColor(textDarkRgb);
          for (let colIdx = 0; colIdx < colCount; colIdx++) {
            doc.text(row[colIdx] || "", 72 + colIdx * colW + 4, y + 4, { width: colW - 8 });
          }
          y += 18;
        }
        y += 14;
      }

      // Embedded Image
      if (sec.image?.path && existsSync(sec.image.path)) {
        try {
          ensureSpace(200);
          doc.image(sec.image.path, 72, y, { width: Math.min(pageWidth, 400), fit: [pageWidth, 240], align: "center" });
          y += 250;
        } catch {
          /* ignore broken image */
        }
      }

      y += 14;
    }

    // Page Numbers on all pages
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc.fillColor(textMutedRgb).font("Helvetica").fontSize(9).text(
        `HermOS Office Studio  •  Page ${i + 1} of ${range.count}`,
        72,
        doc.page.height - 45,
        { width: pageWidth, align: "right" }
      );
    }

    doc.end();
  });
}

/** Best-effort text extraction from .docx, .pptx, and .pdf documents (capped at 50KB). */
export async function extractOfficeText(
  absPath: string,
): Promise<{ path: string; type: "docx" | "pptx" | "pdf" | "unknown"; text: string }> {
  const ext = path.extname(absPath).toLowerCase();
  try {
    if (ext === ".docx") {
      const text = await extractFromDocx(absPath);
      return { path: absPath, type: "docx", text: capText(text) };
    }
    if (ext === ".pptx") {
      const text = await extractFromPptx(absPath);
      return { path: absPath, type: "pptx", text: capText(text) };
    }
    if (ext === ".pdf") {
      const text = await extractFromPdf(absPath);
      return { path: absPath, type: "pdf", text: capText(text) };
    }
  } catch {
    /* fall through */
  }
  return {
    path: absPath,
    type: "unknown",
    text: "(binary file — open in the file editor)",
  };
}

function capText(s: string, max = 50_000): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "\n…[content truncated]";
}

async function extractFromDocx(absPath: string): Promise<string> {
  const buf = await fs.readFile(absPath);
  const nameBuf = Buffer.from("word/document.xml", "utf8");
  const idx = buf.indexOf(nameBuf);
  if (idx < 0) return "";
  const headerStart = idx - 30;
  if (headerStart < 0 || buf.readUInt32LE(headerStart) !== 0x04034b50) return "";
  const compressionMethod = buf.readUInt16LE(headerStart + 8);
  const nameLen = buf.readUInt16LE(headerStart + 26);
  const extraLen = buf.readUInt16LE(headerStart + 28);
  const dataStart = headerStart + 30 + nameLen + extraLen;
  if (dataStart >= buf.length) return "";

  let xmlText: string;
  if (compressionMethod === 0) {
    xmlText = buf.slice(dataStart).toString("utf8");
  } else if (compressionMethod === 8) {
    const { inflateRawSync } = await import("node:zlib");
    try {
      const inflated = inflateRawSync(buf.slice(dataStart));
      xmlText = inflated.toString("utf8");
    } catch {
      return "";
    }
  } else {
    return "";
  }

  const out: string[] = [];
  const tokenRe = /<w:t[^>]*>([\s\S]*?)<\/w:t>|<\/w:p>/g;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(xmlText)) !== null) {
    if (m[0] === "</w:p>") {
      out.push("\n");
    } else if (m[1] !== undefined) {
      out.push(decodeXmlEntities(m[1]));
    }
  }
  return out.join("");
}

async function extractFromPptx(absPath: string): Promise<string> {
  const buf = await fs.readFile(absPath);
  const parts: string[] = [];
  const sigBuf = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

  let cursor = 0;
  while (cursor < buf.length - 4) {
    const sigIdx = buf.indexOf(sigBuf, cursor);
    if (sigIdx < 0) break;
    const nameLen = buf.readUInt16LE(sigIdx + 26);
    const extraLen = buf.readUInt16LE(sigIdx + 28);
    const nameStart = sigIdx + 30;
    const nameEnd = nameStart + nameLen;
    if (nameEnd > buf.length) break;
    const name = buf.slice(nameStart, nameEnd).toString("utf8");
    const dataStart = nameEnd + extraLen;
    if (dataStart >= buf.length) break;
    if (/^ppt\/slides\/slide\d+\.xml$/.test(name)) {
      const compressionMethod = buf.readUInt16LE(sigIdx + 8);
      let xml = "";
      if (compressionMethod === 0) {
        xml = buf.slice(dataStart).toString("utf8");
      } else if (compressionMethod === 8) {
        const { inflateRawSync } = await import("node:zlib");
        try {
          xml = inflateRawSync(buf.slice(dataStart)).toString("utf8");
        } catch {
          xml = "";
        }
      }
      if (xml) {
        const slideNum = (name.match(/slide(\d+)\.xml$/) || [])[1] || "?";
        const textRuns: string[] = [];
        const tRe = /<a:t>([\s\S]*?)<\/a:t>/g;
        let m: RegExpExecArray | null;
        while ((m = tRe.exec(xml)) !== null) {
          textRuns.push(decodeXmlEntities(m[1]));
        }
        if (textRuns.length > 0) {
          parts.push(`--- Slide ${slideNum} ---\n${textRuns.join(" ")}`);
        }
      }
    }
    cursor = dataStart;
  }
  return parts.join("\n\n");
}

async function extractFromPdf(absPath: string): Promise<string> {
  const buf = await fs.readFile(absPath);
  const blocks: string[] = [];
  const streamRe = /stream\r?\n([\s\S]*?)endstream/g;
  const { inflateRawSync, inflateSync } = await import("node:zlib");
  let m: RegExpExecArray | null;
  while ((m = streamRe.exec(buf.toString("latin1"))) !== null) {
    const raw = m[1];
    let inflated: string | null = null;
    try {
      inflated = inflateSync(Buffer.from(raw, "latin1")).toString("latin1");
    } catch {
      try {
        inflated = inflateRawSync(Buffer.from(raw, "latin1")).toString("latin1");
      } catch {
        inflated = null;
      }
    }
    if (!inflated) continue;

    const btChunks = inflated.split(/\bET\b/);
    for (const chunk of btChunks) {
      const parts: string[] = [];
      const parenRe = /\(([^()\\]*)\)/g;
      let pm: RegExpExecArray | null;
      while ((pm = parenRe.exec(chunk)) !== null) {
        const t = pm[1];
        if (t && /[^\s]/.test(t)) {
          parts.push(decodePdfString(t));
        }
      }

      const hexRe = /<([0-9A-Fa-f\s]+)>/g;
      let hm: RegExpExecArray | null;
      while ((hm = hexRe.exec(chunk)) !== null) {
        const hex = hm[1].replace(/\s+/g, "");
        if (hex.length < 2) continue;
        const bytes: number[] = [];
        for (let i = 0; i + 1 < hex.length; i += 2) {
          bytes.push(parseInt(hex.slice(i, i + 2), 16));
        }
        const t = Buffer.from(bytes).toString("latin1");
        if (t && /[^\s]/.test(t)) {
          parts.push(t);
        }
      }

      if (parts.length > 0) {
        blocks.push(parts.join(""));
      }
    }
  }
  return blocks.join(" ").replace(/\s+/g, " ").trim();
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function decodePdfString(s: string): string {
  return s
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\\(/g, "(")
    .replace(/\\\)/g, ")")
    .replace(/\\\\/g, "\\");
}
