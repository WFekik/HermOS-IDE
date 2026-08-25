import { describe, it, beforeAll, afterAll } from "vitest";
import {
  parseSseReasoningChunk,
  extractOpenAIUsage,
  extractAnthropicUsage,
} from "@/lib/ai/provider-payloads";
import { tryParseLenientJson, cleanContent, parseTextToolCalls, parseNonStreamingResponse } from "@/lib/ai/tool-call-parser";
import { sanitizeContent } from "@/lib/sanitize-content";
import { measure, assertFast, expectScaling, makeReporter, warmBpe, filler } from "./harness";

/**
 * Budget-based harness for the streaming hot path: SSE chunk parsing, usage
 * extraction, lenient-JSON tool parsing, non-streaming response parsing and
 * content sanitization. These run once per network delta/response — any
 * superlinear regression here makes the whole UI crawl.
 *
 * Run: npm run perf
 */

const rows = makeReporter("bench-stream");

describe("perf: streaming hot path — SSE chunks & usage", () => {
  beforeAll(warmBpe);

  it("parseSseReasoningChunk on 20k streaming chunks", () => {
    const chunks: any[] = [];
    for (let i = 0; i < 20_000; i++) {
      const mod = i % 4;
      if (mod === 0) chunks.push({ reasoning_content: `step ${i} ` + filler(40, i), content: `out ${i} ` + filler(40, i) });
      else if (mod === 1) chunks.push({ thinking: `hidden ${i}` });
      else if (mod === 2) chunks.push({ content: `streamed ${i} ${filler(60, i)}` });
      else chunks.push({ reasoning: `dup ${i}`, content: `dup ${i}` });
    }
    const sample = measure(() => {
      let reasoning = 0;
      let content = 0;
      for (const c of chunks) {
        const parsed = parseSseReasoningChunk(c);
        if (parsed.reasoningDelta) reasoning++;
        if (parsed.contentDelta) content++;
      }
      if (reasoning < 10_000 || content < 5_000) throw new Error("chunk extraction regressed");
    });
    assertFast(sample, 300, "parseSseReasoningChunk × 20k");
    rows.record("stream", "parseSseReasoningChunk × 20k", sample, 300);
  });

  it("extractOpenAIUsage on 10k usage objects", () => {
    const usages = Array.from({ length: 10_000 }, (_, i) => ({
      prompt_tokens: 1000 + i,
      completion_tokens: 200 + (i % 7),
      prompt_tokens_details: i % 3 === 0 ? { cached_tokens: i % 5 } : undefined,
    }));
    const sample = measure(() => {
      let total = 0;
      for (const u of usages) {
        const measured = extractOpenAIUsage(u);
        if (!measured || measured.promptTokens === undefined) throw new Error("usage extraction regressed");
        total += measured.cacheReadTokens ?? 0;
      }
      if (total < 0) throw new Error("unreachable");
    });
    assertFast(sample, 300, "extractOpenAIUsage × 10k");
    rows.record("stream", "extractOpenAIUsage × 10k", sample, 300);
  });

  it("extractAnthropicUsage on 10k usage objects", () => {
    const usages = Array.from({ length: 10_000 }, (_, i) => ({
      input_tokens: 2000 + i,
      output_tokens: 300 + (i % 11),
      cache_read_input_tokens: i % 2 === 0 ? i : undefined,
      cache_creation_input_tokens: i % 4 === 0 ? 512 : undefined,
    }));
    const sample = measure(() => {
      let total = 0;
      for (const u of usages) {
        const measured = extractAnthropicUsage(u);
        if (!measured || measured.promptTokens === undefined) throw new Error("usage extraction regressed");
        total += measured.cacheWriteTokens ?? 0;
      }
      if (total < 0) throw new Error("unreachable");
    });
    assertFast(sample, 300, "extractAnthropicUsage × 10k");
    rows.record("stream", "extractAnthropicUsage × 10k", sample, 300);
  });
});

describe("perf: streaming hot path — tool JSON parsing", () => {
  beforeAll(warmBpe);

  it("tryParseLenientJson on 5k valid + 5k malformed payloads", () => {
    const valid = Array.from({ length: 5_000 }, (_, i) => `{"tool":"read_file","args":{"path":"/repo/src/file-${i}.ts","query":"query ${i}"}}`);
    const malformed = Array.from({ length: 5_000 }, (_, i) => `{"tool":"edit_file","args":{"path":"/repo/src/truncated-${i}.ts","content":"${filler(200, i)}`);
    const sample = measure(() => {
      let parsed = 0;
      for (const s of valid) if (tryParseLenientJson(s)) parsed++;
      for (const s of malformed) if (tryParseLenientJson(s)) throw new Error("should not parse");
      if (parsed !== valid.length) throw new Error("valid corpus regressed");
    });
    assertFast(sample, 1200, "tryParseLenientJson × 10k");
    rows.record("stream", "tryParseLenientJson × 10k", sample, 1200);
  });

  it("parseNonStreamingResponse on 200 mixed JSON responses", () => {
    const body = (i: number): string =>
      JSON.stringify({
        choices: [
          {
            message: {
              role: "assistant",
              content: `I found the answer for request ${i} — here is the fix. ${filler(120, i)}`,
              reasoning_content: `Step ${i}: check the registry first. ${filler(60, i)}`,
              tool_calls:
                i % 2 === 0
                  ? [
                      {
                        id: `call_${i}`,
                        type: "function",
                        function: { name: "grep", arguments: JSON.stringify({ query: `answer-${i}`, path: "." }) },
                      },
                    ]
                  : [],
            },
          },
        ],
      });
    const sample = measure(() => {
      let toolCalls = 0;
      for (let i = 0; i < 200; i++) {
        const parsed = parseNonStreamingResponse(body(i));
        if (!parsed) throw new Error("response lost");
        if (!parsed.content) throw new Error("content lost");
        if (!parsed.thinking) throw new Error("thinking lost");
        if (parsed.toolCalls?.length) toolCalls++;
      }
      if (toolCalls < 95) throw new Error("tool calls lost");
    });
    assertFast(sample, 500, "parseNonStreamingResponse × 200");
    rows.record("stream", "parseNonStreamingResponse × 200", sample, 500);
  });

  it("parseTextToolCalls scales linearly from 256KB to 1MB payloads", () => {
    const body = (scale: number): string => {
      let b = "Here is my analysis.\n\n";
      for (let i = 0; i < 30 * scale; i++) {
        b += `\`\`\`tool_call\n{"tool": "read_file", "args": {"path": "/repo/src/file-${i}.ts", "detail": "${filler(120, i)}"}}\n\`\`\`\n`;
        b += `Then I verified step ${i}: ${filler(640, i)}\n`;
      }
      b += `<tool_call>{"tool": "grep", "args": {"query": "perf", "path": "."}}</tool_call>`;
      return b;
    };
    const points = [
      { size: body(1).length, ms: measure(() => { parseTextToolCalls(body(1)); }, { warmup: 1, runs: 3 }).min },
      { size: body(4).length, ms: measure(() => { parseTextToolCalls(body(4)); }, { warmup: 1, runs: 3 }).min },
    ];
    expectScaling(points, { label: "parseTextToolCalls", maxGrowthPerDouble: 3 });
    const parsed = parseTextToolCalls(body(4));
    if (!parsed || parsed.length < 100) throw new Error("parser regressed");
    const large = points[1];
    rows.record("stream", `parseTextToolCalls ${(large.size / 1024).toFixed(0)}KB`, { min: large.ms, p50: large.ms, max: large.ms, runs: 3 });
  });
});

describe("perf: streaming hot path — content sanitization", () => {
  beforeAll(warmBpe);

  function payload(kb: number): string {
    const block = (id: number) =>
      `### Section ${id}\n\nThe agent **verified** the change with \`npm run build\`.\n\n` +
      `\`\`\`ts\nconst demo = ${id};\n\`\`\`\n\n- one\n- two\n\n` +
      `<a href="javascript:alert(${id})">spam</a><script>evil(${id})</script> emoji 🚀 中文 ${filler(200, id)}\n`;
    const blocks: string[] = [];
    const count = Math.ceil(kb / 1.25);
    for (let i = 0; i < count; i++) blocks.push(block(i));
    return blocks.join("\n\n");
  }

  it("sanitizeContent on a 100KB adversarial payload", () => {
    const html = payload(100);
    const sample = measure(() => {
      const clean = sanitizeContent(html);
      if (clean.length === 0) throw new Error("sanitizer emptied content");
      if (clean.length > html.length * 3) throw new Error("sanitizer expanded content");
    });
    assertFast(sample, 800, "sanitizeContent 100KB");
    rows.record("sanitize", "sanitizeContent 100KB adversarial", sample, 800);
  });

  it("sanitizeContent scales linearly (25KB -> 100KB)", () => {
    const points = [
      { size: payload(25).length, ms: measure(() => sanitizeContent(payload(25))).min },
      { size: payload(100).length, ms: measure(() => sanitizeContent(payload(100))).min },
    ];
    expectScaling(points, { label: "sanitizeContent", maxGrowthPerDouble: 3 });
    rows.record("sanitize", "sanitizeContent scaling 25->100KB", points[1] ? { min: points[1].ms, p50: points[1].ms, max: points[1].ms, runs: 5 } : { min: 0, p50: 0, max: 0, runs: 0 });
  });

  it("cleanContent on adversarial prose with fences and HTML", () => {
    const prose = Array.from({ length: 80 }, (_, i) =>
      `<p>#### Row ${i} <b>bold</b> <script>bad()</script>` + "lorem ipsum dolor sit amet, consectetur adipiscing elit ".repeat(25) + `\`\`\`tool_call\n{"tool":"write_file"}\n\`\`\`\n`,
    ).join("\n\n");
    const sample = measure(() => {
      const out = cleanContent(prose);
      if (out.length === 0) throw new Error("cleaner emptied content");
    });
    assertFast(sample, 800, "cleanContent adversarial");
    rows.record("sanitize", "cleanContent adversarial prose", sample, 800);
  });
});

afterAll(() => rows.report());