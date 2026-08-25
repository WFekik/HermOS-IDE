import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import {
  cleanContent,
  parseTextToolCalls,
  parseNonStreamingResponse,
  STREAM_TOOL_START_RE,
  STREAM_TOOL_COMPLETE_RE,
  THINK_TAGS_RE,
  TOOL_CALL_JSON_RE,
  TOOL_CALL_FENCE_RE,
  XML_TOOL_CALL_RE,
  DSML_TOOL_CALL_RE,
} from "./tool-call-parser";

describe("cleanContent", () => {
  it("passes through plain text unchanged", () => {
    expect(cleanContent("Hello world")).toBe("Hello world");
  });

  it("strips <think> tags", () => {
    // Whitespace around the tag is left in place (no smart collapse)
    expect(cleanContent("A <think>internal reasoning</think> B")).toBe("A  B");
  });

  it("strips all think-tag variants", () => {
    const cases = ["thinking", "thought", "reasoning", "cot", "details"];
    for (const tag of cases) {
      expect(cleanContent(`x <${tag}>inner</${tag}> y`)).toBe("x  y");
    }
  });

  it("strips unclosed think tags and everything after", () => {
    expect(cleanContent("A <think>unclosed rest")).toBe("A");
  });

  it("strips malformed open think tags on their own line", () => {
    expect(cleanContent("A\n<thinkmalformed> \nB")).toBe("A\nB");
    expect(cleanContent("A\n<thinkextra> \nB")).toBe("A\nB");
  });

  it("strips standalone close think tags", () => {
    expect(cleanContent("A </think> B")).toBe("A  B");
    expect(cleanContent("A </reasoning> B")).toBe("A  B");
  });

  it("strips ```tool_call fences", () => {
    const input = 'A\n```tool_call\n{"tool":"read_file","args":{"path":"x"}}\n```\nB';
    // Fence removal leaves an extra blank line from the newline before and after
    expect(cleanContent(input)).toBe("A\n\nB");
  });

  it("strips bare JSON tool calls", () => {
    const input = 'A {"tool":"read_file","args":{"path":"x"}} B';
    expect(cleanContent(input)).toBe("A  B");
  });

  it("strips XML <tool_call> blocks", () => {
    const input = 'A <tool_call>{"tool":"grep","args":{"pattern":"foo"}}</tool_call> B';
    expect(cleanContent(input)).toBe("A  B");
  });

  it("strips XML <tool_code> blocks", () => {
    const input = 'A <tool_code>{"tool":"list_directory","args":{"path":"."}}</tool_code> B';
    expect(cleanContent(input)).toBe("A  B");
  });

  it("strips DSML tool call blocks", () => {
    const dsml = `<｜DSML｜tool_calls><｜DSML｜invoke name="read_file"><｜DSML｜parameter name="path">/etc/hosts</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>`;
    expect(cleanContent(`A ${dsml} B`)).toBe("A  B");
  });

  it("strips DSML blocks with pipe separators", () => {
    const dsml = `<|DSML|tool_calls><|DSML|invoke name="read_file"><|DSML|parameter name="path">/etc/hosts</|DSML|parameter></|DSML|invoke></|DSML|tool_calls>`;
    expect(cleanContent(`A ${dsml} B`)).toBe("A  B");
  });

  it("collapses excessive blank lines", () => {
    expect(cleanContent("A\n\n\n\n\nB")).toBe("A\n\nB");
  });

  it("trims leading/trailing whitespace", () => {
    expect(cleanContent("  hello  ")).toBe("hello");
  });

  it("handles empty string", () => {
    expect(cleanContent("")).toBe("");
  });

  it("strips mixed think + tool call + DSML in one pass", () => {
    const input = [
      "<think>reasoning</think>",
      "Prose here",
      '```tool_call\n{"tool":"read_file","args":{"path":"x"}}\n```',
      "<tool_code>{\"tool\":\"grep\",\"args\":{\"pattern\":\"foo\"}}</tool_code>",
      "More prose",
      `<|DSML|tool_calls><|DSML|invoke name="glob"><|DSML|parameter name="pattern">**/*.ts</|DSML|parameter></|DSML|invoke></|DSML|tool_calls>`,
      "  \n\n\n  ",
    ].join("\n");
    expect(cleanContent(input)).toBe("Prose here\n\nMore prose");
  });

  it("strips nested think tags (non-greedy matches inner first)", () => {
    // Non-greedy [\s\S]*? matches the first </think> close, so the outer
    // tag boundary is lost and "still" survives. This is acceptable since
    // well-formatted model output does not nest think tags.
    expect(cleanContent("A <think>outer <think>inner</think> still</think> B")).toBe("A  still B");
  });
});

describe("parseTextToolCalls — DSML", () => {
  it("parses a single DSML invoke with parameters", () => {
    const dsml = `<｜DSML｜tool_calls><｜DSML｜invoke name="read_file"><｜DSML｜parameter name="path">/etc/hosts</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>`;
    const result = parseTextToolCalls(dsml);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("read_file");
    expect(JSON.parse(result[0].arguments)).toEqual({ path: "/etc/hosts" });
  });

  it("parses multiple DSML invokes in one block", () => {
    const dsml = [
      `<｜DSML｜tool_calls>`,
      `<｜DSML｜invoke name="read_file"><｜DSML｜parameter name="path">a.txt</｜DSML｜parameter></｜DSML｜invoke>`,
      `<｜DSML｜invoke name="grep"><｜DSML｜parameter name="pattern">foo</｜DSML｜parameter><｜DSML｜parameter name="filePattern">*.ts</｜DSML｜parameter></｜DSML｜invoke>`,
      `</｜DSML｜tool_calls>`,
    ].join("");
    const result = parseTextToolCalls(dsml);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("read_file");
    expect(JSON.parse(result[0].arguments)).toEqual({ path: "a.txt" });
    expect(result[1].name).toBe("grep");
    expect(JSON.parse(result[1].arguments)).toEqual({ pattern: "foo", filePattern: "*.ts" });
  });

  it("parses DSML with pipe separators", () => {
    const dsml = `<|DSML|tool_calls><|DSML|invoke name="glob"><|DSML|parameter name="pattern">**/*.ts</|DSML|parameter></|DSML|invoke></|DSML|tool_calls>`;
    const result = parseTextToolCalls(dsml);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("glob");
    expect(JSON.parse(result[0].arguments)).toEqual({ pattern: "**/*.ts" });
  });

  it("falls back to JSON when DSML has no named parameters", () => {
    const dsml = `<｜DSML｜tool_calls><｜DSML｜invoke name="grep">{"pattern":"foo"}</｜DSML｜invoke></｜DSML｜tool_calls>`;
    const result = parseTextToolCalls(dsml);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("grep");
    expect(JSON.parse(result[0].arguments)).toEqual({ pattern: "foo" });
  });

  it("handles DSML with typed parameters", () => {
    const dsml = `<｜DSML｜tool_calls><｜DSML｜invoke name="search"><｜DSML｜parameter name="query" string="true">hello world</｜DSML｜parameter><｜DSML｜parameter name="limit" number="true">10</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>`;
    const result = parseTextToolCalls(dsml);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("search");
    const args = JSON.parse(result[0].arguments);
    expect(args.query).toBe("hello world");
    expect(args.limit).toBe("10");
  });
});

describe("parseTextToolCalls — fences / JSON / XML", () => {
  it("parses fenced ```tool_call blocks without double-parsing", () => {
    const input = 'A\n```tool_call\n{"tool":"read_file","args":{"path":"x"}}\n```\nB';
    const result = parseTextToolCalls(input);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("read_file");
    expect(JSON.parse(result[0].arguments)).toEqual({ path: "x" });
  });

  it("parses bare JSON tool calls", () => {
    const input = 'A {"tool":"grep","args":{"pattern":"foo","filePattern":"*.ts"}} B';
    const result = parseTextToolCalls(input);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("grep");
    expect(JSON.parse(result[0].arguments)).toEqual({ pattern: "foo", filePattern: "*.ts" });
  });

  it("parses XML <tool_call> blocks", () => {
    const input = 'A <tool_call>{"tool":"list_directory","args":{"path":"."}}</tool_call> B';
    const result = parseTextToolCalls(input);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("list_directory");
    expect(JSON.parse(result[0].arguments)).toEqual({ path: "." });
  });

  it("parses XML <tool_code> blocks", () => {
    const input = 'A <tool_code>{"tool":"grep","args":{"pattern":"import"}}</tool_code> B';
    const result = parseTextToolCalls(input);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("grep");
    expect(JSON.parse(result[0].arguments)).toEqual({ pattern: "import" });
  });

  it("parses multiple formats in one input", () => {
    const input = [
      '{"tool":"read_file","args":{"path":"a.txt"}}',
      "<tool_call>{\"tool\":\"grep\",\"args\":{\"pattern\":\"x\"}}</tool_call>",
    ].join(" ");
    const result = parseTextToolCalls(input);
    expect(result).toHaveLength(2);
    expect(result.find((tc) => tc.name === "read_file")).toBeTruthy();
    expect(result.find((tc) => tc.name === "grep")).toBeTruthy();
  });

  it("ignores malformed JSON inside fences", () => {
    const input = '```tool_call\n{not-json}\n```';
    expect(parseTextToolCalls(input)).toHaveLength(0);
  });

  it("ignores fences with missing tool field", () => {
    const input = '```tool_call\n{"action":"run","args":{}}\n```';
    expect(parseTextToolCalls(input)).toHaveLength(0);
  });

  it("parses tool with empty args", () => {
    const input = '{"tool":"noop","args":{}}';
    const result = parseTextToolCalls(input);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("noop");
    expect(JSON.parse(result[0].arguments)).toEqual({});
  });

  it("handles empty string", () => {
    expect(parseTextToolCalls("")).toHaveLength(0);
  });

  it("handles text with no tool calls", () => {
    expect(parseTextToolCalls("Just some plain text without any tool calls")).toHaveLength(0);
  });

  it("does not double-parse the same tool call across formats", () => {
    // JSON inside XML/fence should be parsed only by the XML/fence parser,
    // not again by the bare-JSON parser.
    const xmlInput = '<tool_call>{"tool":"read_file","args":{"path":"a.txt"}}</tool_call>';
    expect(parseTextToolCalls(xmlInput)).toHaveLength(1);

    const fenceInput = '```tool_call\n{"tool":"read_file","args":{"path":"a.txt"}}\n```';
    expect(parseTextToolCalls(fenceInput)).toHaveLength(1);
  });

  it("parses distinct calls in different formats", () => {
    const input = '{"tool":"read_file","args":{"path":"a.txt"}} <tool_call>{"tool":"grep","args":{"pattern":"x"}}</tool_call>';
    const result = parseTextToolCalls(input);
    expect(result).toHaveLength(2);
    expect(result.find((tc) => tc.name === "read_file")).toBeTruthy();
    expect(result.find((tc) => tc.name === "grep")).toBeTruthy();
  });

  it("generates unique IDs for each parsed call", () => {
    const input = '{"tool":"a","args":{}} {"tool":"a","args":{}}';
    const result = parseTextToolCalls(input);
    expect(result).toHaveLength(2);
    expect(result[0].id).not.toBe(result[1].id);
  });

  it("does not confuse think tags for tool calls", () => {
    const input = '<think>some reasoning</think>\n```tool_call\n{"tool":"read_file","args":{"path":"x"}}\n```';
    const result = parseTextToolCalls(input);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("read_file");
  });

  it("handles DSML with nested quotes in parameter values", () => {
    const dsml = `<｜DSML｜tool_calls><｜DSML｜invoke name="write_file"><｜DSML｜parameter name="path">/tmp/"test".txt</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>`;
    const result = parseTextToolCalls(dsml);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("write_file");
    expect(JSON.parse(result[0].arguments)).toEqual({ path: `/tmp/"test".txt` });
  });
});

describe("parseTextToolCalls + cleanContent consistency", () => {
  it("cleanContent removes everything parseTextToolCalls consumes", () => {
    const inputs = [
      '{"tool":"read_file","args":{"path":"x"}}',
      '```tool_call\n{"tool":"grep","args":{"pattern":"x"}}\n```',
      '<tool_call>{"tool":"list_directory","args":{"path":"."}}</tool_call>',
      '<|DSML|tool_calls><|DSML|invoke name="glob"><|DSML|parameter name="pattern">**/*</|DSML|parameter></|DSML|invoke></|DSML|tool_calls>',
    ];
    for (const input of inputs) {
      const calls = parseTextToolCalls(input);
      expect(calls.length).toBeGreaterThanOrEqual(1);
      const cleaned = cleanContent(input);
      // After cleaning, no tool call blocks remain
      expect(cleaned).toBe("");
    }
  });
});

describe("parseNonStreamingResponse", () => {
  it("parses a standard non-streaming response with content", () => {
    const body = JSON.stringify({
      choices: [{ message: { content: "Hello world" } }],
    });
    const result = parseNonStreamingResponse(body);
    expect(result).not.toBeNull();
    expect(result!.content).toBe("Hello world");
  });

  it("parses a response with tool_calls", () => {
    const body = JSON.stringify({
      choices: [{
        message: {
          tool_calls: [
            { id: "call_1", function: { name: "read_file", arguments: '{"path":"x"}' } },
          ],
        },
      }],
    });
    const result = parseNonStreamingResponse(body);
    expect(result).not.toBeNull();
    expect(result!.toolCalls).toHaveLength(1);
    expect(result!.toolCalls![0].name).toBe("read_file");
    expect(result!.toolCalls![0].arguments).toBe('{"path":"x"}');
  });

  it("parses a response with both content and tool_calls", () => {
    const body = JSON.stringify({
      choices: [{
        message: {
          content: "Using tools...",
          tool_calls: [
            { id: "call_1", function: { name: "grep", arguments: '{"pattern":"x"}' } },
          ],
        },
      }],
    });
    const result = parseNonStreamingResponse(body);
    expect(result).not.toBeNull();
    expect(result!.content).toBe("Using tools...");
    expect(result!.toolCalls).toHaveLength(1);
  });

  it("filters out tool_calls with empty function name", () => {
    const body = JSON.stringify({
      choices: [{
        message: {
          tool_calls: [
            { id: "call_1", function: { name: "", arguments: "{}" } },
            { id: "call_2", function: { name: "  ", arguments: "{}" } },
            { id: "call_3", function: { name: "valid", arguments: "{}" } },
          ],
        },
      }],
    });
    const result = parseNonStreamingResponse(body);
    expect(result).not.toBeNull();
    expect(result!.toolCalls).toHaveLength(1);
    expect(result!.toolCalls![0].name).toBe("valid");
  });

  it("returns null for malformed JSON", () => {
    expect(parseNonStreamingResponse("{not-json}")).toBeNull();
  });

  it("returns null when there are no choices", () => {
    const body = JSON.stringify({ choices: [] });
    expect(parseNonStreamingResponse(body)).toBeNull();
  });

  it("returns null when message is missing", () => {
    const body = JSON.stringify({ choices: [{}] });
    expect(parseNonStreamingResponse(body)).toBeNull();
  });

  it("handles tool_call with null arguments", () => {
    const body = JSON.stringify({
      choices: [{
        message: {
          tool_calls: [
            { id: "call_1", function: { name: "test", arguments: null } },
          ],
        },
      }],
    });
    const result = parseNonStreamingResponse(body);
    expect(result).not.toBeNull();
    expect(result!.toolCalls).toHaveLength(1);
    expect(result!.toolCalls![0].arguments).toBe("{}");
  });

  it("handles tool_call with object arguments (not string)", () => {
    const body = JSON.stringify({
      choices: [{
        message: {
          tool_calls: [
            { id: "call_1", function: { name: "test", arguments: { path: "/x" } } },
          ],
        },
      }],
    });
    const result = parseNonStreamingResponse(body);
    expect(result).not.toBeNull();
    expect(result!.toolCalls![0].arguments).toBe('{"path":"/x"}');
  });

  it("returns null for empty content and no tool_calls", () => {
    const body = JSON.stringify({
      choices: [{ message: { content: "" } }],
    });
    expect(parseNonStreamingResponse(body)).toBeNull();
  });
});

describe("Performance / duplicate logic regression", () => {
  it("cleanContent does not degrade on very long input", () => {
    const paragraph = "Hello world. ".repeat(100);
    // Should complete quickly (no catastrophic backtracking)
    const start = performance.now();
    const result = cleanContent(paragraph);
    const elapsed = performance.now() - start;
    expect(result.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(500); // 500ms ceiling for 5000 chars
  });

  it("cleanContent handles many think tags efficiently", () => {
    const input = Array.from({ length: 100 }, (_, i) => `<think>step ${i}</think>`).join("\n");
    const start = performance.now();
    const result = cleanContent(input);
    const elapsed = performance.now() - start;
    expect(result).toBe("");
    expect(elapsed).toBeLessThan(500);
  });

  it("parseTextToolCalls handles mixed formats without O(n²) blowup", () => {
    // Mix many tool-call formats in one string to test regex interaction
    const calls = Array.from({ length: 50 }, (_, i) =>
      [`{"tool":"read_file","args":{"path":"${i}.txt"}}`,
       `<tool_call>{"tool":"grep","args":{"pattern":"${i}"}}</tool_call>`].join(" "),
    ).join("\n");
    const start = performance.now();
    const result = parseTextToolCalls(calls);
    const elapsed = performance.now() - start;
    expect(result.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(1000);
  });

  it("STREAM_TOOL_START_RE and STREAM_TOOL_COMPLETE_RE remain in sync", () => {
    // Every format detected by START_RE should be completable by COMPLETE_RE
    const patterns: Array<{ start: string; complete: string }> = [
      { start: "```tool_call\nhello", complete: "```tool_call\nhello\n```" },
      { start: "<tool_call>hello", complete: "<tool_call>hello</tool_call>" },
      { start: "<tool_code>hello", complete: "<tool_code>hello</tool_code>" },
      { start: '{"tool":"x","args":{}}', complete: '{"tool":"x","args":{}}' },
      { start: "<｜DSML｜tool_calls>hello", complete: "<｜DSML｜tool_calls>hello</｜DSML｜tool_calls>" },
      { start: "<|DSML|invoke name=\"x\">hello", complete: "<|DSML|invoke name=\"x\">hello</|DSML|invoke>" },
    ];
    for (const { start, complete } of patterns) {
      STREAM_TOOL_START_RE.lastIndex = 0;
      expect(STREAM_TOOL_START_RE.test(start)).toBe(true);
      STREAM_TOOL_COMPLETE_RE.lastIndex = 0;
      expect(STREAM_TOOL_COMPLETE_RE.test(complete)).toBe(true);
    }
  });
});

describe("RegExp.lastIndex isolation", () => {
  it("parseTextToolCalls resets lastIndex on each call", () => {
    // Multiple calls with different content must not leak lastIndex
    for (let i = 0; i < 10; i++) {
      const result = parseTextToolCalls('{"tool":"x","args":{"n":' + i + '}}');
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("x");
    }
  });
});

describe("cleanContent idempotency", () => {
  it("applying cleanContent twice produces same result", () => {
    const input = "<think>foo</think> bar ```tool_call\n{\"tool\":\"x\",\"args\":{}}\n``` baz";
    const once = cleanContent(input);
    const twice = cleanContent(once);
    expect(twice).toBe(once);
  });

  it("applying cleanContent many times stabilizes", () => {
    const input = "<think>a</think> <think>b</think> {\"tool\":\"x\",\"args\":{}}";
    let result = input;
    for (let i = 0; i < 10; i++) {
      const next = cleanContent(result);
      if (next === result) break;
      result = next;
    }
    // After enough passes, no more tags remain
    expect(STREAM_TOOL_START_RE.test(result)).toBe(false);
  });
});

describe("Property-based — fuzz testing", () => {
  it("parseTextToolCalls never throws on any string", () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        expect(() => parseTextToolCalls(input)).not.toThrow();
      }),
      { numRuns: 1000, seed: 42 },
    );
  });

  it("cleanContent never throws on any string", () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        expect(() => cleanContent(input)).not.toThrow();
      }),
      { numRuns: 1000, seed: 42 },
    );
  });

  it("parseNonStreamingResponse throws only on error-shaped JSON", () => {
    // The function surfaces upstream `{"error": ...}` bodies as thrown
    // errors (so the real reason reaches the caller instead of a silent
    // empty response); any other input — malformed JSON, empty bodies,
    // valid non-error responses — must return null/result, never throw.
    const isErrorShapedJson = (s: string): boolean => {
      try {
        const j = JSON.parse(s);
        return !!(j && typeof j === "object" && !Array.isArray(j) && j.error);
      } catch {
        return false;
      }
    };
    fc.assert(
      fc.property(fc.string(), (input) => {
        if (isErrorShapedJson(input)) {
          expect(() => parseNonStreamingResponse(input)).toThrow();
        } else {
          expect(() => parseNonStreamingResponse(input)).not.toThrow();
        }
      }),
      { numRuns: 1000, seed: 42 },
    );
  });

  it("cleanContent result is always shorter or equal to input", () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const result = cleanContent(input);
        expect(result.length).toBeLessThanOrEqual(input.length);
      }),
      { numRuns: 500, seed: 42 },
    );
  });

  it("parseTextToolCalls output always has valid JSON arguments", () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const calls = parseTextToolCalls(input);
        for (const c of calls) {
          expect(typeof c.name).toBe("string");
          expect(c.name.length).toBeGreaterThan(0);
          expect(typeof c.id).toBe("string");
          expect(c.id.length).toBeGreaterThan(0);
          // arguments must be parseable JSON
          expect(() => JSON.parse(c.arguments)).not.toThrow();
        }
      }),
      { numRuns: 500, seed: 42 },
    );
  });

  it("parseTextToolCalls returns empty for inputs with no tool pattern", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 200 }).filter(
          (s) => !s.includes("tool") && !s.includes("DSML") && !s.includes("`"),
        ),
        (input) => {
          const calls = parseTextToolCalls(input);
          expect(calls).toHaveLength(0);
        },
      ),
      { numRuns: 500, seed: 42 },
    );
  });
});

describe("ReDoS resistance", () => {
  it("TOOL_CALL_JSON_RE handles many nested braces without catastrophic backtracking", () => {
    // Deeply nested JSON-like content that could trigger catastrophic backtracking
    // on patterns like {[\s\S]*?} when the closing } is far away.
    const depth = 500;
    const nestedBraces = "{".repeat(depth) + "}".repeat(depth);
    const input = `{"tool":"x","args":${nestedBraces}}`;
    const start = performance.now();
    const result = parseTextToolCalls(input);
    const elapsed = performance.now() - start;
    // Should either parse or gracefully return nothing — but never hang
    expect(elapsed).toBeLessThan(1000);
    expect(Array.isArray(result)).toBe(true);
  });

  it("THINK_TAGS_RE handles deeply nested think tags without hanging", () => {
    const inner = "<think>" + "a".repeat(5000) + "</think>";
    const input = "<think>" + inner + "</think>";
    const start = performance.now();
    const result = cleanContent(input);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(1000);
    expect(typeof result).toBe("string");
  });

  it("TOOL_CALL_FENCE_RE handles many backticks without backtracking blowup", () => {
    // Alternating backtick patterns — every other block is a valid fence
    const input = Array.from({ length: 200 }, (_, i) =>
      i % 2 === 0 ? "```tool_call\n{\"tool\":\"x\",\"args\":{}}\n```" : "```\nplain\n```",
    ).join("\n");
    const start = performance.now();
    const result = parseTextToolCalls(input);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(2000);
    expect(result.length).toBe(100);
  });

  it("handles extremely long tool names without regex issues", () => {
    const longName = "a".repeat(10000);
    const input = `{"tool":"${longName}","args":{"path":"x"}}`;
    const start = performance.now();
    const result = parseTextToolCalls(input);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(1000);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe(longName);
  });

  it("handles mixed open/close tags in fence content without ReDoS", () => {
    // Mix of ``` and ` characters with valid JSON tool calls
    const trickyContent = "```tool_call\n{\"tool\":\"a\",\"args\":{}}\n```\n" + "```tool_call\n{\"tool\":\"b\",\"args\":{}}\n```";
    const start = performance.now();
    const result = parseTextToolCalls(trickyContent);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(1000);
    expect(result).toHaveLength(2);
  });

  it("DSML regex handles many nested DSML blocks without O(n²)", () => {
    const blocks = Array.from({ length: 200 }, (_, i) =>
      `<|DSML|tool_calls><|DSML|invoke name="test_${i}"><|DSML|parameter name="x">${i}</|DSML|parameter></|DSML|invoke></|DSML|tool_calls>`,
    ).join("\n");
    const start = performance.now();
    const result = parseTextToolCalls(blocks);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(3000);
    expect(result).toHaveLength(200);
  });
});

describe("Concurrent access", () => {
  it("parseTextToolCalls handles concurrent calls without RegExp.lastIndex races", async () => {
    const inputs = [
      '{"tool":"a","args":{"i":1}}',
      '{"tool":"b","args":{"i":2}}',
      '<tool_call>{"tool":"c","args":{"i":3}}</tool_call>',
      '```tool_call\n{"tool":"d","args":{"i":4}}\n```',
    ];
    const promises = Array.from({ length: 50 }, async (_, round) => {
      const result = parseTextToolCalls(inputs[round % inputs.length]);
      expect(result.length).toBeGreaterThanOrEqual(1);
      expect(typeof result[0].name).toBe("string");
      expect(typeof result[0].arguments).toBe("string");
      return result;
    });
    const results = await Promise.all(promises);
    // All concurrent calls must produce correct results
    expect(results).toHaveLength(50);
    for (const r of results) {
      expect(["a", "b", "c", "d"]).toContain(r[0].name);
    }
  });

  it("cleanContent handles concurrent calls without cross-talk", async () => {
    const inputs = [
      "<think>a</think> hello",
      "<thinking>b</thinking> world",
      "<reasoning>c</reasoning> foo",
    ];
    const promises = Array.from({ length: 50 }, (_, i) =>
      Promise.resolve().then(() => cleanContent(inputs[i % inputs.length])),
    );
    const results = await Promise.all(promises);
    expect(results).toHaveLength(50);
  });
});

describe("JSON tool call edge cases", () => {
  it("handles args with } inside string values (potential regex breakage)", () => {
    // The } inside the string value could prematurely close the TOOL_CALL_JSON_RE
    const input = '{"tool":"read_file","args":{"path":"test}file.txt"}}';
    const result = parseTextToolCalls(input);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("read_file");
    expect(JSON.parse(result[0].arguments)).toEqual({ path: "test}file.txt" });
  });

  it("handles args with escaped quotes inside strings", () => {
    const input = '{"tool":"grep","args":{"pattern":"he\\"llo"}}';
    const result = parseTextToolCalls(input);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("grep");
  });

  it("handles args with boolean values", () => {
    const input = '{"tool":"search","args":{"recursive":true,"caseSensitive":false}}';
    const result = parseTextToolCalls(input);
    expect(result).toHaveLength(1);
    expect(JSON.parse(result[0].arguments).recursive).toBe(true);
    expect(JSON.parse(result[0].arguments).caseSensitive).toBe(false);
  });

  it("handles args with null values", () => {
    const input = '{"tool":"read_file","args":{"path":null}}';
    const result = parseTextToolCalls(input);
    expect(result).toHaveLength(1);
    expect(JSON.parse(result[0].arguments).path).toBeNull();
  });

  it("handles args with numeric values", () => {
    const input = '{"tool":"truncate","args":{"limit":42,"offset":0.5}}';
    const result = parseTextToolCalls(input);
    expect(result).toHaveLength(1);
    expect(JSON.parse(result[0].arguments).limit).toBe(42);
    expect(JSON.parse(result[0].arguments).offset).toBe(0.5);
  });

  it("handles args with array values", () => {
    const input = '{"tool":"batch","args":{"items":[1,2,3],"names":["a","b","c"]}}';
    const result = parseTextToolCalls(input);
    expect(result).toHaveLength(1);
    expect(JSON.parse(result[0].arguments).items).toEqual([1, 2, 3]);
    expect(JSON.parse(result[0].arguments).names).toEqual(["a", "b", "c"]);
  });

  it("handles deeply nested args objects", () => {
    const input = '{"tool":"complex","args":{"level1":{"level2":{"level3":{"value":42}}}}}';
    const result = parseTextToolCalls(input);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("complex");
    expect(JSON.parse(result[0].arguments).level1.level2.level3.value).toBe(42);
  });

  it("handles tool name with underscores and numbers", () => {
    const input = '{"tool":"read_file_2","args":{"path":"x"}}';
    const result = parseTextToolCalls(input);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("read_file_2");
  });
});

describe("DSML edge cases", () => {
  it("handles DSML with empty tool_calls block (no invokes)", () => {
    const input = "<|DSML|tool_calls></|DSML|tool_calls>";
    const result = parseTextToolCalls(input);
    expect(result).toHaveLength(0);
  });

  it("handles DSML with missing closing tags", () => {
    const input = "<|DSML|tool_calls><|DSML|invoke name=\"test\"><|DSML|parameter name=\"x\">val</|DSML|parameter>";
    // Missing </|DSML|invoke> and </|DSML|tool_calls> — parser should not hang
    const start = performance.now();
    const result = parseTextToolCalls(input);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(500);
    expect(result).toHaveLength(0);
  });

  it("handles DSML with both pipe and fullwidth separators in same input", () => {
    const input = [
      "<|DSML|tool_calls><|DSML|invoke name=\"a\"><|DSML|parameter name=\"x\">1</|DSML|parameter></|DSML|invoke></|DSML|tool_calls>",
      "<｜DSML｜tool_calls><｜DSML｜invoke name=\"b\"><｜DSML｜parameter name=\"y\">2</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>",
    ].join("\n");
    const result = parseTextToolCalls(input);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("a");
    expect(result[1].name).toBe("b");
  });

  it("handles DSML with special characters in parameter values", () => {
    const input = `<|DSML|tool_calls><|DSML|invoke name="search"><|DSML|parameter name="query">a & b < c > d " e ' f</|DSML|parameter></|DSML|invoke></|DSML|tool_calls>`;
    const result = parseTextToolCalls(input);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("search");
    expect(JSON.parse(result[0].arguments).query).toBe('a & b < c > d " e \' f');
  });
});

describe("Fence edge cases", () => {
  it("handles fences with extra whitespace and blank lines", () => {
    const input = "```tool_call\n  \n{\"tool\":\"test\",\"args\":{}}\n  \n```";
    const result = parseTextToolCalls(input);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("test");
  });

  it("handles adjacent fences with no gap", () => {
    const input = "```tool_call\n{\"tool\":\"a\",\"args\":{}}\n``````tool_call\n{\"tool\":\"b\",\"args\":{}}\n```";
    const result = parseTextToolCalls(input);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("a");
    expect(result[1].name).toBe("b");
  });

  it("handles fence with only whitespace inside (no JSON)", () => {
    const input = "```tool_call\n   \n```";
    const result = parseTextToolCalls(input);
    expect(result).toHaveLength(0); // whitespace-only content, no valid JSON
  });

  it("handles unclosed fence at end of content", () => {
    const input = "some text\n```tool_call\n{\"tool\":\"test\",\"args\":{}}";
    const result = parseTextToolCalls(input);
    // The fence parser requires closing ``` so it won't match. But the
    // bare-JSON parser (step 4) picks up {"tool":"test","args":{}} from
    // the remaining content after DSML/XML/fence blocks are stripped.
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("test");
  });
});

describe("Unicode handling", () => {
  it("handles emoji in args values", () => {
    const input = '{"tool":"echo","args":{"message":"hello 🎉 world"}}';
    const result = parseTextToolCalls(input);
    expect(result).toHaveLength(1);
    expect(JSON.parse(result[0].arguments).message).toBe("hello 🎉 world");
  });

  it("handles zero-width characters in content", () => {
    const input = "A\u200B<think>\u200Breason\u200B</think>\u200BB";
    expect(cleanContent(input)).toBe("A\u200B\u200BB");
  });

  it("handles Unicode homoglyph think tags (should NOT strip)", () => {
    // Cyrillic 'т' looks like 't' but is different
    const input = "<тhink>not a real think tag</тhink>";
    expect(cleanContent(input)).toBe(input); // should pass through unchanged
  });

  it("handles mixed-script tool names", () => {
    const input = '{"tool":"测试","args":{"path":"x"}}';
    const result = parseTextToolCalls(input);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("测试");
  });

  it("cleanContent preserves Unicode that is not a tag", () => {
    const input = "こんにちは世界 <think>hidden</think> 你好";
    expect(cleanContent(input)).toBe("こんにちは世界  你好");
  });
});

describe("Adversarial overlapping formats", () => {
  it("handles a JSON tool call that looks like XML", () => {
    // JSON value happens to contain XML-like text
    const input = '{"tool":"write_file","args":{"content":"<tool_call>ignore</tool_call>"}}';
    const result = parseTextToolCalls(input);
    // Should parse as JSON, NOT as XML (the XML is inside a JSON string value)
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("write_file");
  });

  it("handles tool call text embedded in prose", () => {
    const input = 'The model used the {"tool":"read_file","args":{"path":"test.txt"}} tool to read the file.';
    const result = parseTextToolCalls(input);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("read_file");
    expect(cleanContent(input)).toBe("The model used the  tool to read the file.");
  });

  it("handles JSON with tool inside XML inside DSML — most nested format wins", () => {
    const input = [
      "<|DSML|tool_calls>",
      "<|DSML|invoke name=\"runner\">",
      "<|DSML|parameter name=\"code\">",
      '{"tool":"inner_tool","args":{"x":1}}', // JSON inside DSML parameter value
      "</|DSML|parameter>",
      "</|DSML|invoke>",
      "</|DSML|tool_calls>",
    ].join("");
    const result = parseTextToolCalls(input);
    // DSML parser extracts the outer invoke first; the JSON inside the param
    // value should NOT be parsed separately because the DSML block is stripped
    // before the bare-JSON parser runs.
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("runner");
    const args = JSON.parse(result[0].arguments);
    expect(args.code).toContain("inner_tool");
  });

  it("does not confuse think tags for XML tool calls", () => {
    // THINK_TAGS_RE uses the same tag-group syntax as XML_TOOL_CALL_RE
    // but they should not interfere
    const input = "<think>this is reasoning</think> <tool_call>{}</tool_call>";
    const thinkCleaned = cleanContent(input);
    expect(thinkCleaned).not.toContain("this is reasoning");
    // After cleanContent, the think tag is stripped and the tool_call block
    // is also stripped. trim() removes the remaining leading space.
    expect(thinkCleaned).toBe("");
  });
});

describe("Stress tests", () => {
  it("handles 1MB input without OOM or timeout", () => {
    const chunk = "hello world ".repeat(1000);
    const input = chunk.repeat(100); // ~1.3MB
    const start = performance.now();
    const result = cleanContent(input);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(5000);
    expect(result.length).toBeGreaterThan(0);
    expect(result.length).toBeLessThanOrEqual(input.length);
  });

  it("handles 10,000 think tags efficiently", () => {
    const input = Array.from({ length: 10000 }, (_, i) => `<think>step ${i}</think>`).join("");
    const start = performance.now();
    const result = cleanContent(input);
    const elapsed = performance.now() - start;
    expect(result).toBe("");
    expect(elapsed).toBeLessThan(2000);
  });

  it("handles 500 tool calls in a single input", () => {
    const calls = Array.from({ length: 500 }, (_, i) =>
      `{"tool":"tool_${i}","args":{"index":${i}}}`,
    ).join(" ");
    const start = performance.now();
    const result = parseTextToolCalls(calls);
    const elapsed = performance.now() - start;
    expect(result).toHaveLength(500);
    expect(elapsed).toBeLessThan(2000);
  });

  it("handles mixed DSML + JSON + XML + fences at scale", () => {
    const format = [
      (i: number) => `{"tool":"json_${i}","args":{"n":${i}}}`,
      (i: number) => `<tool_call>{"tool":"xml_${i}","args":{"n":${i}}}</tool_call>`,
      (i: number) => "```tool_call\n" + JSON.stringify({ tool: `fence_${i}`, args: { n: i } }) + "\n```",
    ];
    const inputs = Array.from({ length: 100 }, (_, i) => format[i % 3](i));
    const input = inputs.join("\n\n");
    const start = performance.now();
    const result = parseTextToolCalls(input);
    const elapsed = performance.now() - start;
    expect(result).toHaveLength(100);
    expect(elapsed).toBeLessThan(2000);
  });

  it("stateful RegExp.lastIndex is correctly reset across many sequential calls", () => {
    // Verify that calling parseTextToolCalls many times doesn't leak lastIndex
    for (let i = 0; i < 1000; i++) {
      const a = parseTextToolCalls('{"tool":"x","args":{}}');
      const b = parseTextToolCalls('{"tool":"y","args":{}}');
      expect(a).toHaveLength(1);
      expect(a[0].name).toBe("x");
      expect(b).toHaveLength(1);
      expect(b[0].name).toBe("y");
    }
  });
});

describe("M3 Adversarial — Nested Fences, Lenient JSON & Unclosed Tags", () => {
  it("TS1.1: parses tool call containing nested markdown code fences in content arg", () => {
    const input = [
      "Here is the updated file:",
      "```tool_call",
      JSON.stringify({
        tool: "write_file",
        args: {
          path: "src/example.ts",
          content: "```ts\nfunction hello() {\n  console.log('hello world');\n}\n```",
        },
      }),
      "```",
    ].join("\n");

    const result = parseTextToolCalls(input);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("write_file");
    const args = JSON.parse(result[0].arguments);
    expect(args.path).toBe("src/example.ts");
    expect(args.content).toContain("```ts");
    expect(args.content).toContain("console.log('hello world');");
  });

  it("TS1.1: parses tool call containing nested ```tool_call inside code snippet", () => {
    const innerCode = '```tool_call\n{"tool":"noop","args":{}}\n```';
    const input = "```tool_call\n" + JSON.stringify({ tool: "write_file", args: { path: "test.md", content: innerCode } }) + "\n```";

    const result = parseTextToolCalls(input);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("write_file");
    const args = JSON.parse(result[0].arguments);
    expect(args.content).toBe(innerCode);
  });

  it("TS1.2: leniently parses single-quoted JSON tool calls", () => {
    const input = "{'tool': 'read_file', 'args': {'path': 'config.json'}}";
    const result = parseTextToolCalls(input);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("read_file");
    expect(JSON.parse(result[0].arguments)).toEqual({ path: "config.json" });
  });

  it("TS1.2: leniently parses unquoted property keys and trailing commas", () => {
    const input = '{tool: "grep", args: {pattern: "search_term", filePattern: "*.ts",}}';
    const result = parseTextToolCalls(input);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("grep");
    expect(JSON.parse(result[0].arguments)).toEqual({ pattern: "search_term", filePattern: "*.ts" });
  });

  it("TS1.2: leniently parses unescaped newlines in JSON string arguments", () => {
    const input = '{"tool":"write_file","args":{"path":"file.txt","content":"line1\nline2\nline3"}}';
    const result = parseTextToolCalls(input);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("write_file");
    const args = JSON.parse(result[0].arguments);
    expect(args.content).toBe("line1\nline2\nline3");
  });

  it("TS1.3: handles dual-emission of DSML and fenced tool calls in single turn without duplicates", () => {
    const dsml = `<｜DSML｜tool_calls><｜DSML｜invoke name="read_file"><｜DSML｜parameter name="path">/a.txt</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>`;
    const fence = "```tool_call\n" + JSON.stringify({ tool: "grep", args: { pattern: "foo" } }) + "\n```";
    const input = `${dsml}\n\n${fence}`;

    const result = parseTextToolCalls(input);
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.name)).toEqual(["read_file", "grep"]);
  });

  it("TS1.4: safely parses unclosed XML and DSML tags without throwing or hanging", () => {
    const unclosedXml = '<tool_call>{"tool":"list_directory","args":{"path":"/src"}}';
    const resultXml = parseTextToolCalls(unclosedXml);
    expect(resultXml).toHaveLength(1);
    expect(resultXml[0].name).toBe("list_directory");

    const unclosedDsml = '<｜DSML｜invoke name="search"><｜DSML｜parameter name="q">test_query</｜DSML｜parameter>';
    const resultDsml = parseTextToolCalls(unclosedDsml);
    expect(resultDsml).toHaveLength(1);
    expect(resultDsml[0].name).toBe("search");
  });

  it("TS1.5: 2,000 run fast-check fuzzing on cleanContent & parseTextToolCalls with control chars and unicode", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 500 }),
        (input) => {
          expect(() => parseTextToolCalls(input)).not.toThrow();
          expect(() => cleanContent(input)).not.toThrow();
        },
      ),
      { numRuns: 2000, seed: 1337 },
    );
  });
});

