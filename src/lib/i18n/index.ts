/**
 * Internationalization (i18n) module for HermOS IDE.
 * Supports EN, ES, FR, DE, ZH, JA, AR (RTL), RU, and PT.
 */

import en from "./locales/en";

export type SupportedLanguage = "en" | "es" | "fr" | "de" | "zh" | "ja" | "ar" | "ru" | "pt";

export const DEFAULT_LANGUAGE: SupportedLanguage = "en";

export interface LanguageMeta {
  code: SupportedLanguage;
  name: string;
  nativeName: string;
  dir: "ltr" | "rtl";
}

export const LANGUAGES: Record<SupportedLanguage, LanguageMeta> = {
  en: { code: "en", name: "English", nativeName: "English", dir: "ltr" },
  es: { code: "es", name: "Español", nativeName: "Español", dir: "ltr" },
  fr: { code: "fr", name: "Français", nativeName: "Français", dir: "ltr" },
  de: { code: "de", name: "Deutsch", nativeName: "Deutsch", dir: "ltr" },
  zh: { code: "zh", name: "中文", nativeName: "简体中文", dir: "ltr" },
  ja: { code: "ja", name: "日本語", nativeName: "日本語", dir: "ltr" },
  ar: { code: "ar", name: "العربية", nativeName: "العربية", dir: "rtl" },
  ru: { code: "ru", name: "Русский", nativeName: "Русский", dir: "ltr" },
  pt: { code: "pt", name: "Português", nativeName: "Português", dir: "ltr" },
};

/** Single source for the language allowlist (layout anti-FOUC script, tests). */
export const SUPPORTED_LANGUAGE_CODES: readonly SupportedLanguage[] = [
  "en",
  "es",
  "fr",
  "de",
  "zh",
  "ja",
  "ar",
  "ru",
  "pt",
];

/** localStorage key for the active language (mirrors app-store LANGUAGE_KEY). */
export const LANGUAGE_STORAGE_KEY = "hermos:language";

/**
 * Non-English locales are lazy-loaded on first use and cached.
 * This keeps the initial page bundle to English-only (~60KB) and loads
 * additional dictionaries only when the user selects a different language.
 * English is always available synchronously as the fallback.
 */
const localeCache: Partial<Record<SupportedLanguage, Record<string, string>>> = {
  en, // English is always available — never needs a network round-trip
};

const localeLoadPromises: Partial<Record<SupportedLanguage, Promise<Record<string, string>>>> = {};

/** Async loader map for each non-English locale. */
const LOCALE_LOADERS: Record<Exclude<SupportedLanguage, "en">, () => Promise<{ default: Record<string, string> }>> = {
  es: () => import("./locales/es"),
  fr: () => import("./locales/fr"),
  de: () => import("./locales/de"),
  zh: () => import("./locales/zh"),
  ja: () => import("./locales/ja"),
  ar: () => import("./locales/ar"),
  ru: () => import("./locales/ru"),
  pt: () => import("./locales/pt"),
};

/**
 * Eagerly returns the cached dictionary for `lang`, or `en` while the locale
 * is still loading. Call `loadLocale(lang)` and await it before rendering to
 * guarantee the correct dictionary is available.
 */
export function getDictionary(lang: SupportedLanguage): Record<string, string> {
  return localeCache[lang] ?? en;
}

/**
 * Loads and caches the dictionary for `lang`. Safe to call multiple times;
 * subsequent calls return the same cached promise. English is a no-op.
 */
export function loadLocale(lang: SupportedLanguage): Promise<Record<string, string>> {
  if (lang === "en" || localeCache[lang]) {
    return Promise.resolve(localeCache[lang] ?? en);
  }
  if (localeLoadPromises[lang]) {
    return localeLoadPromises[lang]!;
  }
  const loader = LOCALE_LOADERS[lang as Exclude<SupportedLanguage, "en">];
  const promise = loader().then(
    (mod) => {
      const dict = mod.default ?? mod;
      localeCache[lang] = dict as Record<string, string>;
      return dict as Record<string, string>;
    },
    (err) => {
      // Evict rejected promises so a transient chunk failure retries instead
      // of permanently pinning the session to English.
      delete localeLoadPromises[lang];
      throw err;
    },
  );
  localeLoadPromises[lang] = promise;
  return promise;
}



export type TranslationKey = keyof typeof en;

export function t(key: string, lang: SupportedLanguage = "en", params?: Record<string, string | number>): string {
  const dict = getDictionary(lang);
  let text =
    Object.hasOwn(dict, key) && typeof dict[key] === "string"
      ? dict[key]
      : Object.hasOwn(en, key) && typeof en[key] === "string"
        ? en[key]
        : key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.replaceAll(`{${k}}`, () => String(v));
    }
  }
  return text;
}

/**
 * True when `key` exists in the cached dictionary for `lang` or in English.
 * Use for dynamic keys (e.g. `provider_desc_${id}`) where `t(key) || fallback`
 * never falls back because `t()` returns the key itself (truthy) on miss.
 */
export function hasTranslation(key: string, lang: SupportedLanguage = "en"): boolean {
  const dict = getDictionary(lang);
  return (
    (Object.hasOwn(dict, key) && typeof dict[key] === "string") ||
    (Object.hasOwn(en, key) && typeof en[key] === "string")
  );
}

/**
 * Translate `key`, falling back to `fallback` when the key is missing in both
 * the active locale and English. For dynamic keys where showing the raw
 * `prefix_id` key would be user-visible slop.
 */
export function tOr(
  key: string,
  fallback: string,
  lang: SupportedLanguage = "en",
  params?: Record<string, string | number>,
): string {
  if (!hasTranslation(key, lang)) return fallback;
  return t(key, lang, params);
}

export function isRtlLanguage(lang: SupportedLanguage): boolean {
  return LANGUAGES[lang]?.dir === "rtl";
}

export function applyLanguageDocumentDir(lang: SupportedLanguage): void {
  if (typeof document === "undefined") return;
  const isRtl = isRtlLanguage(lang);
  document.documentElement.setAttribute("lang", lang);
  document.documentElement.setAttribute("dir", isRtl ? "rtl" : "ltr");
  document.documentElement.classList.toggle("rtl", isRtl);
}

// Built-in skill and agent localization helpers
function normalizeSkillKeyPart(name: string): string {
  return name.toLowerCase().replace(/[\s-]+/g, "_");
}

export function getSkillDisplayName(skillName: string, tFn: (k: string) => string): string {
  const key = `skill_name_${normalizeSkillKeyPart(skillName)}`;
  const translated = tFn(key);
  return translated !== key ? translated : skillName;
}

export function getSkillDescription(skillName: string, fallbackDesc: string | undefined, tFn: (k: string) => string): string {
  const key = `skill_desc_${normalizeSkillKeyPart(skillName)}`;
  const translated = tFn(key);
  return translated !== key ? translated : (fallbackDesc || "");
}

export function getSkillToolDescription(toolName: string, fallbackDesc: string | undefined, tFn: (k: string) => string): string {
  const key = `tool_desc_${toolName}`;
  const translated = tFn(key);
  return translated !== key ? translated : (fallbackDesc || "");
}

export function getPresetDisplayName(presetName: string, tFn: (k: string) => string): string {
  const key = `preset_name_${presetName.toLowerCase().replace(/\s+/g, "_")}`;
  const translated = tFn(key);
  return translated !== key ? translated : presetName;
}

export function getPresetDescription(presetName: string, fallbackDesc: string | undefined, tFn: (k: string) => string): string {
  const key = `preset_desc_${presetName.toLowerCase().replace(/\s+/g, "_")}`;
  const translated = tFn(key);
  return translated !== key ? translated : (fallbackDesc || "");
}

/** Shared thinking-level label/desc lookup with English fallback. Single source for composer + provider-models. */
export function getThinkingLabel(val: string, fallback: string, tFn: (k: string) => string): string {
  const key = `thinking_${val}`;
  const res = tFn(key);
  return res !== key ? res : fallback;
}

export function getThinkingDesc(val: string, fallback: string, tFn: (k: string) => string): string {
  const key = `thinking_${val}_desc`;
  const res = tFn(key);
  return res !== key ? res : fallback;
}
