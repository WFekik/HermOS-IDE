import { describe, it, expect } from "vitest";
import { BASE_SYSTEM_RULES, composeSystemPrompt } from "@/lib/ai/system-prompt";
import { buildLanguageRulesBlock } from "@/lib/ai/executor";
import { detectPromptLanguage, languageDisplayName } from "@/lib/detect-language";
import { chatRequestSchema, uiLanguageSchema } from "@/lib/validation";
import type { SupportedLanguage } from "@/lib/i18n";

describe("Language & Thinking Rules Invariants", () => {
  it("enforces dynamic prompt language adaptation and UI thinking language in BASE_SYSTEM_RULES", () => {
    expect(BASE_SYSTEM_RULES).toContain("always reply in the language the user uses in their prompt");
    expect(BASE_SYSTEM_RULES).toContain("never default solely to the system or interface language");
    expect(BASE_SYSTEM_RULES).toContain("Conduct internal thinking and reasoning in the application's selected language");
  });

  it("formats response rules with UI language for thinking and user prompt language for responses", () => {
    const uiLang: SupportedLanguage = "ar";
    const uiLanguageName = languageDisplayName(uiLang);
    const userPrompt = "Explain how the tokenizer works in detail.";
    const detectedPromptLang = detectPromptLanguage(userPrompt, uiLang);
    const promptLangName = languageDisplayName(detectedPromptLang);

    expect(uiLanguageName).toBe("Arabic");
    expect(promptLangName).toBe("English");

    const languageBlock = buildLanguageRulesBlock(uiLang, promptLangName);

    const fullPrompt = composeSystemPrompt({
      base: "BASE",
      responseRules: languageBlock,
    });

    expect(fullPrompt).toContain("Always conduct your internal thinking and reasoning trace (<think> blocks, thoughts, and reasoning steps) in Arabic (ar)");
    expect(fullPrompt).toContain("Always respond in the language the user uses in their prompt");
    expect(fullPrompt).toContain("detected user prompt language: English");
    expect(fullPrompt).toContain("do NOT answer solely based on the system or interface language");
  });

  it("handles when prompt is French and UI is German", () => {
    const uiLang: SupportedLanguage = "de";
    const uiLanguageName = languageDisplayName(uiLang);
    const userPrompt = "Bonjour, peux-tu expliquer ce composant s'il te plaît?";
    const detectedPromptLang = detectPromptLanguage(userPrompt, uiLang);
    const promptLangName = languageDisplayName(detectedPromptLang);

    expect(uiLanguageName).toBe("German");
    expect(promptLangName).toBe("French");
  });

  it("handles when prompt is Arabic and UI is English", () => {
    const uiLang: SupportedLanguage = "en";
    const uiLanguageName = languageDisplayName(uiLang);
    const userPrompt = "مرحبا، هل يمكنك مراجعة هذا الملف وإصلاح المشكلة؟";
    const detectedPromptLang = detectPromptLanguage(userPrompt, uiLang);
    const promptLangName = languageDisplayName(detectedPromptLang);

    expect(uiLanguageName).toBe("English");
    expect(promptLangName).toBe("Arabic");
  });

  it("validates uiLanguage in chat and regenerate schemas", () => {
    expect(uiLanguageSchema.safeParse("ar").success).toBe(true);
    expect(uiLanguageSchema.safeParse("fr").success).toBe(true);
    expect(uiLanguageSchema.safeParse("de").success).toBe(true);
    expect(uiLanguageSchema.safeParse("es").success).toBe(true);
    expect(uiLanguageSchema.safeParse("invalid_lang").success).toBe(false);

    const chatReq = chatRequestSchema.safeParse({
      conversationId: "conv-1",
      message: "Hello",
      provider: "anthropic",
      model: "claude-3-7-sonnet",
      mode: "agent",
      uiLanguage: "fr",
    });
    expect(chatReq.success).toBe(true);
    if (chatReq.success) {
      expect(chatReq.data.uiLanguage).toBe("fr");
    }
  });
});
