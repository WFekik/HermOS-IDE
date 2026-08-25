import path from "path";
import fs from "fs/promises";
import { createWriteStream } from "fs";
import { safePath } from "@/lib/workspace";

// Lazy dynamic imports for heavy document generation libraries.
// These are only loaded when actually needed, avoiding startup bundle bloat.
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

/**
 * Office document generation (.pptx, .docx, .pdf) using pptxgenjs, docx, and pdfkit.
 * Validates paths via `safePath` and enforces caps on slide and section counts.
 */

/** Emerald accent (matches the workspace brand color). Hex `#10b981`. */
const EMERALD = "10B981";
const EMERALD_DARK = "047857";
const TEXT_DARK = "1F2937";
const TEXT_MUTED = "6B7280";
const PAGE_BG = "FFFFFF";

/** Hard cap on slide / section counts to keep generation bounded. */
export const MAX_SLIDES = 200;
export const MAX_SECTIONS = 200;
/** Cap on per-bullet / per-paragraph text length. */
const MAX_BULLET_LEN = 1000;
const MAX_PARA_LEN = 8000;
/** Cap on the title text length. */
const MAX_TITLE_LEN = 200;
/** Cap on per-heading text length. */
const MAX_HEADING_LEN = 200;

export type PptTheme = "professional" | "modern" | "minimal";

export interface PptSlide {
  title: string;
  bullets: string[];
  notes?: string;
}

export interface DocSection {
  heading: string;
  paragraphs: string[];
}

export interface PdfSection {
  heading: string;
  paragraphs: string[];
}

export interface GeneratePptOpts {
  title: string;
  slides: PptSlide[];
  theme?: PptTheme;
  /** Absolute path inside the workspace where the .pptx will be written. */
  outputPath: string;
}

export interface GenerateDocOpts {
  title: string;
  sections: DocSection[];
  /** Absolute path inside the workspace where the .docx will be written. */
  outputPath: string;
}

export interface GeneratePdfOpts {
  title: string;
  sections: PdfSection[];
  /** Absolute path inside the workspace where the .pdf will be written. */
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

function clip(s: string, max: number): string {
  if (typeof s !== "string") return "";
  if (s.length <= max) return s;
  return s.slice(0, max) + "…";
}

function cleanSlides(slides: PptSlide[]): PptSlide[] {
  return slides.slice(0, MAX_SLIDES).map((s) => ({
    title: clip(String(s.title || "").trim(), MAX_TITLE_LEN) || "Untitled slide",
    bullets: Array.isArray(s.bullets)
      ? s.bullets
          .map((b) => clip(String(b || "").trim(), MAX_BULLET_LEN))
          .filter((b) => b.length > 0)
          .slice(0, 30)
      : [],
    notes: s.notes ? clip(String(s.notes), MAX_PARA_LEN) : undefined,
  }));
}

function cleanSections(sections: DocSection[]): DocSection[] {
  return sections.slice(0, MAX_SECTIONS).map((sec) => ({
    heading: clip(String(sec.heading || "").trim(), MAX_HEADING_LEN) || "Untitled section",
    paragraphs: Array.isArray(sec.paragraphs)
      ? sec.paragraphs
          .map((p) => clip(String(p || "").trim(), MAX_PARA_LEN))
          .filter((p) => p.length > 0)
          .slice(0, 50)
      : [],
  }));
}

/**
 * Generate a styled .pptx presentation at outputPath supporting themes and speaker notes.
 * Returns written file path and content slide count.
 */
export async function generatePpt(
  opts: GeneratePptOpts,
): Promise<{ path: string; slides: number }> {
  const title = clip(String(opts.title || "Untitled").trim(), MAX_TITLE_LEN);
  const slides = cleanSlides(opts.slides || []);
  const theme: PptTheme =
    opts.theme === "modern" || opts.theme === "minimal" ? opts.theme : "professional";

  const PptxGenJS = await loadPptxGenJS();
  const pptx = new PptxGenJS();
  pptx.author = "HermOS";
  pptx.company = "HermOS";
  pptx.subject = title;
  pptx.title = title;

  const accent = theme === "minimal" ? TEXT_DARK : EMERALD;
  const bg = theme === "modern" ? "F9FAFB" : PAGE_BG;

  const titleSlide = pptx.addSlide();
  titleSlide.background = { color: bg };
  if (theme !== "minimal") {
    // Emerald banner across the top of the title slide.
    titleSlide.addShape("rect", {
      x: 0,
      y: 0,
      w: "100%",
      h: 1.4,
      fill: { color: accent },
      line: { color: accent, width: 0 },
    });
  }
  titleSlide.addText(title, {
    x: 0.5,
    y: theme === "minimal" ? 1.5 : 1.7,
    w: "90%",
    h: 2.0,
    align: "center",
    bold: true,
    color: TEXT_DARK,
    fontSize: theme === "minimal" ? 32 : 40,
    fontFace: "Calibri",
  });
  const subtitle = `${slides.length} slide${slides.length === 1 ? "" : "s"} • Generated by HermOS`;
  titleSlide.addText(subtitle, {
    x: 0.5,
    y: theme === "minimal" ? 3.2 : 3.6,
    w: "90%",
    h: 0.6,
    align: "center",
    color: TEXT_MUTED,
    fontSize: 16,
    italic: true,
    fontFace: "Calibri",
  });

  for (const slide of slides) {
    const s = pptx.addSlide();
    s.background = { color: PAGE_BG };

    // Thin accent bar at the top of each content slide.
    s.addShape("rect", {
      x: 0,
      y: 0,
      w: "100%",
      h: 0.18,
      fill: { color: accent },
      line: { color: accent, width: 0 },
    });

    s.addText(slide.title, {
      x: 0.5,
      y: 0.4,
      w: "90%",
      h: 0.8,
      bold: true,
      color: TEXT_DARK,
      fontSize: 26,
      fontFace: "Calibri",
    });

    // Bullets. We pass an array of TextProps so each bullet carries its own
    // `bullet: true` + `breakLine: true` styling.
    if (slide.bullets.length > 0) {
      const bulletItems = slide.bullets.map((b) => ({
        text: b,
        options: {
          bullet: true,
          color: TEXT_DARK,
          fontSize: 18,
          fontFace: "Calibri",
          breakLine: true,
        },
      }));
      s.addText(bulletItems, {
        x: 0.6,
        y: 1.4,
        w: "90%",
        h: 4.6,
        valign: "top",
        color: TEXT_DARK,
      });
    } else {
      s.addText("(no bullet points)", {
        x: 0.6,
        y: 1.4,
        w: "90%",
        h: 0.5,
        color: TEXT_MUTED,
        italic: true,
        fontSize: 14,
      });
    }

    if (slide.notes) {
      s.addNotes(slide.notes);
    }
  }

  // Write the .pptx binary to outputPath. `outputType: 'nodebuffer'` returns
  // a Node Buffer we can write directly with fs.promises.writeFile.
  const out = (await pptx.write({ outputType: "nodebuffer" })) as Buffer;
  await fs.writeFile(opts.outputPath, out);
  return { path: opts.outputPath, slides: slides.length };
}

/** Generate formatted .docx document at outputPath with heading hierarchy and body paragraphs. */
export async function generateDoc(
  opts: GenerateDocOpts,
): Promise<{ path: string; sections: number }> {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } = await loadDocx();
  const title = clip(String(opts.title || "Untitled").trim(), MAX_TITLE_LEN);
  const sections = cleanSections(opts.sections || []);

  const children: any[] = [];

  children.push(
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({
          text: title,
          bold: true,
          size: 36, // half-points → 18pt
          color: TEXT_DARK,
        }),
      ],
      spacing: { after: 240 },
    }),
  );

  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({
          text: `Generated by HermOS • ${sections.length} section${sections.length === 1 ? "" : "s"}`,
          italics: true,
          color: TEXT_MUTED,
          size: 20, // 10pt
        }),
      ],
      spacing: { after: 480 },
    }),
  );

  for (const sec of sections) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        children: [
          new TextRun({
            text: sec.heading,
            bold: true,
            size: 28, // 14pt
            color: EMERALD_DARK,
          }),
        ],
        spacing: { before: 320, after: 120 },
      }),
    );
    for (const para of sec.paragraphs) {
      children.push(
        new Paragraph({
          children: [
            new TextRun({
              text: para,
              size: 22, // 11pt
              color: TEXT_DARK,
            }),
          ],
          spacing: { after: 160, line: 276 }, // 1.15 line spacing (240 = 1.0)
        }),
      );
    }
  }

  const doc = new Document({
    creator: "HermOS",
    title,
    description: title,
    sections: [
      {
        properties: {
          page: { margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } },
        },
        children,
      },
    ],
  });

  const buffer = await Packer.toBuffer(doc);
  await fs.writeFile(opts.outputPath, buffer);
  return { path: opts.outputPath, sections: sections.length };
}

/** Generate styled .pdf document at outputPath via PDFKit write stream. */
export async function generatePdf(
  opts: GeneratePdfOpts,
): Promise<{ path: string; sections: number }> {
  const PDFDocument = await loadPDFKit();
  const title = clip(String(opts.title || "Untitled").trim(), MAX_TITLE_LEN);
  const sections = cleanSections(opts.sections || []);

  return new Promise<{ path: string; sections: number }>((resolve, reject) => {
    const doc = new PDFDocument({
      info: {
        Title: title,
        Author: "HermOS",
        Subject: title,
        Creator: "HermOS",
      },
      size: "LETTER",
      margins: { top: 72, bottom: 72, left: 72, right: 72 },
      bufferPages: false,
    });

    const stream = createWriteStream(opts.outputPath);
    stream.on("error", (err) => {
      try {
        doc.destroy();
      } catch {
        /* ignore */
      }
      reject(new Error(`Failed to write PDF: ${err.message}`));
    });
    stream.on("finish", () => {
      resolve({ path: opts.outputPath, sections: sections.length });
    });

    doc.pipe(stream);

    // Emerald banner rectangle across the top.
    doc
      .fillColor(EMERALD)
      .rect(0, 0, doc.page.width, 120)
      .fill();

    doc
      .fillColor("#FFFFFF")
      .font("Helvetica-Bold")
      .fontSize(28)
      .text(title, 72, 50, {
        width: doc.page.width - 144,
        align: "center",
      });

    doc
      .fillColor(TEXT_MUTED)
      .font("Helvetica-Oblique")
      .fontSize(12)
      .text(
        `Generated by HermOS • ${sections.length} section${sections.length === 1 ? "" : "s"}`,
        72,
        160,
        { width: doc.page.width - 144, align: "center" },
      );

    let y = 220;
    const pageBottom = doc.page.height - 72; // bottom margin
    const pageWidth = doc.page.width - 144; // content width (margins both sides)

    const ensureSpace = (needed: number) => {
      if (y + needed > pageBottom) {
        doc.addPage();
        y = 72;
      }
    };

    for (const sec of sections) {
      doc
        .fillColor(EMERALD_DARK)
        .font("Helvetica-Bold")
        .fontSize(16);
      const headingHeight = doc.heightOfString(sec.heading, {
        width: pageWidth,
      });
      ensureSpace(headingHeight + 16);
      doc
        .fillColor(EMERALD_DARK)
        .font("Helvetica-Bold")
        .fontSize(16)
        .text(sec.heading, 72, y, { width: pageWidth });
      y += headingHeight + 10;

      doc
        .strokeColor(EMERALD)
        .lineWidth(1)
        .moveTo(72, y)
        .lineTo(doc.page.width - 72, y)
        .stroke();
      y += 12;

      for (const para of sec.paragraphs) {
        doc
          .fillColor(TEXT_DARK)
          .font("Helvetica")
          .fontSize(11);
        const paraHeight = doc.heightOfString(para, {
          width: pageWidth,
          lineGap: 4,
        });
        ensureSpace(paraHeight + 12);
        doc
          .fillColor(TEXT_DARK)
          .font("Helvetica")
          .fontSize(11)
          .text(para, 72, y, { width: pageWidth, lineGap: 4 });
        y += paraHeight + 8;
      }
      y += 16; // extra gap between sections
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

/** Extract text from .docx by parsing word/document.xml in local zip container. */
async function extractFromDocx(absPath: string): Promise<string> {
  const buf = await fs.readFile(absPath);
  // Locate the local file header whose name is `word/document.xml`.
  const nameBuf = Buffer.from("word/document.xml", "utf8");
  const idx = buf.indexOf(nameBuf);
  if (idx < 0) return "";
  // The local file header is at idx - 30 (header is 30 bytes + name + extra).
  const headerStart = idx - 30;
  if (headerStart < 0 || buf.readUInt32LE(headerStart) !== 0x04034b50) return "";
  // Compression method is at headerStart + 8 (2 bytes, little-endian).
  const compressionMethod = buf.readUInt16LE(headerStart + 8);
  // Name length at headerStart + 26, extra length at headerStart + 28.
  const nameLen = buf.readUInt16LE(headerStart + 26);
  const extraLen = buf.readUInt16LE(headerStart + 28);
  const dataStart = headerStart + 30 + nameLen + extraLen;
  if (dataStart >= buf.length) return "";

  let xmlText: string;
  if (compressionMethod === 0) {
    // Stored (no compression).
    xmlText = buf.slice(dataStart).toString("utf8");
  } else if (compressionMethod === 8) {
    // Deflate. inflateRaw ignores trailing bytes, so slicing dataStart..end is
    // safe.
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

  // Walk the XML once with a combined regex that matches EITHER a text run
  // (<w:t>…</w:t>) OR a paragraph close (</w:p>). We append text or a newline
  // accordingly. This avoids the lastIndex-bookkeeping bug that two separate
  // global regexes can introduce.
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

/** Extract text from .pptx by reading slide XML entries in local zip container. */
async function extractFromPptx(absPath: string): Promise<string> {
  const buf = await fs.readFile(absPath);
  const parts: string[] = [];
  const sigBuf = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // "PK\x03\x04"

  // Scan for all local file headers (PK\x03\x04) and inspect their names.
  let cursor = 0;
  while (cursor < buf.length - 4) {
    const sigIdx = buf.indexOf(sigBuf, cursor);
    if (sigIdx < 0) break;
    // Local file header: PK\x03\x04 + 26 bytes of fields, then name + extra.
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

/** Extract text from PDF streams by inflating FlateDecode blocks and parsing text operators. */
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

    // Split into BT…ET text blocks. Within each block, concatenate every
    // text operand (paren-quoted or hex-quoted) directly. Between blocks,
    // we insert a space.
    const btChunks = inflated.split(/\bET\b/);
    for (const chunk of btChunks) {
      const parts: string[] = [];

      // Paren-quoted literal strings.
      const parenRe = /\(([^()\\]*)\)/g;
      let pm: RegExpExecArray | null;
      while ((pm = parenRe.exec(chunk)) !== null) {
        const t = pm[1];
        if (t && /[^\s]/.test(t)) {
          parts.push(decodePdfString(t));
        }
      }

      // Hex-quoted strings <...>. PDFKit emits these inside TJ arrays. Each
      // pair of hex digits is one ASCII byte.
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

/** Decode PDF parenthesis-escaped strings (e.g. `\(test\)` → `(test)`). */
function decodePdfString(s: string): string {
  return s
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\\(/g, "(")
    .replace(/\\\)/g, ")")
    .replace(/\\\\/g, "\\");
}
