"use client";

import * as React from "react";
import { useAppStore } from "@/stores/app-store";
import { t, isRtlLanguage, loadLocale, type SupportedLanguage } from "@/lib/i18n";

export function useTranslation() {
  const language = useAppStore((s) => s.language);

  // Trigger locale loading on mount and whenever language changes.
  // loadLocale() is idempotent (cached after first load, retries after
  // failure). While a non-English chunk loads, getDictionary() falls back to
  // English per-key, so the first paint after a switch may briefly show
  // English before the forceUpdate re-renders with the loaded dictionary.
  // No ready/meta flags — no call site gates on them, and dir/meta are
  // derivable synchronously from `language`.
  const [, forceUpdate] = React.useReducer((x: number) => x + 1, 0);
  React.useEffect(() => {
    let cancelled = false;
    loadLocale(language).then(
      () => {
        if (!cancelled) forceUpdate();
      },
      () => {
        // Dynamic import failed (e.g. chunk error) — stay on fallback English.
        // loadLocale evicts the rejection so the next mount retries.
      },
    );
    return () => {
      cancelled = true;
    };
  }, [language]);

  const tFn = React.useCallback(
    (key: string, paramsOrLang?: Record<string, string | number> | SupportedLanguage, maybeParams?: Record<string, string | number>) => {
      if (typeof paramsOrLang === "string") {
        return t(key, paramsOrLang, maybeParams);
      }
      return t(key, language, paramsOrLang);
    },
    [language],
  );
  return {
    t: tFn,
    language,
    isRtl: isRtlLanguage(language),
  };
}
