"use client";

import * as React from "react";
import { useAppStore } from "@/stores/app-store";
import { useTheme } from "@/components/theme/theme-provider";
import { applyThemeToDocument, clearCustomThemeVariables } from "@/lib/color-theme";

export function AppearanceApplier() {
  const density = useAppStore((s) => s.density);
  const fontSize = useAppStore((s) => s.fontSize);
  const lightThemeConfig = useAppStore((s) => s.lightThemeConfig);
  const darkThemeConfig = useAppStore((s) => s.darkThemeConfig);
  const { resolvedTheme } = useTheme();

  // Apply density & base font size
  React.useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("density-compact", density === "compact");
    root.style.fontSize = `${fontSize}px`;
    return () => {
      root.classList.remove("density-compact");
      root.style.fontSize = "";
    };
  }, [density, fontSize]);

  // Apply color customization and CSS variables dynamically
  React.useEffect(() => {
    const activeConfig = resolvedTheme === "dark" ? darkThemeConfig : lightThemeConfig;
    applyThemeToDocument(resolvedTheme, activeConfig);

    return () => {
      clearCustomThemeVariables();
    };
  }, [resolvedTheme, lightThemeConfig, darkThemeConfig]);

  return null;
}
