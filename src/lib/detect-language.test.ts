import { describe, it, expect } from "vitest";
import { detectPromptLanguage, languageDisplayName } from "@/lib/detect-language";

describe("detectPromptLanguage", () => {
  it("detects Arabic script", () => {
    expect(detectPromptLanguage("اشرح هذا الكود بالتفصيل")).toBe("ar");
  });
  it("ignores English code fences around Arabic prose", () => {
    expect(
      detectPromptLanguage("اشرح هذا\n```ts\nconst x = 1;\nconsole.log(x);\n```\nبالتفصيل"),
    ).toBe("ar");
  });
  it("detects Russian", () => {
    expect(detectPromptLanguage("Объясни этот код подробно, пожалуйста")).toBe("ru");
  });
  it("detects Japanese by kana", () => {
    expect(detectPromptLanguage("このコードを説明してください")).toBe("ja");
  });
  it("detects Chinese by han majority", () => {
    expect(detectPromptLanguage("请详细解释这段代码的逻辑")).toBe("zh");
  });
  it("detects French with stop words", () => {
    expect(detectPromptLanguage("explique ce code en détail s'il vous plaît")).toBe("fr");
  });
  it("detects German with stop words", () => {
    expect(detectPromptLanguage("erkläre bitte warum dieser code nicht funktioniert")).toBe("de");
  });
  it("keeps English for English prompts", () => {
    expect(detectPromptLanguage("explain this code in detail please")).toBe("en");
  });
  it("does not flip on a single overlapping word", () => {
    // "comment" exists in the French list but alone must not flip English.
    expect(detectPromptLanguage("add a comment explaining this function")).toBe("en");
  });
  it("falls back on ties and empty input", () => {
    expect(detectPromptLanguage("")).toBe("en");
    expect(detectPromptLanguage("   ")).toBe("en");
    expect(detectPromptLanguage("", "ar")).toBe("ar");
    // "para" scores both es and pt → tie → fallback (ui language).
    expect(detectPromptLanguage("para", "es")).toBe("es");
  });
  it("uses the UI language as fallback", () => {
    expect(detectPromptLanguage("ok", "fr")).toBe("fr");
  });
  it("names languages for prompts", () => {
    expect(languageDisplayName("ar")).toBe("Arabic");
    expect(languageDisplayName("zh")).toBe("Chinese");
  });
});
