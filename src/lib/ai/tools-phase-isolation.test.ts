import { describe, it, expect } from "vitest";
import { isReadOnlyTool, isWriteTool } from "@/lib/permissions";
import { BUILTIN_TOOLS } from "@/lib/ai/tools";

describe("Tool read/write classification", () => {
  it("correctly identifies read-only tools", () => {
    expect(isReadOnlyTool("read_file")).toBe(true);
    expect(isReadOnlyTool("grep")).toBe(true);
    expect(isReadOnlyTool("glob")).toBe(true);
    expect(isReadOnlyTool("list_directory")).toBe(true);
    expect(isReadOnlyTool("web_search")).toBe(true);
    // http_fetch is gated as ask mode by default to prevent silent exfiltration
    expect(isReadOnlyTool("http_fetch")).toBe(false);

    expect(isReadOnlyTool("edit_file")).toBe(false);
    expect(isReadOnlyTool("write_file")).toBe(false);
    expect(isReadOnlyTool("run_command")).toBe(false);
    expect(isReadOnlyTool("command_stop")).toBe(false);
  });

  it("correctly identifies state-modifying write/command tools", () => {
    expect(isWriteTool("write_file")).toBe(true);
    expect(isWriteTool("edit_file")).toBe(true);
    expect(isWriteTool("multi_edit")).toBe(true);
    expect(isWriteTool("todo_write")).toBe(true);
    expect(isWriteTool("run_command")).toBe(true);

    expect(isWriteTool("read_file")).toBe(false);
    expect(isWriteTool("grep")).toBe(false);
  });

  // Tool execution is STRICTLY SEQUENTIAL in both executor loops (no more
  // parallel read phases), so the only concurrency control left is the
  // per-resource tool lock across loops. This invariant guards the
  // classification that read-only subagents / architect mode rely on.
  it("never classifies a built-in tool as both read-only and write", () => {
    for (const t of BUILTIN_TOOLS) {
      const readOnly = isReadOnlyTool(t.name);
      const write = isWriteTool(t.name);
      if (t.name === "create_artifact") {
        // Design: it maps to file.read (cheap approval) but also counts as a
        // write (it produces an artifact file), so both are true on purpose.
        expect(write).toBe(true);
        continue;
      }
      expect(readOnly && write, `${t.name} classified as both read-only and write`).toBe(false);
    }
  });
});
