/**
 * Executive Theme Palettes for HermOS Office Studio.
 * Designed for high-contrast presentation decks, corporate documents, and reports.
 */

import type { OfficeThemeId } from "./types";

export interface OfficeThemePalette {
  id: OfficeThemeId;
  name: string;
  description: string;
  primary: string;       // 6-digit hex without #
  primaryDark: string;   // 6-digit hex without #
  secondary: string;     // 6-digit hex without #
  accent: string;        // 6-digit hex without #
  bg: string;            // 6-digit hex without #
  cardBg: string;        // 6-digit hex without #
  textDark: string;      // 6-digit hex without #
  textMuted: string;     // 6-digit hex without #
  border: string;        // 6-digit hex without #
  tagBg: string;         // 6-digit hex without #
  isDarkTheme?: boolean;
}

export const OFFICE_THEMES: Record<string, OfficeThemePalette> = {
  executive: {
    id: "executive",
    name: "Executive Navy",
    description: "Corporate deep navy, royal blue, and sky accents.",
    primary: "1E3A8A",
    primaryDark: "0F172A",
    secondary: "2563EB",
    accent: "38BDF8",
    bg: "FFFFFF",
    cardBg: "F8FAFC",
    textDark: "0F172A",
    textMuted: "64748B",
    border: "E2E8F0",
    tagBg: "EFF6FF",
  },
  emerald: {
    id: "emerald",
    name: "HermOS Emerald",
    description: "Signature mint, deep forest green, and modern slate.",
    primary: "10B981",
    primaryDark: "064E3B",
    secondary: "047857",
    accent: "34D399",
    bg: "FFFFFF",
    cardBg: "F0FDF4",
    textDark: "064E3B",
    textMuted: "6B7280",
    border: "A7F3D0",
    tagBg: "ECFDF5",
  },
  charcoal: {
    id: "charcoal",
    name: "Charcoal & Gold",
    description: "Executive anthracite, platinum, and warm amber gold.",
    primary: "18181B",
    primaryDark: "09090B",
    secondary: "27272A",
    accent: "F59E0B",
    bg: "FFFFFF",
    cardBg: "FAFAFA",
    textDark: "18181B",
    textMuted: "71717A",
    border: "E4E4E7",
    tagBg: "FEF3C7",
  },
  crimson: {
    id: "crimson",
    name: "Modern Crimson",
    description: "Deep burgundy, vibrant ruby rose, and crisp white.",
    primary: "881337",
    primaryDark: "4C0519",
    secondary: "E11D48",
    accent: "FB7185",
    bg: "FFFFFF",
    cardBg: "FFF1F2",
    textDark: "1C1917",
    textMuted: "78716C",
    border: "FECDD3",
    tagBg: "FFE4E6",
  },
  nordic: {
    id: "nordic",
    name: "Nordic Frost",
    description: "Scandinavian slate, polar cyan, and arctic blue.",
    primary: "2E3440",
    primaryDark: "1E232A",
    secondary: "5E81AC",
    accent: "88C0D0",
    bg: "FFFFFF",
    cardBg: "ECEFF4",
    textDark: "2E3440",
    textMuted: "4C566A",
    border: "D8DEE9",
    tagBg: "E5E9F0",
  },
  cyberpunk: {
    id: "cyberpunk",
    name: "Cyber Midnight",
    description: "High-tech dark midnight, electric violet, and bright cyan.",
    primary: "7C3AED",
    primaryDark: "4C1D95",
    secondary: "8B5CF6",
    accent: "06B6D4",
    bg: "0F172A",
    cardBg: "1E293B",
    textDark: "F8FAFC",
    textMuted: "94A3B8",
    border: "334155",
    tagBg: "2E1065",
    isDarkTheme: true,
  },
};

export const DEFAULT_OFFICE_THEME: OfficeThemePalette = OFFICE_THEMES.executive;

export function resolveOfficeTheme(themeId?: string): OfficeThemePalette {
  if (!themeId) return DEFAULT_OFFICE_THEME;
  const normalized = themeId.toLowerCase().trim();

  // Backward-compatible alias mapping
  if (normalized === "professional") return OFFICE_THEMES.executive;
  if (normalized === "modern") return OFFICE_THEMES.emerald;
  if (normalized === "minimal") return OFFICE_THEMES.charcoal;

  return OFFICE_THEMES[normalized] || DEFAULT_OFFICE_THEME;
}

/** Hex to RGB helper for pdfkit (accepts with or without #) */
export function hexToRgbTuple(hex: string): [number, number, number] {
  const clean = hex.replace("#", "");
  const num = parseInt(clean, 16);
  if (isNaN(num)) return [30, 58, 138];
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}
