/**
 * Core types for HermOS Office Studio (.pptx, .docx, .pdf).
 * Supports rich layouts, executive themes, embedded images, KPI cards, and tables.
 */

export type OfficeDocType = "presentation" | "document" | "pdf";

export type OfficeThemeId =
  | "executive"
  | "emerald"
  | "charcoal"
  | "crimson"
  | "nordic"
  | "cyberpunk"
  // Legacy aliases
  | "professional"
  | "modern"
  | "minimal";

export type SlideLayout =
  | "title"
  | "bullets"
  | "cards"
  | "split"
  | "image_split"
  | "table"
  | "timeline"
  | "quote";

export interface SlideCard {
  title: string;
  description: string;
  value?: string;
  badge?: string;
  icon?: string;
}

export interface SlideColumn {
  heading: string;
  bullets: string[];
}

export interface SlideTable {
  headers: string[];
  rows: string[][];
}

export interface SlideStep {
  step: string;
  title: string;
  description: string;
}

export interface SlideQuote {
  text: string;
  author?: string;
  role?: string;
}

export interface SlideImage {
  path: string;
  alt?: string;
  caption?: string;
  position?: "left" | "right" | "hero";
}

export interface PptSlide {
  id?: string;
  title: string;
  subtitle?: string;
  layout?: SlideLayout;
  bullets?: string[];
  cards?: SlideCard[];
  columns?: SlideColumn[];
  image?: SlideImage;
  table?: SlideTable;
  steps?: SlideStep[];
  quote?: SlideQuote;
  notes?: string;
  accentColor?: string;
}

export interface DocCallout {
  type?: "info" | "tip" | "warning" | "quote";
  title?: string;
  text: string;
}

export interface DocMetric {
  label: string;
  value: string;
  change?: string;
}

export interface DocSection {
  id?: string;
  heading: string;
  subheading?: string;
  paragraphs?: string[];
  bullets?: string[];
  callout?: DocCallout;
  table?: SlideTable;
  metrics?: DocMetric[];
  image?: SlideImage;
}

export type PdfSection = DocSection;

export interface DocCoverPage {
  title: string;
  subtitle?: string;
  author?: string;
  organization?: string;
  date?: string;
  abstract?: string;
}

export interface OfficeDocManifest {
  version: 1;
  path: string;
  type: OfficeDocType;
  title: string;
  subtitle?: string;
  theme: OfficeThemeId;
  author?: string;
  organization?: string;
  coverPage?: DocCoverPage;
  slides?: PptSlide[];
  sections?: DocSection[];
  updatedAt: number;
}
