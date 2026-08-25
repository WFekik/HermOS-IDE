import { describe, it, expect } from "vitest";
import { lookupContextWindow } from "./model-context-windows";

describe("lookupContextWindow", () => {
  it("should return undefined for empty input", () => {
    expect(lookupContextWindow()).toBeUndefined();
    expect(lookupContextWindow("")).toBeUndefined();
  });

  it("should parse k-suffix tokens", () => {
    expect(lookupContextWindow("gpt-4-128k")).toBe(128000);
    expect(lookupContextWindow("claude-200k")).toBe(200000);
    expect(lookupContextWindow("model-32k")).toBe(32000);
  });

  it("should parse K-suffix (uppercase)", () => {
    expect(lookupContextWindow("test-128K")).toBe(128000);
  });

  it("should parse m-suffix tokens", () => {
    expect(lookupContextWindow("model-1m")).toBe(1_000_000);
    expect(lookupContextWindow("gemini-2m")).toBe(2_000_000);
  });

  it("should parse M-suffix (uppercase)", () => {
    expect(lookupContextWindow("test-10M")).toBe(10_000_000);
  });

  it("should return undefined when no suffix is found", () => {
    expect(lookupContextWindow("gpt-4")).toBeUndefined();
    expect(lookupContextWindow("claude-opus")).toBeUndefined();
  });

  it("should handle model IDs with mixed content", () => {
    expect(lookupContextWindow("openai/gpt-4-turbo-128k")).toBe(128000);
    expect(lookupContextWindow("anthropic/claude-3-opus-200k")).toBe(200000);
  });

  it("should return undefined for invalid numbers", () => {
    expect(lookupContextWindow("model-0k")).toBeUndefined();
  });
});
