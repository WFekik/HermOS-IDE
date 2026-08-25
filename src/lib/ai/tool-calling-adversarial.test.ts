import { describe, it, expect, vi } from "vitest";
import { formatZodError, runTool, BUILTIN_TOOLS, toolLockKey } from "./tools";
import { z } from "zod";
import * as browserModule from "@/lib/browser";
import path from "path";

describe("Tool lock key coverage (cross-loop serialization safety)", () => {
  const ctx = { userId: "u1" };

  it("assigns a lock key or explicit null for every built-in tool — none may be undefined", () => {
    const uncovered = BUILTIN_TOOLS.map((t) => t.name).filter(
      (n) => typeof toolLockKey(n, {}, ctx) === "undefined",
    );
    expect(uncovered).toEqual([]);
  });

  it("classifies command lifecycle tools as stateful serial command category", () => {
    const serialKey = toolLockKey("run_command", { command: "npm test" }, ctx);
    expect(serialKey).toBe(toolLockKey("command_stop", { commandId: "x" }, ctx));
    expect(serialKey).toBe(`cmd:${ctx.userId}`);
  });

  it("classifies readers/writers and arbitrary tools as file-system (serialized per path)", () => {
    for (const n of [
      "read_file",
      "write_file",
      "edit_file",
      "multi_edit",
      "grep",
      "read_doc",
      "generate_ppt",
      "generate_doc",
      "generate_pdf",
      "create_skill",
      "mcp_call",
      "plugin_call",
    ]) {
      const key = toolLockKey(n, {}, ctx);
      expect(key === null || typeof key === "string" || Array.isArray(key)).toBe(true);
      expect(key).not.toBeUndefined();
    }
  });

  it("keeps genuinely stateless tools lock-free", () => {
    for (const n of ["web_search", "http_fetch"]) {
      expect(toolLockKey(n, {}, ctx)).toBeNull();
    }
  });
});

describe("Removed tools (no longer in the product)", () => {
  const ctx = { userId: "u1" };
  const REMOVED_TOOLS = [
    "delete_file",
    "command_check",
    "calculate",
    "create_folder",
    "move_file",
    "copy_file",
    "organize_files",
  ];

  it("does not expose any removed tool in BUILTIN_TOOLS", () => {
    const names = new Set(BUILTIN_TOOLS.map((t) => t.name));
    for (const name of REMOVED_TOOLS) {
      expect(names.has(name)).toBe(false);
    }
  });

  it("returns null (no lock category) for removed tool names", () => {
    for (const name of REMOVED_TOOLS) {
      expect(toolLockKey(name, {}, ctx)).toBeNull();
    }
  });
});

describe("Tool lock keys (per-path concurrency control)", () => {
  const ctx = { userId: "u1" };

  it("shares one key between a read and an edit of the SAME path", () => {
    expect(toolLockKey("read_file", { path: "src/a.ts" }, ctx))
      .toBe(toolLockKey("edit_file", { path: "src/a.ts" }, ctx));
  });

  it("gives DIFFERENT paths different keys (parallel-safe)", () => {
    expect(toolLockKey("read_file", { path: "src/a.ts" }, ctx))
      .not.toBe(toolLockKey("edit_file", { path: "src/b.ts" }, ctx));
  });

  it("scopes keys per user", () => {
    expect(toolLockKey("edit_file", { path: "src/a.ts" }, { userId: "u1" }))
      .not.toBe(toolLockKey("edit_file", { path: "src/a.ts" }, { userId: "u2" }));
  });

  it("gives command tools a single serial key per user", () => {
    expect(toolLockKey("run_command", { command: "npm test" }, ctx))
      .toBe(toolLockKey("command_stop", { commandId: "x" }, ctx));
    expect(toolLockKey("run_command", { command: "a" }, { userId: "u1" }))
      .not.toBe(toolLockKey("run_command", { command: "a" }, { userId: "u2" }));
  });

  it("keys browser tools strictly serial per user", () => {
    expect(toolLockKey("browser_click", {}, ctx)).toBe(toolLockKey("browser_open", { url: "x" }, ctx));
  });

  it("treats arbitrary MCP/plugin calls as globally serial per user", () => {
    expect(toolLockKey("mcp_call", { server: "s", tool: "t" }, ctx))
      .toBe(toolLockKey("plugin_call", { plugin: "p" }, ctx));
  });

  it("returns null (lock-free) for stateless tools", () => {
    for (const n of ["web_search", "http_fetch"]) {
      expect(toolLockKey(n, {}, ctx)).toBeNull();
    }
  });

  it("serializes todo read-modify-write tools per user (never overwrite each other)", () => {
    const k = toolLockKey("todo_write", { todos: [] }, ctx);
    expect(k).toBe(`todo:${ctx.userId}`);
    expect(toolLockKey("todo_read", {}, ctx)).toBe(k);
    expect(toolLockKey("todo_clear", {}, ctx)).toBe(k);
    expect(toolLockKey("todo_write", {}, { userId: "u2" })).not.toBe(k);
  });

  it("serializes subagent lifecycle tools per user (spawn cannot race reap bookkeeping)", () => {
    const k = toolLockKey("spawn_subagent", { name: "s", task: "t" }, ctx);
    expect(k).toBe(`subagent:${ctx.userId}`);
    expect(toolLockKey("get_subagent", { id: "x" }, ctx)).toBe(k);
  });

  it("falls back to a wildcard key when a path field is missing", () => {
    expect(toolLockKey("edit_file", {}, ctx)).toBe(`fs:${ctx.userId}:*`);
  });

  it("canonicalizes absolute vs relative spellings of the SAME file to one key", () => {
    const root = path.resolve("ws-root");
    const abs = path.join(root, "src", "a.ts");
    const rooted = { userId: "u1", rootDir: root };
    // Absolute and workspace-relative spellings must not bypass the lock.
    expect(toolLockKey("read_file", { path: "src/a.ts" }, rooted))
      .toBe(toolLockKey("write_file", { path: abs }, rooted));
    // Dot segments and parent traversal that stays inside the root.
    expect(toolLockKey("edit_file", { path: "./src/./a.ts" }, rooted))
      .toBe(toolLockKey("edit_file", { path: "sub/../src/a.ts" }, rooted));
    expect(toolLockKey("read_file", { path: "src/a.ts" }, rooted))
      .not.toBe(toolLockKey("read_file", { path: "src/b.ts" }, rooted));
    // write_file goes through the same canonicalization — absolute and
    // relative spellings of the SAME file share one key, a different
    // path does not.
    expect(toolLockKey("write_file", { path: "src/a.ts" }, rooted))
      .toBe(toolLockKey("write_file", { path: abs }, rooted));
    expect(toolLockKey("write_file", { path: "src/a.ts" }, rooted))
      .not.toBe(toolLockKey("write_file", { path: "src/b.ts" }, rooted));
  });

  it("still normalizes raw paths without a rootDir (backward-compatible)", () => {
    expect(toolLockKey("read_file", { path: "src/a.ts" }, ctx))
      .toBe(toolLockKey("read_file", { path: "src\\a.ts" }, ctx));
  });
});

describe("Empirical Stress-Test: formatZodError & Tool Zod Validation", () => {
  it("formats Zod errors correctly with path and message", () => {
    const TestSchema = z.object({
      path: z.string({ required_error: "Path is required" }),
      count: z.number({ required_error: "Count is required" }),
      nested: z.object({
        field: z.string({ required_error: "Nested field is required" }),
      }),
    });

    const parsed = TestSchema.safeParse({ count: "invalid" });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const formatted = formatZodError(parsed.error);
      expect(formatted).toBe(
        "Invalid arguments: path: Invalid input: expected string, received undefined; count: Invalid input: expected number, received string; nested: Invalid input: expected object, received undefined"
      );
    }
  });

  it("checks Zod error formatting on standard tools when invalid args are passed", async () => {
    // Test read_file with empty args
    const resRead = await runTool("read_file", {});
    expect(resRead.ok).toBe(false);
    expect(resRead.result).toHaveProperty("error");
    expect((resRead.result as { error: string }).error).toMatch(/^Invalid arguments:/);

    // Test write_file with invalid path type
    const resWrite = await runTool("write_file", { path: 123 });
    expect(resWrite.ok).toBe(false);
    expect((resWrite.result as { error: string }).error).toMatch(/^Invalid arguments: path:/);

    // Test edit_file with missing parameters
    const resEdit = await runTool("edit_file", { path: "file.txt" });
    expect(resEdit.ok).toBe(false);
    expect((resEdit.result as { error: string }).error).toMatch(/^Invalid arguments:/);
  });

  it("identifies tools that do NOT use Zod validation or formatZodError", async () => {
    // create_artifact does not use Zod validation schema
    const resArtifact = await runTool("create_artifact", {});
    expect(resArtifact.ok).toBe(false);
    expect((resArtifact.result as { error: string }).error).toBe("path is required for create_artifact");
    expect((resArtifact.result as { error: string }).error).not.toMatch(/^Invalid arguments:/);

    // command_stop has no Zod schema
    const resCmdStop = await runTool("command_stop", { invalidKey: true });
    expect(resCmdStop.ok).toBe(false);
    expect((resCmdStop.result as { error: string }).error).toBe("No user/conversation context.");

    // todo_clear has no Zod schema
    const resTodoClear = await runTool("todo_clear", { invalidKey: true });
    expect(resTodoClear.ok).toBe(false);
    expect((resTodoClear.result as { error: string }).error).toBe("No conversation context.");
  });

  it("empirically verifies tools where safeParse result is IGNORED (validation bypass flaw)", async () => {
    // Spy on browser functions to verify if they get called despite invalid args
    const spyScreenshot = vi.spyOn(browserModule, "browserScreenshot").mockResolvedValue({
      ok: false,
      error: "No active browser session. Open a URL first.",
    });

    // Pass invalid primitive (123) to browser_screenshot
    const resScreenshot = await runTool("browser_screenshot", 123);
    // Notice: safeParse(123) returns failure, BUT it is ignored!
    // So instead of returning { ok: false, result: { error: "Invalid arguments: ..." } },
    // it executes browserScreenshot() and returns browser error!
    expect(spyScreenshot).toHaveBeenCalled();
    expect((resScreenshot.result as { error: string }).error).toBe("No active browser session. Open a URL first.");
    expect((resScreenshot.result as { error: string }).error).not.toMatch(/^Invalid arguments:/);

    // Test browser_extract with invalid primitive
    const spyExtract = vi.spyOn(browserModule, "browserExtractText").mockResolvedValue({
      ok: false,
      error: "No active browser session.",
    });
    const resExtract = await runTool("browser_extract", "invalid_string_args");
    expect(spyExtract).toHaveBeenCalled();
    expect((resExtract.result as { error: string }).error).not.toMatch(/^Invalid arguments:/);

    // Test browser_go_back with invalid primitive
    const spyBack = vi.spyOn(browserModule, "browserGoBack").mockResolvedValue({
      ok: false,
      error: "No active browser session.",
    });
    const resBack = await runTool("browser_go_back", 9999);
    expect(spyBack).toHaveBeenCalled();
    expect((resBack.result as { error: string }).error).not.toMatch(/^Invalid arguments:/);

    // Test browser_go_forward with invalid primitive
    const spyForward = vi.spyOn(browserModule, "browserGoForward").mockResolvedValue({
      ok: false,
      error: "No active browser session.",
    });
    const resForward = await runTool("browser_go_forward", false);
    expect(spyForward).toHaveBeenCalled();
    expect((resForward.result as { error: string }).error).not.toMatch(/^Invalid arguments:/);

    // Test todo_read with invalid primitive
    const resTodoRead = await runTool("todo_read", 12345);
    // todoReadSchema.safeParse(args) is called but ignored, proceeds to check ctx
    expect(resTodoRead.ok).toBe(false);
    expect((resTodoRead.result as { error: string }).error).toBe("No conversation context (no todos to read).");
    expect((resTodoRead.result as { error: string }).error).not.toMatch(/^Invalid arguments:/);
  });

  it("checks validation error behavior across ALL built-in tools", async () => {
    const invalidResults: Record<string, { ok: boolean; error: string; usesFormatZodError: boolean }> = {};

    for (const tool of BUILTIN_TOOLS) {
      // Pass invalid types (e.g. integer 12345 or empty object {}) to test validation response
      const res = await runTool(tool.name, 12345);
      const errorMsg = (res.result as { error?: string })?.error ?? "";
      const usesFormatZodError = errorMsg.startsWith("Invalid arguments:");
      invalidResults[tool.name] = {
        ok: res.ok,
        error: errorMsg,
        usesFormatZodError,
      };
    }

    // Verify all results return ok: false
    for (const [name, res] of Object.entries(invalidResults)) {
      expect(res.ok).toBe(false);
    }

    // Identify tools using formatZodError vs bypassing/custom handling
    const withZodFormat = Object.keys(invalidResults).filter((name) => invalidResults[name].usesFormatZodError);
    const withoutZodFormat = Object.keys(invalidResults).filter((name) => !invalidResults[name].usesFormatZodError);

    expect(withoutZodFormat).toContain("create_artifact");
    expect(withoutZodFormat).toContain("command_stop");
    expect(withoutZodFormat).toContain("browser_screenshot");
    expect(withoutZodFormat).toContain("browser_extract");
    expect(withoutZodFormat).toContain("browser_go_back");
    expect(withoutZodFormat).toContain("browser_go_forward");
    expect(withoutZodFormat).toContain("todo_read");
    expect(withoutZodFormat).toContain("todo_clear");
  });
});

describe("Empirical Stress-Test: Browser Tool Return Value Structures", () => {
  it("verifies return structure for browser_open", async () => {
    // Test success case
    vi.spyOn(browserModule, "browserOpen").mockResolvedValueOnce({
      ok: true,
      session: { id: "s1", url: "https://example.com", title: "Example", createdAt: 100 },
      title: "Example",
      snapshot: "Page snapshot",
    });

    const resSuccess = await runTool("browser_open", { url: "https://example.com" });
    expect(resSuccess).toEqual({
      ok: true,
      result: {
        session: { id: "s1", url: "https://example.com", title: "Example", createdAt: 100 },
        title: "Example",
        snapshot: "Page snapshot",
      },
    });

    // Test error case
    vi.spyOn(browserModule, "browserOpen").mockResolvedValueOnce({
      ok: false,
      error: "Failed to open page",
    });

    const resError = await runTool("browser_open", { url: "https://example.com" });
    expect(resError).toEqual({
      ok: false,
      result: { error: "Failed to open page" },
    });
  });

  it("verifies return structure for browser_click", async () => {
    vi.spyOn(browserModule, "browserClick").mockResolvedValueOnce({
      ok: true,
      snapshot: "Click snapshot",
    });

    const res = await runTool("browser_click", { ref: "@e1" });
    expect(res).toEqual({
      ok: true,
      result: { snapshot: "Click snapshot" },
    });

    // Error case
    vi.spyOn(browserModule, "browserClick").mockResolvedValueOnce({
      ok: false,
      error: "Invalid ref",
    });
    const resErr = await runTool("browser_click", { ref: "@e1" });
    expect(resErr).toEqual({
      ok: false,
      result: { error: "Invalid ref" },
    });
  });

  it("verifies return structure for browser_type", async () => {
    vi.spyOn(browserModule, "browserType").mockResolvedValueOnce({
      ok: true,
      snapshot: "Type snapshot",
    });

    const res = await runTool("browser_type", { ref: "@e1", text: "hello" });
    expect(res).toEqual({
      ok: true,
      result: { snapshot: "Type snapshot" },
    });
  });

  it("verifies return structure for browser_screenshot (dataUrl projection)", async () => {
    vi.spyOn(browserModule, "browserScreenshot").mockResolvedValueOnce({
      ok: true,
      path: "/tmp/screen.png",
      base64: "abc123base64",
      dataUrl: "data:image/png;base64,abc123base64",
    });

    const res = await runTool("browser_screenshot", {});
    // Verify that runTool projects ONLY dataUrl into result, omitting path and base64
    expect(res).toEqual({
      ok: true,
      result: { dataUrl: "data:image/png;base64,abc123base64" },
    });
  });

  it("verifies return structure for browser_scroll", async () => {
    vi.spyOn(browserModule, "browserScroll").mockResolvedValueOnce({
      ok: true,
      snapshot: "Scroll snapshot",
    });

    const res = await runTool("browser_scroll", { direction: "down", px: 100 });
    expect(res).toEqual({
      ok: true,
      result: { snapshot: "Scroll snapshot" },
    });
  });

  it("verifies return structure for browser_press", async () => {
    vi.spyOn(browserModule, "browserPress").mockResolvedValueOnce({
      ok: true,
      snapshot: "Press snapshot",
    });

    const res = await runTool("browser_press", { key: "Enter" });
    expect(res).toEqual({
      ok: true,
      result: { snapshot: "Press snapshot" },
    });
  });

  it("verifies return structure for browser_extract", async () => {
    vi.spyOn(browserModule, "browserExtractText").mockResolvedValueOnce({
      ok: true,
      text: "Extracted page text",
    });

    const res = await runTool("browser_extract", {});
    expect(res).toEqual({
      ok: true,
      result: { text: "Extracted page text" },
    });
  });

  it("verifies return structure for browser_go_back", async () => {
    vi.spyOn(browserModule, "browserGoBack").mockResolvedValueOnce({
      ok: true,
      snapshot: "Back snapshot",
    });

    const res = await runTool("browser_go_back", {});
    expect(res).toEqual({
      ok: true,
      result: { snapshot: "Back snapshot" },
    });
  });

  it("verifies return structure for browser_go_forward", async () => {
    vi.spyOn(browserModule, "browserGoForward").mockResolvedValueOnce({
      ok: true,
      snapshot: "Forward snapshot",
    });

    const res = await runTool("browser_go_forward", {});
    expect(res).toEqual({
      ok: true,
      result: { snapshot: "Forward snapshot" },
    });
  });

  it("verifies that all browser tools strictly follow the ToolResult envelope { ok: boolean, result: ... }", async () => {
    const browserTools = [
      "browser_open",
      "browser_click",
      "browser_type",
      "browser_screenshot",
      "browser_extract",
      "browser_go_back",
      "browser_go_forward",
      "browser_scroll",
      "browser_press",
      "browser_close",
    ];

    for (const toolName of browserTools) {
      const res = await runTool(toolName, { url: "invalid-url", ref: "bad", direction: "bad", key: "" });
      expect(res).toHaveProperty("ok");
      expect(typeof res.ok).toBe("boolean");
      expect(res).toHaveProperty("result");
      expect(typeof res.result).toBe("object");
    }
  });
});
