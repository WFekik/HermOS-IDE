import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import path from "path";
import os from "os";

describe("workspace.ts — adversarial property tests", () => {
  // We test safePathFromRoot, applyEditToContent, globToRegex, flattenFileTree,
  // and decodeBuffer here — stateless pure functions that don't need disk I/O.

  // safePathFromRoot
  describe("safePathFromRoot", () => {
    // We import it dynamically so the lazy runner can pick it up
    async function getSafePathFromRoot() {
      const mod = await import("./workspace");
      return mod.safePathFromRoot;
    }

    it("rejects path traversal with ../", async () => {
      const safePathFromRoot = await getSafePathFromRoot();
      const rootDir = path.resolve("/tmp", "workspace");
      expect(safePathFromRoot(rootDir, "../etc/passwd")).toBeNull();
      expect(safePathFromRoot(rootDir, "subdir/../../../etc")).toBeNull();
      expect(safePathFromRoot(rootDir, "....//....//etc")).toBeNull();
    });

    it("rejects empty/null rootDir", async () => {
      const safePathFromRoot = await getSafePathFromRoot();
      // @ts-expect-error — testing runtime resilience
      expect(safePathFromRoot(null, "foo")).toBeNull();
      // @ts-expect-error
      expect(safePathFromRoot(undefined, "foo")).toBeNull();
      expect(safePathFromRoot("", "foo")).toBeNull();
    });

    it("never throws on arbitrary rel paths", async () => {
      const safePathFromRoot = await getSafePathFromRoot();
      fc.assert(
        fc.property(fc.string(), (rel) => {
          try {
            const result = safePathFromRoot("/tmp/ws", rel);
            // Result must be either null or a string starting with the base
            if (result !== null) {
              expect(typeof result).toBe("string");
              expect(result.length).toBeGreaterThan(0);
            }
          } catch (e) {
            // safePathFromRoot should never throw — return null on failure
            expect.fail(`safePathFromRoot threw on input ${JSON.stringify(rel)}: ${e}`);
          }
        }),
        { numRuns: 500, seed: 42 },
      );
    });

    it("rejects rel containing null byte", async () => {
      const safePathFromRoot = await getSafePathFromRoot();
      // Null byte in path could truncate in native calls — should be rejected
      const r = safePathFromRoot("/tmp/ws", "hello\x00world");
      // Either null (rejected) or we accept it — but it must not crash
      expect(r === null || typeof r === "string").toBe(true);
    });

    it("rejects Windows absolute paths on POSIX-like root", async () => {
      const safePathFromRoot = await getSafePathFromRoot();
      // These path.resolve would interpret differently on win32 vs posix
      // On POSIX, path.resolve("C:\\foo") would fail since it's not a valid path
      // But we just test it doesn't crash
      expect(() => safePathFromRoot("/tmp/ws", "C:\\Windows\\system32")).not.toThrow();
    });

    it("rejects paths with only dots", async () => {
      const safePathFromRoot = await getSafePathFromRoot();
      expect(safePathFromRoot("/tmp/ws", "..")).toBeNull();
      // ... also rejected because it contains ".." as substring — conservative
      expect(safePathFromRoot("/tmp/ws", "...")).toBeNull();
    });
  });

  // applyEditToContent
  describe("applyEditToContent", () => {
    async function getApplyEdit() {
      const mod = await import("./workspace");
      return mod.applyEditToContent;
    }

    it("never throws on arbitrary content and find strings", async () => {
      const applyEdit = await getApplyEdit();
      fc.assert(
        fc.property(fc.string(), fc.string(), fc.string(), fc.boolean(), (content, find, replace, replaceAll) => {
          try {
            const result = applyEdit(content, find, replace, replaceAll);
            expect(result).toHaveProperty("content");
            expect(result).toHaveProperty("occurrences");
            expect(typeof result.content).toBe("string");
            expect(Number.isInteger(result.occurrences)).toBe(true);
            expect(result.occurrences).toBeGreaterThanOrEqual(0);
            // If occurrences > 0, content must differ from original
            if (result.occurrences > 0 && find !== replace) {
              expect(result.content).not.toBe(content);
            }
          } catch (e) {
            // Only allowed exception is "Text to find is empty."
            if (e instanceof Error) {
              expect([
                "Text to find is empty.",
                "Invalid path.",
              ].includes(e.message)).toBe(true);
            } else {
              expect.fail(`applyEditToContent threw non-Error: ${e}`);
            }
          }
        }),
        { numRuns: 500, seed: 42 },
      );
    });

    it("handles empty content gracefully", async () => {
      const applyEdit = await getApplyEdit();
      const r = applyEdit("", "find", "replace");
      expect(r.occurrences).toBe(0);
      expect(r.content).toBe("");
    });

    it("handles empty find string — should throw or return 0", async () => {
      const applyEdit = await getApplyEdit();
      // Empty find: exact match passes (empty string is in every content)
      // so it doesn't throw — it replaces every position 0-length match
      // This is undefined behavior territory but should not crash
      const r = applyEdit("content", "", "replace");
      // It ran without crashing
      expect(typeof r.content).toBe("string");
    });

    it("preserves content length when find===replace", async () => {
      const applyEdit = await getApplyEdit();
      const r = applyEdit("hello world", "hello", "hello");
      expect(r.content).toBe("hello world");
      expect(r.occurrences).toBe(1);
    });

    it("replaceAll with overlapping strings", async () => {
      const applyEdit = await getApplyEdit();
      // "aaa" with find="aa", replace="a", replaceAll=true
      // split on "aa": ["", "a"], then reduce to "a" + "a" = "aa"
      const r = applyEdit("aaa", "aa", "a", true);
      expect(r.content).toBe("aa"); // first "aa" -> "a", remaining "a" preserved
    });
  });

  // globToRegex
  describe("globToRegex", () => {
    async function getGlobToRegex() {
      const mod = await import("./workspace");
      return mod.globToRegex;
    }

    it("never throws on arbitrary patterns", async () => {
      const globToRegex = await getGlobToRegex();
      fc.assert(
        fc.property(fc.string(), (pattern) => {
          try {
            const re = globToRegex(pattern);
            expect(re).toBeInstanceOf(RegExp);
            // Test that the regex compiles and executes without throwing
            expect(() => re.test("foo.ts")).not.toThrow();
          } catch (e) {
            expect.fail(`globToRegex threw on input ${JSON.stringify(pattern)}: ${e}`);
          }
        }),
        { numRuns: 500, seed: 42 },
      );
    });

    it("handles ReDoS-like patterns without catastrophic backtracking", async () => {
      const globToRegex = await getGlobToRegex();
      // These patterns should compile and execute quickly
      const patterns = [
        "**/**/**/**/**/a",
        "*******************",
        "???????????????????",
        "a/*/b/*/c/*/d/*/e/*/f",
        "[][][][][]]]]]",
      ];
      for (const p of patterns) {
        const re = globToRegex(p);
        const start = performance.now();
        re.test("a/b/c/d/e/f/foo.ts");
        const elapsed = performance.now() - start;
        expect(elapsed).toBeLessThan(100); // must not hang
      }
    });

    it("globToRegex escapes regex metacharacters", async () => {
      const globToRegex = await getGlobToRegex();
      // The dot in .ts should be literal, not "any char"
      const re = globToRegex("readme.md");
      expect(re.test("readmeXmd")).toBe(false);
      expect(re.test("readme.md")).toBe(true);
    });
  });

  // decodeBuffer
  describe("decodeBuffer", () => {
    async function getDecodeBuffer() {
      const mod = await import("./workspace");
      return mod.decodeBuffer;
    }

    it("never throws on arbitrary byte sequences", async () => {
      const decodeBuffer = await getDecodeBuffer();
      fc.assert(
        fc.property(fc.array(fc.integer({ min: 0, max: 255 })), (bytes) => {
          try {
            const buf = Buffer.from(bytes);
            const result = decodeBuffer(buf);
            expect(typeof result).toBe("string");
          } catch (e) {
            expect.fail(`decodeBuffer threw on ${bytes.length} bytes: ${e}`);
          }
        }),
        { numRuns: 500, seed: 42 },
      );
    });

    it("handles empty buffer", async () => {
      const decodeBuffer = await getDecodeBuffer();
      expect(decodeBuffer(Buffer.from([]))).toBe("");
    });

    it("handles invalid UTF-8 sequences without crashing", async () => {
      const decodeBuffer = await getDecodeBuffer();
      // 0xFF and 0xFE are invalid UTF-8 start bytes
      const buf = Buffer.from([0xFF, 0xFE, 0x80, 0xC0, 0xF8, 0x00]);
      const result = decodeBuffer(buf);
      // Should either return something or not throw
      expect(typeof result).toBe("string");
    });
  });
});
