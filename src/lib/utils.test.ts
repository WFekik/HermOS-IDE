import { describe, it, expect } from "vitest";
import { cn, parsePartialJson } from "./utils";

describe("cn", () => {
  it("should merge class names correctly", () => {
    expect(cn("foo", "bar")).toBe("foo bar");
  });

  it("should handle conditional classes", () => {
    expect(cn("base", false && "hidden", "visible")).toBe("base visible");
  });

  it("should handle tailwind conflict resolution", () => {
    expect(cn("px-4", "px-2")).toBe("px-2");
  });

  it("should handle empty inputs", () => {
    expect(cn()).toBe("");
  });

  it("should handle null and undefined", () => {
    expect(cn("a", null, "b", undefined, "c")).toBe("a b c");
  });

  it("should handle array inputs", () => {
    expect(cn(["a", "b"], "c")).toBe("a b c");
  });
});

describe("parsePartialJson", () => {


  it("should parse complete JSON", () => {
    expect(parsePartialJson('{"path": "src/lib/workspace.ts"}')).toEqual({
      path: "src/lib/workspace.ts",
    });
  });

  it("should parse JSON with missing closing quote inside a string", () => {
    expect(parsePartialJson('{"path": "src/lib/workspace.t')).toEqual({
      path: "src/lib/workspace.t",
    });
  });

  it("should parse JSON with missing closing brace", () => {
    expect(parsePartialJson('{"path": "src/lib/workspace.ts", "content": "import"')).toEqual({
      path: "src/lib/workspace.ts",
      content: "import",
    });
  });

  it("should parse JSON with trailing colon or comma", () => {
    expect(parsePartialJson('{"path": "src/lib/workspace.ts", "content": ')).toEqual({
      path: "src/lib/workspace.ts",
    });
    expect(parsePartialJson('{"path": "src/lib/workspace.ts", ')).toEqual({
      path: "src/lib/workspace.ts",
    });
  });

  it("should handle nested arrays/objects in partial states", () => {
    expect(parsePartialJson('{"edits": [{"path": "file.ts", "content": "foo"}')).toEqual({
      edits: [{ path: "file.ts", content: "foo" }],
    });
  });

  it("should parse via regex backtracking as fallback", () => {
    expect(parsePartialJson('{"path": "src/lib/workspace.ts", "content": "foo", "broken_key":')).toEqual({
      path: "src/lib/workspace.ts",
      content: "foo",
    });
  });
});

