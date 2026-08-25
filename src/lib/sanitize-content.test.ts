import { describe, it, expect } from "vitest";
import {
  sanitizeContent,
  sanitizeStreamingDelta,
  extractThinkingAndContent,
  stripEmojis,
} from "./sanitize-content";

describe("sanitizeContent", () => {
  it("should return empty string for empty input", () => {
    expect(sanitizeContent("")).toBe("");
  });

  it("should strip ```tool_call fenced blocks", () => {
    const input = "Here's the file:\n```tool_call\nread_file(\"src/index.ts\")\n```\nDone.";
    const result = sanitizeContent(input);
    expect(result).not.toContain("tool_call");
    expect(result).toContain("Here's the file");
    expect(result).toContain("Done.");
  });

  it("should strip unclosed ```tool_call blocks to end of string", () => {
    const input = "Thinking...\n```tool_call\nread_file(\"src/index.ts\")";
    const result = sanitizeContent(input);
    expect(result).toBe("Thinking...");
  });

  it("should strip <tool_call> XML tags", () => {
    const input = 'Using tool\n<tool_call>\n{"tool":"grep","args":{}}\n</tool_call>\nResult: found.';
    const result = sanitizeContent(input);
    expect(result).not.toContain("tool_call");
    expect(result).toContain("Result:");
  });

  it("should strip <think> tags and extract content only", () => {
    // When thinking is extracted via extractThinkingAndContent first,
    // sanitizeContent strips the remaining tag markers
    const input = "I think <think>this is my reasoning</think> the answer is 42.";
    const result = sanitizeContent(input);
    expect(result).not.toContain("<think>");
    expect(result).not.toContain("</think>");
    expect(result).toContain("the answer is 42.");
  });

  it("should strip Tool result lines", () => {
    const input = 'Tool "read_file" result (ok=true): src/file.ts\nNext line';
    const result = sanitizeContent(input);
    expect(result).not.toContain("Tool");
    expect(result).toBe("Next line");
  });

  it("should strip bare tool_result: prefix lines", () => {
    const input = "tool_result: some output\nRemaining text";
    const result = sanitizeContent(input);
    expect(result).not.toContain("tool_result");
    expect(result).toBe("Remaining text");
  });

  it("should strip bare tool name lines followed by narration", () => {
    const input = "read_file\nI'll read the file now.\nSome content";
    const result = sanitizeContent(input);
    expect(result).toContain("I'll read the file now.");
    expect(result).not.toContain("read_file\nI'll");
  });

  it("should strip model self-instruction lines", () => {
    const input = "Some text [Response interrupted by user] more text";
    const result = sanitizeContent(input);
    expect(result).not.toContain("[Response interrupted");
  });

  it("should strip bare JSON tool calls", () => {
    const input = 'Some text {"tool":"grep","args":{"pattern":"foo"}} more text';
    const result = sanitizeContent(input);
    expect(result).not.toContain('"tool"');
    expect(result).toBe("Some text more text");
  });

  it("should strip DSML tool call tags with flexible spaces around pipes", () => {
    const input = 'Before < | DSML | tool_calls >< | DSML | invoke name="run_command">< | DSML | parameter name="command" string="true">dir /s</ | DSML | parameter></ | DSML | invoke></ | DSML | tool_calls > After';
    const result = sanitizeContent(input);
    expect(result).not.toContain("DSML");
    expect(result).toBe("Before After");
  });

  it("does not truncate user text containing an unclosed think literal mid-sentence", () => {
    const input = "The user asked: what does <think> mean in XML? Here is the answer.";
    const result = sanitizeContent(input);
    expect(result).toContain("Here is the answer.");
  });

  it("strips a real unclosed thinking block at the start of the message", () => {
    const input =
      "<think>I need to carefully analyze the codebase structure before\n" +
      "deciding on the module layout, so let me explore first...";
    const result = sanitizeContent(input);
    expect(result).toBe("");
  });

  it("strips an unclosed thinking block standing alone on its own line", () => {
    const input = "Let me investigate.\n<thinking>unclosed reasoning still in progress\nMore text after.";
    const result = sanitizeContent(input);
    expect(result).toBe("Let me investigate.");
  });

  it("preserves unclosed think text inside markdown code fences", () => {
    const input =
      "Here is an example:\n```html\n<think>unclosed template placeholder\n```\nAfter fence.";
    const result = sanitizeContent(input);
    expect(result).toContain("<think>");
    expect(result).toContain("unclosed template placeholder");
    expect(result).toContain("After fence.");
  });

  it("handles many embedded JSON blocks in a single pass without error", () => {
    const line = 'Here is some text {"tool":"grep","args":{"pattern":"foo"}} more text\n';
    const result = sanitizeContent(line.repeat(500));
    expect(result).not.toContain('"tool"');
    expect(result.split("Here is some text").length - 1).toBe(500);
    expect(result).toContain("more text");
  });

  it("should collapse 3+ consecutive newlines", () => {
    const input = "a\n\n\n\nb";
    const result = sanitizeContent(input);
    expect(result).toBe("a\n\nb");
  });

  it("should trim leading/trailing whitespace", () => {
    const result = sanitizeContent("  hello world  ");
    expect(result).toBe("hello world");
  });

  it("should be idempotent", () => {
    const input = 'Here is the file\n```tool_call\nread_file("x")\n```\nDone.\n';
    const first = sanitizeContent(input);
    const second = sanitizeContent(first);
    expect(second).toBe(first);
  });

  it("should handle complex multi-tool output", () => {
    const input = [
      "I'll explore the codebase first.",
      "",
      'read_file',
      "I'll check the main file:",
      "",
      '<tool_call>{"tool":"read_file","args":{"path":"src/main.ts"}}</tool_call>',
      "",
      'Tool "read_file" result (ok=true): src/main.ts',
      "",
      "The file exports a `run()` function.",
    ].join("\n");
    const result = sanitizeContent(input);
    expect(result).toContain("explore the codebase");
    expect(result).toContain("The file exports");
    expect(result).not.toContain("tool_call");
    expect(result).not.toContain("read_file\n");
  });

  it("should strip decorative emojis", () => {
    const result = sanitizeContent("Hello 😊 world 👍 done");
    expect(result).toBe("Hello world done");
  });

  it("should handle multiple consecutive stripping patterns", () => {
    const input = [
      '<think>Let me reason about this</think>',
      'I need to search the codebase.',
      '',
      'grep',
      "I'll search for the pattern.",
      '',
      '{"tool":"grep","args":{"pattern":"foo"}}',
      '',
      'Tool "grep" result (ok=true): found 3 matches',
      '',
      'The results are: file1.ts, file2.ts',
    ].join("\n");
    const result = sanitizeContent(input);
    expect(result).toContain("The results are");
    expect(result).not.toContain("<think>");
    expect(result).not.toContain('{"tool"');
    expect(result).not.toContain('Tool "grep"');
  });
});

describe("sanitizeStreamingDelta", () => {
  it("should return empty string for empty delta", () => {
    expect(sanitizeStreamingDelta("")).toBe("");
  });

  it("should strip closed ```tool_call blocks only", () => {
    const delta = "```tool_call\nread_file(\"x\")\n```\n";
    const result = sanitizeStreamingDelta(delta);
    expect(result).not.toContain("tool_call");
  });

  it("should NOT strip unclosed ```tool_call blocks (streaming safety)", () => {
    const delta = "```tool_call\nread_file(\"x\"";
    // Keep it as-is because the closing ``` might be in the next chunk
    const result = sanitizeStreamingDelta(delta);
    // Hmm actually looking at the code more carefully, the regex is:
    // /```tool_call[^\n]*\n[\s\S]*?```/g
    // This only matches if the closing ``` is present, so unclosed stays
    expect(result).toContain("```tool_call");
  });

  it("should strip closed think tags", () => {
    const delta = "<think>some reasoning</think> visible text";
    const result = sanitizeStreamingDelta(delta);
    expect(result).not.toContain("<think>");
    expect(result).not.toContain("</think>");
    expect(result).toContain("visible text");
  });

  it("should strip tool result lines (single-line safe patterns)", () => {
    const delta = 'Tool "read_file" result (ok=true): x\nnext';
    const result = sanitizeStreamingDelta(delta);
    // The line is removed but the newline remains; trim to get clean output
    expect(result.trim()).toBe("next");
  });

  it("should be idempotent", () => {
    const delta = 'Tool "grep" result: found\n<think>ok</think> done\n';
    const first = sanitizeStreamingDelta(delta);
    const second = sanitizeStreamingDelta(first);
    expect(second).toBe(first);
  });
});

describe("extractThinkingAndContent", () => {
  it("should return empty thinking and content for empty input", () => {
    const result = extractThinkingAndContent("");
    expect(result.thinking).toBe("");
    expect(result.content).toBe("");
  });

  it("should extract <think> tags and return cleaned content", () => {
    const input = "Let me think: <think>I need to consider edge cases</think> The answer is 42.";
    const result = extractThinkingAndContent(input);
    expect(result.thinking).toBe("I need to consider edge cases");
    // Tag removal may leave extra whitespace; trim result to compare
    expect(result.content.replace(/\s{2,}/g, " ")).toBe("Let me think: The answer is 42.");
  });

  it("should handle multiple think tag formats", () => {
    const input = "<reasoning>Step 1: analyze</reasoning> Result. <thinking>Step 2: implement</thinking> Done.";
    const result = extractThinkingAndContent(input);
    expect(result.thinking).toContain("Step 1: analyze");
    expect(result.thinking).toContain("Step 2: implement");
    expect(result.content.replace(/\s{2,}/g, " ")).toBe("Result. Done.");
  });

  it("should append to existing thinking", () => {
    const result = extractThinkingAndContent("<think>new thought</think>", "existing thought");
    expect(result.thinking).toContain("existing thought");
    expect(result.thinking).toContain("new thought");
  });

  it("should handle unclosed think tags gracefully", () => {
    const input = "Before <think>incomplete";
    const result = extractThinkingAndContent(input);
    // Unclosed tags are NOT stripped by extractThinkingAndContent (only closed ones are)
    // The closing tag regex doesn't match standalone <think> without </think>
    expect(result.content).toBe(input);
    expect(result.thinking).toBe("");
  });

  it("should handle <cot> and <details> tags", () => {
    const input = "<cot>chain of thought</cot> result. <details>extra details</details> final.";
    const result = extractThinkingAndContent(input);
    expect(result.thinking).toContain("chain of thought");
    expect(result.thinking).toContain("extra details");
    expect(result.content.replace(/\s{2,}/g, " ")).toBe("result. final.");
  });
});

describe("stripEmojis", () => {
  it("should return empty string for empty input", () => {
    expect(stripEmojis("")).toBe("");
  });

  it("should strip common emojis and collapse extra spaces", () => {
    // stripEmojis removes the emoji, then collapses 2+ spaces to 1
    expect(stripEmojis("hello 😊 world")).toBe("hello world");
  });

  it("should clean up multiple spaces left by emoji removal", () => {
    const result = stripEmojis("a😊b");
    expect(result).toBe("ab");
  });

  it("should clean up empty bold markers", () => {
    expect(stripEmojis("** **")).toBe("");
    expect(stripEmojis("__ __")).toBe("");
  });

  it("should preserve non-emoji text", () => {
    expect(stripEmojis("hello world 123")).toBe("hello world 123");
  });
});
