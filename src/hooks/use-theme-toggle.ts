"use client";

import { useCallback } from "react";
import { useTheme } from "@/components/theme/theme-provider";

export type ThemeMode = "light" | "dark" | "system";

/**
 * Returns the *selected* theme plus a function that cycles
 * light → dark → system → light.
 */
export function useThemeToggle() {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const current = (theme as ThemeMode | undefined) ?? "system";

  const cycle = useCallback(() => {
    const next: ThemeMode = current === "light" ? "dark" : current === "dark" ? "system" : "light";
    setTheme(next);
  }, [current, setTheme]);

  return { theme: current, resolvedTheme, setTheme, cycle };
}
