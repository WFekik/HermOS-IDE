import { describe, it, expect } from "vitest";
import { normalizePrismLanguage, REGISTERED_LANGUAGES } from "@/lib/prism";

/**
 * Pins the PrismLight allowlist: every language the IDE claims to highlight
 * must normalize to itself (i.e. be registered). Add the import + entry in
 * src/lib/prism.ts when extending coverage — this test fails otherwise.
 */
describe("prism language coverage", () => {
  it("registers the IDE's working languages", () => {
    const required = [
      "typescript", "tsx", "javascript", "jsx", "bash", "json", "markdown",
      "python", "yaml", "css", "rust", "go", "java", "c", "cpp", "csharp",
      "php", "ruby", "swift", "kotlin", "toml", "docker", "sql", "powershell",
      "ini", "lua",
    ];
    for (const lang of required) {
      expect(REGISTERED_LANGUAGES as readonly string[]).toContain(lang);
      expect(normalizePrismLanguage(lang)).toBe(lang);
    }
  });

  it("resolves common aliases", () => {
    expect(normalizePrismLanguage("ts")).toBe("typescript");
    expect(normalizePrismLanguage("py")).toBe("text"); // no py alias by design
    expect(normalizePrismLanguage("yml")).toBe("yaml");
    expect(normalizePrismLanguage("sh")).toBe("bash");
    expect(normalizePrismLanguage("h")).toBe("c");
    expect(normalizePrismLanguage("hpp")).toBe("cpp");
    expect(normalizePrismLanguage("ps1")).toBe("powershell");
    expect(normalizePrismLanguage("dockerfile")).toBe("docker");
  });

  it("falls back to text for unknown languages (never crashes)", () => {
    expect(normalizePrismLanguage("brainfuck-xyz")).toBe("text");
    expect(normalizePrismLanguage(undefined)).toBe("text");
    expect(normalizePrismLanguage("")).toBe("text");
  });
});
