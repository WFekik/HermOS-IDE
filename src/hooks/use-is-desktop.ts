"use client";

import * as React from "react";

/**
 * Detects whether the current environment is running as a desktop app
 * or in explicit desktop mode via Tauri internals, URL query params, User Agent, or SSR flags.
 */
export function detectDesktop(): boolean {
  if (typeof window === "undefined") {
    return typeof process !== "undefined" && process.env?.HERMOS_DESKTOP === "true";
  }

  // 1. Tauri v2 runtime internals / globals
  if (Boolean("__TAURI_INTERNALS__" in window || "__TAURI__" in window)) {
    return true;
  }

  // 2. Explicit URL query mode override (?mode=ide or ?mode=desktop)
  try {
    if (window.location && typeof window.location.search === "string") {
      const params = new URLSearchParams(window.location.search);
      for (const [key, value] of params.entries()) {
        if (key.toLowerCase() === "mode") {
          const val = value.toLowerCase();
          if (val === "ide" || val === "desktop") {
            return true;
          }
        }
      }
    }
  } catch {
    // Ignore URL parsing errors
  }

  // 3. Desktop User-Agent markers
  if (
    typeof navigator !== "undefined" &&
    typeof navigator.userAgent === "string" &&
    /tauri|hermos-desktop/i.test(navigator.userAgent)
  ) {
    return true;
  }

  // 4. SSR / process.env fallback
  if (typeof process !== "undefined" && process.env?.HERMOS_DESKTOP === "true") {
    return true;
  }

  return false;
}

/**
 * React hook returning whether the client is running in a desktop environment.
 */
export function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = React.useState<boolean>(() => detectDesktop());

  React.useEffect(() => {
    setIsDesktop(detectDesktop());
  }, []);

  return isDesktop;
}
