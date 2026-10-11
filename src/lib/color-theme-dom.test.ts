// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import {
  applyThemeToDocument,
  previewThemeColors,
  clearCustomThemeVariables,
  DEFAULT_DARK_THEME,
  type ThemeColorConfig,
} from "./color-theme";

const CUSTOM_DARK: ThemeColorConfig = {
  preset: "custom",
  background: "#101014",
  foreground: "#F4F4F5",
  accent: "#FF5500",
};

describe("color-theme DOM application (live-drag path)", () => {
  beforeEach(() => {
    clearCustomThemeVariables();
  });

  it("applies derived vars to documentElement", () => {
    applyThemeToDocument("dark", CUSTOM_DARK);
    const root = document.documentElement;
    expect(root.style.getPropertyValue("--background")).toBe("#101014");
    expect(root.style.getPropertyValue("--brand")).toBe("#FF5500");
    expect(root.style.getPropertyValue("--card")).not.toBe("");
  });

  it("reverts to native CSS on the default preset", () => {
    applyThemeToDocument("dark", CUSTOM_DARK);
    expect(document.documentElement.style.getPropertyValue("--brand")).not.toBe("");
    applyThemeToDocument("dark", DEFAULT_DARK_THEME);
    expect(document.documentElement.style.getPropertyValue("--brand")).toBe("");
  });

  it("skips unchanged values (no redundant invalidations on repeat applies)", () => {
    applyThemeToDocument("dark", CUSTOM_DARK);
    const before = document.documentElement.style.cssText;
    applyThemeToDocument("dark", CUSTOM_DARK);
    expect(document.documentElement.style.cssText).toBe(before);
  });

  it("previewThemeColors paints without a store round-trip", () => {
    // Store-free by construction (no store import in color-theme); assert
    // the DOM effect a drag tick relies on.
    previewThemeColors("dark", { ...CUSTOM_DARK, accent: "#00AAFF" });
    expect(document.documentElement.style.getPropertyValue("--brand")).toBe("#00AAFF");
    // Only the accent changed — background must be untouched.
    expect(document.documentElement.style.getPropertyValue("--background")).toBe("#101014");
  });
});
