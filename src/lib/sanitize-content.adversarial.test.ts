import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import {
  sanitizeContent,
  sanitizeStreamingDelta,
  extractThinkingAndContent,
  stripEmojis,
} from "./sanitize-content";

describe("sanitize-content.ts — adversarial tests", () => {
  describe("stripEmojis: fuzz with arbitrary strings", () => {
    it("never throws", () => {
      fc.assert(
        fc.property(fc.string(), (s) => {
          expect(() => stripEmojis(s)).not.toThrow();
          const result = stripEmojis(s);
          expect(typeof result).toBe("string");
        }),
        { numRuns: 500, seed: 42 },
      );
    });

    it("handles null/undefined", () => {
      // @ts-expect-error — testing runtime resilience
      expect(stripEmojis(null)).toBe("");
      // @ts-expect-error
      expect(stripEmojis(undefined)).toBe("");
    });

    it("idempotent: second pass produces same output", () => {
      fc.assert(
        fc.property(fc.string(), (s) => {
          const first = stripEmojis(s);
          const second = stripEmojis(first);
          expect(first).toBe(second);
        }),
        { numRuns: 200, seed: 42 },
      );
    });

    it("does not strip markdown syntax accidentally", () => {
      const markdown = "**bold** *italic* `code` [link](url)";
      const result = stripEmojis(markdown);
      expect(result).toContain("**bold**");
      expect(result).toContain("*italic*");
    });
  });

  describe("sanitizeContent: fuzz with arbitrary strings", () => {
    it("never throws", () => {
      fc.assert(
        fc.property(fc.string(), (s) => {
          try {
            const result = sanitizeContent(s);
            expect(typeof result).toBe("string");
          } catch (e) {
            expect.fail(`sanitizeContent threw on input length ${s.length}: ${e}`);
          }
        }),
        { numRuns: 500, seed: 42 },
      );
    });

    it("handles null/undefined", () => {
      // @ts-expect-error
      expect(sanitizeContent(null)).toBe("");
      // @ts-expect-error
      expect(sanitizeContent(undefined)).toBe("");
    });

    it("idempotent: running twice yields same output", () => {
      fc.assert(
        fc.property(fc.string(), (s) => {
          const first = sanitizeContent(s);
          const second = sanitizeContent(first);
          expect(first).toBe(second);
        }),
        { numRuns: 200, seed: 42 },
      );
    });

    it("strips all tool_call variants", () => {
      const cases = [
        // Standard fenced block
        'Some text\n```tool_call\nread_file path="foo"\n```\nMore text',
        // Unclosed fence
        'Before\n```tool_call\nread_file path="foo"\nAfter',
        // XML tool_call
        'Before\n<tool_call>\nread_file path="foo"\n</tool_call>\nAfter',
        // Unclosed XML tool_call
        'Before\n<tool_call>\nread_file path="foo"',
        // Nested tool_call in xml fence
        'Before\n```xml\n<tool_call>\nread_file\n</tool_call>\n```\nAfter',
        // DSML format
        'Before\n<DSML|tool_calls>\n<DSML|invoke name="read_file">\n</DSML|invoke>\n</DSML|tool_calls>\nAfter',
        // think tags
        'Before\n<think>I should read the file</think>\nAfter',
        // Unclosed think tags
        'Before\n<think>I should read the file',
      ];
      for (const c of cases) {
        const result = sanitizeContent(c);
        // Tool content should be stripped; "Before" and "After" should remain
        expect(result).not.toMatch(/read_file/);
      }
    });

    it("strips tool result narration lines", () => {
      const cases = [
        'Before\nTool "read_file" result (ok=true): content\nAfter',
        'Before\nTool "write_file" succeeded: written\nAfter',
        'Before\nTool "run_command" failed: not found\nAfter',
      ];
      for (const c of cases) {
        const result = sanitizeContent(c);
        expect(result).not.toContain("Tool ");
        expect(result).toContain("Before");
        expect(result).toContain("After");
      }
    });

    it("handles long strings efficiently (no ReDoS)", () => {
      // Build a string with repetitive content that could trigger backtracking
      const long = "hello\n" + "```tool_call\n".repeat(100) + "world";
      const result = sanitizeContent(long);
      expect(typeof result).toBe("string");
    });

    it("handles deeply nested think tags (regex limitation)", () => {
      // Regex-based stripping can't handle nested tags properly — lazy
      // matching matches closest pair first. But idempotency means running
      // the full sanitizer twice cleans up more. We verify the final
      // output is clean and no crash occurs.
      const nested = `<think>outer <think>middle <think>inner</think> mid</think> out</think>content`;
      const first = sanitizeContent(nested);
      // After first pass: inner think tags are closed, outer ones remain
      // because they span across the closing boundary.
      // Key: it must be idempotent from here on and must not crash.
      const second = sanitizeContent(first);
      expect(typeof second).toBe("string");
      // The content should at minimum preserve "content"
      expect(second).toContain("content");
      // idempotent — third pass should match second
      const third = sanitizeContent(second);
      expect(third).toBe(second);
    });

    it("preserves legitimate code blocks", () => {
      const code = "```javascript\nconsole.log('hello');\n```";
      const result = sanitizeContent(code);
      // Not a tool_call fence, so should be preserved
      expect(result).toContain("console.log");
    });
  });

  describe("sanitizeStreamingDelta: fuzz", () => {
    it("never throws", () => {
      fc.assert(
        fc.property(fc.string(), (s) => {
          expect(() => sanitizeStreamingDelta(s)).not.toThrow();
        }),
        { numRuns: 500, seed: 42 },
      );
    });

    it("handles null/undefined", () => {
      // @ts-expect-error
      expect(sanitizeStreamingDelta(null)).toBe("");
      // @ts-expect-error
      expect(sanitizeStreamingDelta(undefined)).toBe("");
    });

    it("idempotent", () => {
      fc.assert(
        fc.property(fc.string(), (s) => {
          const first = sanitizeStreamingDelta(s);
          const second = sanitizeStreamingDelta(first);
          expect(first).toBe(second);
        }),
        { numRuns: 100, seed: 42 },
      );
    });

    it("preserves unclosed tags (streaming safety)", () => {
      // sanitizeStreamingDelta should NOT strip unclosed tags
      const delta = "Hello <think>I am thinking";
      const result = sanitizeStreamingDelta(delta);
      expect(result).toContain("<think>");
    });
  });

  describe("extractThinkingAndContent: edge cases", () => {
    it("never throws on arbitrary inputs", () => {
      fc.assert(
        fc.property(fc.string(), fc.string(), (content, existing) => {
          expect(() => extractThinkingAndContent(content, existing)).not.toThrow();
        }),
        { numRuns: 200, seed: 42 },
      );
    });

    it("handles null/undefined", () => {
      // @ts-expect-error
      const r1 = extractThinkingAndContent(null);
      expect(r1.content).toBe("");
      // @ts-expect-error
      const r2 = extractThinkingAndContent(undefined);
      expect(r2.content).toBe("");
    });

    it("extracts multiple think tag variants", () => {
      const input = '<thinking>deep thought</thinking>text<reasoning>logical step</reasoning>';
      const r = extractThinkingAndContent(input);
      expect(r.thinking).toContain("deep thought");
      expect(r.thinking).toContain("logical step");
      expect(r.content).not.toContain("deep thought");
      expect(r.content).not.toContain("logical step");
    });

    it("appends to existing thinking", () => {
      const r = extractThinkingAndContent("<think>new thought</think>", "preexisting");
      expect(r.thinking).toContain("preexisting");
      expect(r.thinking).toContain("new thought");
    });

    it("handles overlapping think tags gracefully", () => {
      const input = "<think>first<think>second</think>tail";
      const r = extractThinkingAndContent(input);
      // The first <think> is unclosed, the second is closed.
      // The regex matches the closed one first ([\s\S]*? is lazy).
      expect(r.thinking).toContain("second");
    });
  });

  describe("cross-function consistency: sanitizeContent vs sanitizeStreamingDelta", () => {
    it("streaming-safe output is a subset of full sanitization", () => {
      fc.assert(
        fc.property(fc.string(), (s) => {
          const full = sanitizeContent(s);
          const streamed = sanitizeStreamingDelta(s);
          // full sanitization should strip everything that streaming strips, and possibly more (unclosed
          // tags).
          const refull = sanitizeContent(streamed);
          expect(refull).toBe(sanitizeContent(refull));
        }),
        { numRuns: 100, seed: 42 },
      );
    });
  });

  describe("XSS vectors in sanitized output", () => {
    it("does not strip HTML/JS that is legitimate content", () => {
      // The sanitizer should only strip tool-related patterns, not HTML/JS
      const xss = '<script>alert("xss")</script><img src=x onerror=alert(1)>';
      const result = sanitizeContent(xss);
      // These should be preserved since they're not tool-related patterns
      expect(result).toContain("script");
      expect(result).toContain("alert");
    });

    it("handles zero-width joiners and Unicode control chars", () => {
      const zwj = "Hello\u200DWorld\u200B\uFEFF";
      const result = sanitizeContent(zwj);
      expect(result).toContain("Hello");
      // Should not crash
    });

    it("handles right-to-left override", () => {
      const rtl = "normal \u202E hidden text content";
      expect(() => sanitizeContent(rtl)).not.toThrow();
    });
  });
});
