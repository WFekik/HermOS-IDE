// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from "vitest";
import {
  LANGUAGES,
  DEFAULT_LANGUAGE,
  getDictionary,
  t,
  isRtlLanguage,
  applyLanguageDocumentDir,
  loadLocale,
  type SupportedLanguage,
} from "./i18n";

describe("i18n system", () => {
  const expectedLanguages: SupportedLanguage[] = [
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

  beforeAll(async () => {
    for (const code of expectedLanguages) {
      await loadLocale(code);
    }
  });

  it("supports all 9 requested languages", () => {
    for (const code of expectedLanguages) {
      expect(LANGUAGES[code]).toBeDefined();
      expect(LANGUAGES[code].code).toBe(code);
      expect(LANGUAGES[code].nativeName).toBeTruthy();
      // Assert the real loaded dictionary.
      const dict = getDictionary(code);
      expect(dict).toBeDefined();
      expect(Object.keys(dict).length).toBeGreaterThan(1000);
      expect(dict.settings).toBeTruthy();
    }
  });

  it("identifies Arabic as RTL and other languages as LTR", () => {
    expect(isRtlLanguage("ar")).toBe(true);
    expect(LANGUAGES.ar.dir).toBe("rtl");

    for (const code of expectedLanguages) {
      if (code !== "ar") {
        expect(isRtlLanguage(code)).toBe(false);
        expect(LANGUAGES[code].dir).toBe("ltr");
      }
    }
  });

  it("translates common keys into different languages", () => {
    expect(t("settings", "en")).toBe("Settings");
    expect(t("settings", "es")).toBe("Configuración");
    expect(t("settings", "fr")).toBe("Paramètres");
    expect(t("settings", "de")).toBe("Einstellungen");
    expect(t("settings", "zh")).toBe("设置");
    expect(t("settings", "ja")).toBe("設定");
    expect(t("settings", "ar")).toBe("الإعدادات");
    expect(t("settings", "ru")).toBe("Настройки");
    expect(t("settings", "pt")).toBe("Configurações");
  });

  it("translates UI components and error popups across all 9 languages", () => {
    const keysToCheck = [
      "files_panel_error",
      "delete_conversation_title",
      "wants_permission",
      "select_option",
      "empty_state_title",
      "editing_message",
      "rate_limit_reached",
      "cancel_run",
      "save_edit",
      "send_message",
      "something_went_wrong",
      "try_again",
      "command_outside_workspace",
    ];

    for (const code of expectedLanguages) {
      for (const key of keysToCheck) {
        const translated = t(key, code);
        expect(translated).toBeTruthy();
        expect(translated).not.toBe(key);
      }
    }
  });

  it("falls back to English when a key is missing in target language", () => {
    // A key present in EN
    expect(t("language", "zh")).toBe("语言");
    // An unknown key falls back to key itself
    expect(t("non_existent_key_123", "es")).toBe("non_existent_key_123");
  });

  it("tOr/hasTranslation fall back for dynamic keys instead of leaking raw keys", async () => {
    const { hasTranslation, tOr } = await import("./i18n");
    // Known dynamic key resolves (custom exists in all locales).
    expect(hasTranslation("provider_desc_custom", "en")).toBe(true);
    expect(tOr("provider_desc_custom", "fallback-desc", "en")).not.toBe("fallback-desc");
    expect(tOr("provider_desc_custom", "fallback-desc", "es")).not.toBe("fallback-desc");
    // Unknown provider id must return the caller fallback, never the raw key.
    expect(hasTranslation("provider_desc_unknown_xyz", "en")).toBe(false);
    expect(hasTranslation("provider_desc_unknown_xyz", "es")).toBe(false);
    expect(tOr("provider_desc_unknown_xyz", "My custom provider", "en")).toBe("My custom provider");
    expect(tOr("provider_desc_unknown_xyz", "My custom provider", "es")).toBe("My custom provider");
    expect(tOr("perm_desc_unknown_xyz", "Do things", "ar")).toBe("Do things");
  });

  it("keeps SUPPORTED_LANGUAGE_CODES in sync with LANGUAGES (layout allowlist single-source)", async () => {
    const { LANGUAGES, SUPPORTED_LANGUAGE_CODES, LANGUAGE_STORAGE_KEY } = await import("./i18n");
    expect([...SUPPORTED_LANGUAGE_CODES].sort()).toEqual(Object.keys(LANGUAGES).sort());
    expect(LANGUAGE_STORAGE_KEY).toBe("hermos:language");
  });

  it("keeps full key-set parity across all locales (no silent English fallback)", async () => {
    const enMod = await import("./i18n/locales/en");
    const enDict = (enMod.default ?? enMod.en ?? enMod) as Record<string, string>;
    const enKeys = new Set(Object.keys(enDict));
    for (const code of expectedLanguages) {
      if (code === "en") continue;
      const dict = getDictionary(code);
      const missing = [...enKeys].filter((k) => !(k in dict));
      const extra = Object.keys(dict).filter((k) => !enKeys.has(k));
      expect(missing, `${code} missing ${missing.length} keys vs en: ${missing.slice(0, 10).join(", ")}`).toEqual([]);
      expect(extra, `${code} has ${extra.length} extra keys vs en: ${extra.slice(0, 10).join(", ")}`).toEqual([]);
    }
  });

  it("safely handles Object.prototype keys without crashing or returning functions", () => {
    expect(t("toString")).toBe("toString");
    expect(t("valueOf")).toBe("valueOf");
    expect(t("constructor")).toBe("constructor");
    expect(t("toString", "es", { val: "123" })).toBe("toString");
  });

  it("safely interpolates values containing special regex sequences like $1 and $&", () => {
    // Test that $1 and $& do not get expanded as regex replacement patterns
    const result = t("tools_available", "en", { count: "$100" });
    expect(result).toBeDefined();
    // Directly test parameter substitution
    const interpolated = t("files_count", "en", { count: "$1" });
    expect(interpolated).toBe("$1 files");
  });

  describe("applyLanguageDocumentDir", () => {
    it("sets documentElement attributes correctly", () => {
      applyLanguageDocumentDir("ar");
      expect(document.documentElement.lang).toBe("ar");
      expect(document.documentElement.dir).toBe("rtl");

      applyLanguageDocumentDir("en");
      expect(document.documentElement.lang).toBe("en");
      expect(document.documentElement.dir).toBe("ltr");

      applyLanguageDocumentDir("ja");
      expect(document.documentElement.lang).toBe("ja");
      expect(document.documentElement.dir).toBe("ltr");
    });
  });

  describe("useTranslation hook", () => {
    it("returns translation function and active metadata", async () => {
      const { useTranslation } = await import("@/hooks/use-translation");
      const { renderHook } = await import("@testing-library/react");
      const { result } = renderHook(() => useTranslation());
      expect(typeof result.current.t).toBe("function");
      expect(result.current.language).toBe(DEFAULT_LANGUAGE);
      expect(result.current.t("settings")).toBe("Settings");
      expect(result.current.t("settings", "es")).toBe("Configuración");
    });
  });

  describe("dictionary hygiene (no stale duplicates)", () => {
    // Canonical keys that code must use. Legacy aliases removed in dedupe
    // (adding_ellipsis, by_model_top5, command_palette_desc, group_*, shortcut_*, …)
    // must not reappear.
    const REMOVED_LEGACY_KEYS = [
      "adding_ellipsis",
      "by_model_top5",
      "command_palette_alias",
      "command_palette_desc",
      "command_palette_input_placeholder",
      "group_actions",
      "group_conversations",
      "group_files",
      "group_recent",
      "shortcut_cancel_edit",
      "shortcut_close",
      "shortcut_command_palette",
      "shortcut_export",
      "shortcut_find_files",
      "shortcut_goto_line",
      "shortcut_new_chat",
      "shortcut_palette_alias",
      "shortcut_right_panel",
      "shortcut_select_all",
      "shortcut_send",
      "shortcut_send_edit",
      "shortcut_settings",
      "shortcut_shortcuts",
      "shortcut_sidebar",
      "shortcut_split_editor",
      "shortcut_tab",
      "no_key",
      "badge_no_key",
      "badge_key",
      "badge_token",
    ];
    const CANONICAL_KEYS = [
      "adding",
      "by_model_top_5",
      "command_palette_description",
      "command_palette_placeholder",
      "command_palette_title",
      "cp_group_actions",
      "ks_cancel_edit_mode",
      "no_key_badge",
      "key_badge",
      "token_badge",
    ];
    it("does not resurrect removed legacy duplicate keys", async () => {
      const enMod = await import("./i18n/locales/en");
      const dict = (enMod.default ?? enMod.en ?? enMod) as Record<string, string>;
      for (const k of REMOVED_LEGACY_KEYS) {
        expect(dict[k], `legacy key ${k} must stay removed`).toBeUndefined();
      }
      for (const k of CANONICAL_KEYS) {
        expect(dict[k], `canonical key ${k} must exist`).toBeTruthy();
      }
    });
    it("has no exact-duplicate values for the canonicalised families", async () => {
      const enMod = await import("./i18n/locales/en");
      const dict = (enMod.default ?? enMod.en ?? enMod) as Record<string, string>;
      // Within each family, values must be unique (prevents adding_ellipsis-style clones).
      const families: string[][] = [
        ["adding"],
        ["by_model_top_5"],
        ["command_palette_description", "command_palette_placeholder"],
        ["cp_group_actions", "cp_group_conversations"],
      ];
      for (const fam of families) {
        const vals = fam.map((k) => dict[k]).filter(Boolean);
        expect(new Set(vals).size).toBe(vals.length);
      }
    });
  });
});
