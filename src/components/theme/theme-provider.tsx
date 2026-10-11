"use client";

import * as React from "react";
import { useCallback, useContext, useEffect, useMemo, useState } from "react";

export type ThemeMode = "light" | "dark" | "system";

export const STORAGE_KEY = "theme";

interface ThemeContextValue {
  theme: ThemeMode;
  setTheme: (theme: ThemeMode | string) => void;
  resolvedTheme: "light" | "dark";
  systemTheme: "light" | "dark";
  themes: ThemeMode[];
}

const defaultContext: ThemeContextValue = {
  theme: "system",
  setTheme: () => {},
  resolvedTheme: "light",
  systemTheme: "light",
  themes: ["light", "dark", "system"],
};

const ThemeContext = React.createContext<ThemeContextValue>(defaultContext);

export function useTheme() {
  return useContext(ThemeContext);
}

function readStoredTheme(): ThemeMode {
  if (typeof window === "undefined") return "system";
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === "light" || raw === "dark" || raw === "system") return raw;
  } catch {
    // localStorage unavailable — keep the default
  }
  return "system";
}

function readSystemTheme(): "light" | "dark" {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "light";
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  } catch {
    return "light";
  }
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // Lazy initializers read storage + media query during the FIRST render, so
  // the first paint already carries the persisted/matched theme — matching
  // the anti-FOUC inline script in layout.tsx. The old useState("system") +
  // mount-effect-set caused a second render that briefly applied the WRONG
  // mode's CSS variables for persisted-dark + custom-theme users.
  const [theme, setThemeState] = useState<ThemeMode>(readStoredTheme);
  const [systemTheme, setSystemTheme] = useState<"light" | "dark">(readSystemTheme);

  useEffect(() => {
    // Re-sync in case storage changed between first render and mount.
    setThemeState(readStoredTheme());
    setSystemTheme(readSystemTheme());

    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const sync = () => setSystemTheme(mq.matches ? "dark" : "light");
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    const resolved = theme === "system" ? systemTheme : theme;
    const root = document.documentElement;
    root.classList.remove("light", "dark");
    root.classList.add(resolved);
    root.style.colorScheme = resolved;
  }, [theme, systemTheme]);

  const setTheme = useCallback((next: ThemeMode | string) => {
    if (next !== "light" && next !== "dark" && next !== "system") return;
    setThemeState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // localStorage unavailable — theme still applies for this session
    }
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme,
      setTheme,
      resolvedTheme: theme === "system" ? systemTheme : theme,
      systemTheme,
      themes: ["light", "dark", "system"],
    }),
    [theme, systemTheme, setTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}