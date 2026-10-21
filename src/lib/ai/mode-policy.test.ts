import { describe, it, expect } from "vitest";
import {
  architectAllowedTools,
  architectReadOnlyTools,
  modeToolDenyReason,
} from "./mode-policy";

describe("modeToolDenyReason", () => {
  it("blocks every tool in chat mode", () => {
    expect(modeToolDenyReason("chat", "read_file")).toMatch(/Chat mode/);
    expect(modeToolDenyReason("chat", "run_command")).toMatch(/Chat mode/);
  });

  it("blocks mutating tools in architect mode", () => {
    for (const tool of [
      "run_command",
      "command_stop",
      "write_file",
      "edit_file",
      "multi_edit",
      "browser_click",
      "browser_type",
      "http_fetch",
    ]) {
      expect(modeToolDenyReason("architect", tool)).toMatch(/Architect mode/);
    }
  });

  it("allows read-only and orchestration tools in architect mode", () => {
    for (const tool of [
      "read_file",
      "list_directory",
      "grep",
      "web_search",
      "create_artifact",
      "spawn_subagent",
      "get_subagent",
    ]) {
      expect(modeToolDenyReason("architect", tool)).toBeNull();
    }
  });

  it("allows everything in agent mode", () => {
    for (const tool of ["read_file", "run_command", "write_file", "browser_click"]) {
      expect(modeToolDenyReason("agent", tool)).toBeNull();
    }
  });

  it("keeps the architect catalog anchored to read-only classification", () => {
    const readOnly = architectReadOnlyTools();
    const allowed = architectAllowedTools();
    expect(readOnly.size).toBeGreaterThan(0);
    for (const tool of readOnly) {
      expect(allowed.has(tool)).toBe(true);
    }
    expect(allowed.has("create_artifact")).toBe(true);
    expect(allowed.has("run_command")).toBe(false);
    // Lazy catalogs must be stable across calls.
    expect(architectReadOnlyTools()).toBe(readOnly);
    expect(architectAllowedTools()).toBe(allowed);
  });
});
