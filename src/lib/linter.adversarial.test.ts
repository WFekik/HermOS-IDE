import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { lintContent } from "./linter";

describe("linter.ts — adversarial tests", () => {
  describe("lintContent: never-throws property", () => {
    it("never throws on arbitrary strings", () => {
      fc.assert(
        fc.property(fc.string(), (code) => {
          try {
            const result = lintContent(code, "typescript");
            expect(Array.isArray(result)).toBe(true);
            for (const d of result) {
              expect(typeof d.line).toBe("number");
              expect(typeof d.column).toBe("number");
              expect(typeof d.message).toBe("string");
              expect(["error", "warning"]).toContain(d.severity);
              expect(typeof d.rule).toBe("string");
            }
          } catch (e) {
            expect.fail(`lintContent threw on input length ${code.length}: ${e}`);
          }
        }),
        { numRuns: 500, seed: 42 },
      );
    });

    it("handles null/undefined gracefully", () => {
      // @ts-expect-error — testing runtime resilience
      const r1 = lintContent(null, "typescript");
      expect(r1).toEqual([]);
      // @ts-expect-error
      const r2 = lintContent(undefined, "typescript");
      expect(r2).toEqual([]);
    });

    it("handles empty string", () => {
      expect(lintContent("", "typescript")).toEqual([]);
    });
  });

  describe("lintContent: large / pathological inputs", () => {
    it("returns [] for content exceeding MAX_CONTENT_BYTES", () => {
      const large = "x".repeat(1_000_001);
      const result = lintContent(large, "typescript");
      expect(result).toEqual([]);
    });

    it("handles content with only null bytes", () => {
      // This would not be valid JS but the linter should not crash
      const nullBytes = "\x00".repeat(100);
      expect(() => lintContent(nullBytes, "typescript")).not.toThrow();
    });

    it("handles very long single line", () => {
      const longLine = "let x = " + "'a'".repeat(50000) + ";";
      const result = lintContent(longLine, "typescript");
      // Should return diagnostics or empty, never crash
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe("lintContent: comment detection edge cases", () => {
    it("does not flag console.log in comments", () => {
      const code = [
        "// console.log('this is in a comment')",
        "/* console.log('also in comment') */",
        "const x = 1;",
      ].join("\n");
      const result = lintContent(code, "typescript");
      const consoleDiags = result.filter((d) => d.rule === "no-console");
      expect(consoleDiags).toHaveLength(0);
    });

    it("handles template literals with ${} containing //", () => {
      // Template expressions containing // should not confuse the linter
      const code = [
        "const x = `hello ${a // this // is // not // a // comment",
        "} world`;",
      ].join("\n");
      const result = lintContent(code, "typescript");
      // Should not crash — the comment detector may or may not correctly skip
      // template ${} content, but it must not throw.
      expect(Array.isArray(result)).toBe(true);
    });

    it("handles regex literals containing //", () => {
      const code = [
        "const re = /foo\\//;",  // regex escape, not a comment
        "const re2 = /bar\\//g;", // same
      ].join("\n");
      const result = lintContent(code, "typescript");
      // The linter should not interpret // inside a regex as a comment
      // It may or may not correctly handle this depending on implementation,
      // but it must not crash and the regex must be preserved
      expect(Array.isArray(result)).toBe(true);
    });

    it("handles strings containing comment-like sequences", () => {
      const code = [
        'const s = "not a // comment";',
        "const t = 'also not /* comment */';",
      ].join("\n");
      const result = lintContent(code, "typescript");
      const consoleDiags = result.filter((d) => d.rule === "no-console");
      // No console rules should fire
      expect(consoleDiags).toHaveLength(0);
    });
  });

  describe("lintContent: specific rules edge cases", () => {
    it("flags `var` declarations", () => {
      const code = "var x = 1;";
      const result = lintContent(code, "typescript");
      const varDiags = result.filter((d) => d.rule === "no-unused-var");
      expect(varDiags.length).toBeGreaterThanOrEqual(1);
    });

    it("flags console.log calls", () => {
      const code = "console.log('test');";
      const result = lintContent(code, "typescript");
      const consoleDiags = result.filter((d) => d.rule === "no-console");
      expect(consoleDiags.length).toBeGreaterThanOrEqual(1);
    });

    it("flags debugger statements", () => {
      const code = "function f() { debugger; }";
      const result = lintContent(code, "typescript");
      const debugDiags = result.filter((d) => d.rule === "no-debugger");
      expect(debugDiags.length).toBeGreaterThanOrEqual(1);
    });

    it("flags == and !=", () => {
      const code = "if (x == y) {} if (a != b) {}";
      const result = lintContent(code, "typescript");
      const eqDiags = result.filter((d) => d.rule === "eqeqeq");
      expect(eqDiags.length).toBeGreaterThanOrEqual(2);
    });

    it("capped at 100 diagnostics", () => {
      // Generate code guaranteed to trigger many diagnostics
      const lines: string[] = [];
      for (let i = 0; i < 200; i++) {
        lines.push(`console.log("line ${i}");`);
      }
      const code = lines.join("\n");
      const result = lintContent(code, "typescript");
      // Multiple diagnostics per line possible (console + semi), but capped
      expect(result.length).toBeLessThanOrEqual(100);
    });
  });
});
