/**
 * Color theme and appearance engine for HermOS IDE.
 * Supports granular custom themes, Antigravity-style presets,
 * background / foreground / accent customization, and conversation width.
 */

export type ConversationWidth = "default" | "narrow" | "wide";

export interface ThemeColorConfig {
  preset: string;
  background: string;
  foreground: string;
  accent: string;
}

export interface ColorPreset {
  id: string;
  name: string;
  background: string;
  foreground: string;
  accent: string;
}

export const DEFAULT_LIGHT_THEME: ThemeColorConfig = {
  preset: "default-light",
  background: "#FFFFFF",
  foreground: "#18181B",
  accent: "#10B981",
};

export const DEFAULT_DARK_THEME: ThemeColorConfig = {
  preset: "default-dark",
  background: "#121214",
  foreground: "#F4F4F5",
  accent: "#10B981",
};

export const LIGHT_PRESETS: ColorPreset[] = [
  {
    id: "default-light",
    name: "Default Light",
    background: "#FFFFFF",
    foreground: "#18181B",
    accent: "#10B981",
  },
  {
    id: "antigravity-light",
    name: "Antigravity Light",
    background: "#F9F9F9",
    foreground: "#060A0E",
    accent: "#CC7800",
  },
  {
    id: "github-light",
    name: "GitHub Light",
    background: "#FFFFFF",
    foreground: "#1F2328",
    accent: "#0969DA",
  },
  {
    id: "solarized-light",
    name: "Solarized Light",
    background: "#FDF6E3",
    foreground: "#586E75",
    accent: "#268BD2",
  },
  {
    id: "clean-paper",
    name: "Clean Paper",
    background: "#F8FAFC",
    foreground: "#0F172A",
    accent: "#6366F1",
  },
  {
    id: "rose-pine-dawn",
    name: "Rosé Pine Dawn",
    background: "#FAF4ED",
    foreground: "#575279",
    accent: "#D7827E",
  },
];

export const DARK_PRESETS: ColorPreset[] = [
  {
    id: "default-dark",
    name: "Default Dark",
    background: "#121214",
    foreground: "#F4F4F5",
    accent: "#10B981",
  },
  {
    id: "antigravity-dark",
    name: "Antigravity Dark",
    background: "#0E140F",
    foreground: "#CCCCCC",
    accent: "#CC7800",
  },
  {
    id: "midnight-blue",
    name: "Midnight Blue",
    background: "#0B0F19",
    foreground: "#E2E8F0",
    accent: "#38BDF8",
  },
  {
    id: "tokyo-night",
    name: "Tokyo Night",
    background: "#1A1B26",
    foreground: "#A9B1D6",
    accent: "#7AA2F7",
  },
  {
    id: "dracula",
    name: "Dracula",
    background: "#282A36",
    foreground: "#F8F8F2",
    accent: "#BD93F9",
  },
  {
    id: "nord",
    name: "Nord",
    background: "#2E3440",
    foreground: "#ECEFF4",
    accent: "#88C0D0",
  },
  {
    id: "monokai-pro",
    name: "Monokai Pro",
    background: "#2D2A2E",
    foreground: "#FCFCFA",
    accent: "#FFD866",
  },
  {
    id: "cyberpunk",
    name: "Cyberpunk",
    background: "#0B0E14",
    foreground: "#E6EDF3",
    accent: "#00FFCC",
  },
];

export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

/** Check if string is a valid 3- or 6-digit hex color */
export function isValidHex(hex: string): boolean {
  return /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(hex.trim());
}

/** Normalize hex to #RRGGBB format in uppercase */
export function normalizeHex(hex: string): string {
  let clean = hex.trim().replace(/^#/, "");
  if (clean.length === 3) {
    clean = clean
      .split("")
      .map((c) => c + c)
      .join("");
  }
  return `#${clean.toUpperCase()}`;
}

/** Convert hex string to RGB components */
export function hexToRgb(hex: string): RgbColor | null {
  if (!isValidHex(hex)) return null;
  const clean = normalizeHex(hex).replace(/^#/, "");
  const num = parseInt(clean, 16);
  return {
    r: (num >> 16) & 255,
    g: (num >> 8) & 255,
    b: num & 255,
  };
}

/** Convert RGB components to hex string */
export function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (val: number) => Math.max(0, Math.min(255, Math.round(val)));
  return `#${[clamp(r), clamp(g), clamp(b)]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase()}`;
}

/** Linearly blend two hex colors by ratio (0 = color1, 1 = color2) */
export function blendColors(color1: string, color2: string, ratio: number): string {
  const rgb1 = hexToRgb(color1) ?? { r: 0, g: 0, b: 0 };
  const rgb2 = hexToRgb(color2) ?? { r: 255, g: 255, b: 255 };
  const r = rgb1.r + (rgb2.r - rgb1.r) * ratio;
  const g = rgb1.g + (rgb2.g - rgb1.g) * ratio;
  const b = rgb1.b + (rgb2.b - rgb1.b) * ratio;
  return rgbToHex(r, g, b);
}

/** Calculate WCAG relative luminance */
export function getLuminance(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0.5;
  const a = [rgb.r, rgb.g, rgb.b].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return a[0] * 0.2126 + a[1] * 0.7152 + a[2] * 0.0722;
}

/** Choose optimal contrast foreground text (#000000 or #FFFFFF) for given background */
export function getContrastForeground(hex: string): string {
  const lum = getLuminance(hex);
  return lum > 0.4 ? "#09090B" : "#FFFFFF";
}

/**
 * Derives comprehensive UI palette from base background, foreground, and accent.
 */
export function deriveSurfaceColors(
  isDark: boolean,
  bg: string,
  fg: string,
  accent: string,
) {
  const safeBg = isValidHex(bg) ? normalizeHex(bg) : isDark ? "#121214" : "#FFFFFF";
  const safeFg = isValidHex(fg) ? normalizeHex(fg) : isDark ? "#F4F4F5" : "#18181B";
  const safeAccent = isValidHex(accent) ? normalizeHex(accent) : "#10B981";

  if (isDark) {
    // Dark mode surfaces
    const card = blendColors(safeBg, "#FFFFFF", 0.05);
    const popover = card;
    const sidebar = blendColors(safeBg, "#FFFFFF", 0.025);
    const muted = blendColors(safeBg, "#FFFFFF", 0.08);
    const mutedFg = blendColors(safeFg, safeBg, 0.45);
    const border = blendColors(safeBg, safeFg, 0.14);
    const input = blendColors(safeBg, safeFg, 0.18);
    const secondary = muted;
    const secondaryFg = safeFg;
    const brandFg = getContrastForeground(safeAccent);

    return {
      background: safeBg,
      foreground: safeFg,
      card,
      cardForeground: safeFg,
      popover,
      popoverForeground: safeFg,
      sidebar,
      sidebarForeground: safeFg,
      sidebarBorder: border,
      sidebarRing: safeAccent,
      sidebarAccent: blendColors(safeBg, "#FFFFFF", 0.06),
      sidebarAccentForeground: safeFg,
      sidebarPrimary: safeAccent,
      sidebarPrimaryForeground: brandFg,
      muted,
      mutedForeground: mutedFg,
      border,
      input,
      ring: safeAccent,
      brand: safeAccent,
      brandForeground: brandFg,
      primary: safeFg,
      primaryForeground: safeBg,
      secondary,
      secondaryForeground: secondaryFg,
      accent: blendColors(safeBg, "#FFFFFF", 0.1),
      accentForeground: safeFg,
    };
  } else {
    // Light mode surfaces
    const card = blendColors(safeBg, "#FFFFFF", 0.5);
    const popover = card;
    const sidebar = blendColors(safeBg, "#000000", 0.025);
    const muted = blendColors(safeBg, "#000000", 0.05);
    const mutedFg = blendColors(safeFg, safeBg, 0.45);
    const border = blendColors(safeBg, safeFg, 0.12);
    const input = blendColors(safeBg, safeFg, 0.16);
    const secondary = muted;
    const secondaryFg = safeFg;
    const brandFg = getContrastForeground(safeAccent);

    return {
      background: safeBg,
      foreground: safeFg,
      card,
      cardForeground: safeFg,
      popover,
      popoverForeground: safeFg,
      sidebar,
      sidebarForeground: safeFg,
      sidebarBorder: border,
      sidebarRing: safeAccent,
      sidebarAccent: blendColors(safeBg, "#000000", 0.04),
      sidebarAccentForeground: safeFg,
      sidebarPrimary: safeAccent,
      sidebarPrimaryForeground: brandFg,
      muted,
      mutedForeground: mutedFg,
      border,
      input,
      ring: safeAccent,
      brand: safeAccent,
      brandForeground: brandFg,
      primary: safeFg,
      primaryForeground: safeBg,
      secondary,
      secondaryForeground: secondaryFg,
      accent: blendColors(safeBg, "#000000", 0.06),
      accentForeground: safeFg,
    };
  }
}

const CUSTOM_PROP_KEYS = [
  "--background",
  "--foreground",
  "--card",
  "--card-foreground",
  "--popover",
  "--popover-foreground",
  "--sidebar",
  "--sidebar-foreground",
  "--sidebar-border",
  "--sidebar-ring",
  "--sidebar-accent",
  "--sidebar-accent-foreground",
  "--sidebar-primary",
  "--sidebar-primary-foreground",
  "--muted",
  "--muted-foreground",
  "--border",
  "--input",
  "--ring",
  "--brand",
  "--brand-foreground",
  "--primary",
  "--primary-foreground",
  "--secondary",
  "--secondary-foreground",
  "--accent",
  "--accent-foreground",
] as const;

/**
 * Injects CSS variables directly onto documentElement so all Tailwind utilities react.
 * If default preset without overrides is active, removes inline style overrides so
 * native globals.css OKLCH colors shine through.
 */
export function applyThemeToDocument(
  resolvedTheme: "light" | "dark",
  config: ThemeColorConfig,
) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;

  const isDefault =
    (resolvedTheme === "light" && config.preset === "default-light") ||
    (resolvedTheme === "dark" && config.preset === "default-dark");

  if (isDefault) {
    // Revert to native globals.css variables
    for (const key of CUSTOM_PROP_KEYS) {
      root.style.removeProperty(key);
    }
    return;
  }

  const isDark = resolvedTheme === "dark";
  const palette = deriveSurfaceColors(
    isDark,
    config.background,
    config.foreground,
    config.accent,
  );

  root.style.setProperty("--background", palette.background);
  root.style.setProperty("--foreground", palette.foreground);
  root.style.setProperty("--card", palette.card);
  root.style.setProperty("--card-foreground", palette.cardForeground);
  root.style.setProperty("--popover", palette.popover);
  root.style.setProperty("--popover-foreground", palette.popoverForeground);
  root.style.setProperty("--sidebar", palette.sidebar);
  root.style.setProperty("--sidebar-foreground", palette.sidebarForeground);
  root.style.setProperty("--sidebar-border", palette.sidebarBorder);
  root.style.setProperty("--sidebar-ring", palette.sidebarRing);
  root.style.setProperty("--sidebar-accent", palette.sidebarAccent);
  root.style.setProperty("--sidebar-accent-foreground", palette.sidebarAccentForeground);
  root.style.setProperty("--sidebar-primary", palette.sidebarPrimary);
  root.style.setProperty("--sidebar-primary-foreground", palette.sidebarPrimaryForeground);
  root.style.setProperty("--muted", palette.muted);
  root.style.setProperty("--muted-foreground", palette.mutedForeground);
  root.style.setProperty("--border", palette.border);
  root.style.setProperty("--input", palette.input);
  root.style.setProperty("--ring", palette.ring);
  root.style.setProperty("--brand", palette.brand);
  root.style.setProperty("--brand-foreground", palette.brandForeground);
  root.style.setProperty("--primary", palette.primary);
  root.style.setProperty("--primary-foreground", palette.primaryForeground);
  root.style.setProperty("--secondary", palette.secondary);
  root.style.setProperty("--secondary-foreground", palette.secondaryForeground);
  root.style.setProperty("--accent", palette.accent);
  root.style.setProperty("--accent-foreground", palette.accentForeground);
}

/** Clear all custom variable overrides on documentElement */
export function clearCustomThemeVariables() {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  for (const key of CUSTOM_PROP_KEYS) {
    root.style.removeProperty(key);
  }
}

/** Map ConversationWidth setting to Tailwind max-width class */
export function conversationWidthClass(width: ConversationWidth | undefined): string {
  switch (width) {
    case "narrow":
      return "max-w-2xl";
    case "wide":
      return "max-w-5xl";
    case "default":
    default:
      return "max-w-3xl";
  }
}
