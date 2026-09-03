import { describe, it, expect } from "vitest";
import {
  isValidHex,
  normalizeHex,
  hexToRgb,
  rgbToHex,
  blendColors,
  getLuminance,
  getContrastForeground,
  deriveSurfaceColors,
  conversationWidthClass,
  LIGHT_PRESETS,
  DARK_PRESETS,
  DEFAULT_LIGHT_THEME,
  DEFAULT_DARK_THEME,
} from "./color-theme";

describe("color-theme: hex parsing & normalization", () => {
  it("validates 3-digit and 6-digit hex strings", () => {
    expect(isValidHex("#FFF")).toBe(true);
    expect(isValidHex("FFF")).toBe(true);
    expect(isValidHex("#10B981")).toBe(true);
    expect(isValidHex("10b981")).toBe(true);
    expect(isValidHex("#CC7800")).toBe(true);
    expect(isValidHex("#0E140F")).toBe(true);

    expect(isValidHex("")).toBe(false);
    expect(isValidHex("12")).toBe(false);
    expect(isValidHex("#12345")).toBe(false);
    expect(isValidHex("#GGGGGG")).toBe(false);
  });

  it("normalizes 3-digit to 6-digit uppercase hex", () => {
    expect(normalizeHex("#fff")).toBe("#FFFFFF");
    expect(normalizeHex("abc")).toBe("#AABBCC");
    expect(normalizeHex("#10b981")).toBe("#10B981");
  });

  it("converts hex to RGB and back", () => {
    const rgb = hexToRgb("#10B981");
    expect(rgb).toEqual({ r: 16, g: 185, b: 129 });
    expect(rgbToHex(16, 185, 129)).toBe("#10B981");
  });

  it("blends colors smoothly", () => {
    const blended = blendColors("#000000", "#FFFFFF", 0.5);
    expect(blended).toBe("#808080");
  });
});

describe("color-theme: luminance and contrast", () => {
  it("computes luminance accurately", () => {
    const lumWhite = getLuminance("#FFFFFF");
    const lumBlack = getLuminance("#000000");
    expect(lumWhite).toBeCloseTo(1.0, 2);
    expect(lumBlack).toBeCloseTo(0.0, 2);
  });

  it("chooses optimal text contrast foreground for accent", () => {
    // Dark amber / orange (#CC7800) has moderate luminance -> white text for high contrast
    expect(getContrastForeground("#CC7800")).toBe("#FFFFFF");
    // Bright yellow (#FFEB3B) -> dark text
    expect(getContrastForeground("#FFEB3B")).toBe("#09090B");
    // Emerald green (#10B981) -> white text
    expect(getContrastForeground("#10B981")).toBe("#FFFFFF");
    // Deep dark background -> white text
    expect(getContrastForeground("#0E140F")).toBe("#FFFFFF");
  });
});

describe("color-theme: surface derivation", () => {
  it("derives consistent dark mode surfaces", () => {
    const palette = deriveSurfaceColors(true, "#0E140F", "#CCCCCC", "#CC7800");
    expect(palette.background).toBe("#0E140F");
    expect(palette.foreground).toBe("#CCCCCC");
    expect(palette.brand).toBe("#CC7800");
    expect(palette.ring).toBe("#CC7800");
    expect(palette.card).toBeDefined();
    expect(palette.sidebar).toBeDefined();
    expect(palette.border).toBeDefined();
    expect(palette.muted).toBeDefined();
  });

  it("derives consistent light mode surfaces", () => {
    const palette = deriveSurfaceColors(false, "#F9F9F9", "#060A0E", "#CC7800");
    expect(palette.background).toBe("#F9F9F9");
    expect(palette.foreground).toBe("#060A0E");
    expect(palette.brand).toBe("#CC7800");
    expect(palette.card).toBeDefined();
    expect(palette.sidebar).toBeDefined();
    expect(palette.border).toBeDefined();
  });
});

describe("color-theme: presets and width mapping", () => {
  it("contains required light and dark presets", () => {
    expect(LIGHT_PRESETS.some((p) => p.id === "default-light")).toBe(true);
    expect(LIGHT_PRESETS.some((p) => p.id === "antigravity-light")).toBe(true);
    expect(DARK_PRESETS.some((p) => p.id === "default-dark")).toBe(true);
    expect(DARK_PRESETS.some((p) => p.id === "antigravity-dark")).toBe(true);
    expect(DARK_PRESETS.some((p) => p.id === "dracula")).toBe(true);
  });

  it("maps conversation widths to proper CSS classes", () => {
    expect(conversationWidthClass("default")).toBe("max-w-3xl");
    expect(conversationWidthClass("narrow")).toBe("max-w-2xl");
    expect(conversationWidthClass("wide")).toBe("max-w-5xl");
    expect(conversationWidthClass(undefined)).toBe("max-w-3xl");
  });

  it("preserves HermOS defaults as default and keeps Antigravity as separate selectable presets", () => {
    // HermOS defaults must be emerald mint #10B981
    expect(DEFAULT_LIGHT_THEME.preset).toBe("default-light");
    expect(DEFAULT_LIGHT_THEME.accent).toBe("#10B981");

    expect(DEFAULT_DARK_THEME.preset).toBe("default-dark");
    expect(DEFAULT_DARK_THEME.accent).toBe("#10B981");

    // Antigravity presets exist for user choice, but do not override the default
    const agLight = LIGHT_PRESETS.find((p) => p.id === "antigravity-light");
    expect(agLight).toBeDefined();
    expect(agLight?.accent).toBe("#CC7800");

    const agDark = DARK_PRESETS.find((p) => p.id === "antigravity-dark");
    expect(agDark).toBeDefined();
    expect(agDark?.accent).toBe("#CC7800");
  });
});
