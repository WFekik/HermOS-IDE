/**
 * Single source of truth for UI font-size defaults.
 * Server-safe (no "use client") so both `app/layout.tsx` (FOUC script) and
 * `stores/app-store.ts` (client zustand store) import from here.
 */
export const DEFAULT_FONT_SIZE = 15;
export const FONT_SIZE_MIN = 12;
export const FONT_SIZE_MAX = 18;
export const FONT_SIZE_KEY = "hermos:font-size";
