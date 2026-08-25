"use client";

import * as React from "react";
import { useAppStore } from "@/stores/app-store";

export function AppearanceApplier() {
  const density = useAppStore((s) => s.density);
  const fontSize = useAppStore((s) => s.fontSize);

  React.useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("density-compact", density === "compact");
    root.style.fontSize = `${fontSize}px`;
    return () => {
      root.classList.remove("density-compact");
      root.style.fontSize = "";
    };
  }, [density, fontSize]);

  return null;
}
