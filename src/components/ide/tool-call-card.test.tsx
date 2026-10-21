// @vitest-environment jsdom
import * as React from "react";
import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ToolCallCard } from "@/components/ide/tool-call-card";
import type { LiveToolCall } from "@/stores/app-store";

afterEach(cleanup);

function shellTc(status: LiveToolCall["status"], resultOverride?: unknown): LiveToolCall {
  return {
    id: "t1",
    name: "run_command",
    args: JSON.stringify({ command: "Test-Path node_modules/jsdom" }),
    parsedArgs: { command: "Test-Path node_modules/jsdom" },
    status,
    result: resultOverride !== undefined
      ? resultOverride
      : status === "error"
      ? { exitCode: 1, stdout: "", stderr: "not found" }
      : { exitCode: 0, stdout: "True", stderr: "" },
  };
}

describe("ToolCallCard — command labels & background states", () => {
  it("labels a failed command as failed, never as executed", () => {
    render(<ToolCallCard tc={shellTc("error")} />);

    expect(screen.getByText("Command failed")).toBeTruthy();
    expect(screen.queryByText("Executed")).toBeNull();
  });

  it("keeps the executed label for successful commands", () => {
    render(<ToolCallCard tc={shellTc("done")} />);

    expect(screen.getByText("Executed")).toBeTruthy();
    expect(screen.queryByText("Command failed")).toBeNull();
  });

  it("labels a background running command as running, never as executed", () => {
    render(
      <ToolCallCard
        tc={shellTc("running", {
          status: "running",
          running: true,
          commandId: "c1:cmd_1",
          command: "npm test",
          note: "Command is running in background",
        })}
      />,
    );

    expect(screen.getByText("Running…")).toBeTruthy();
    expect(screen.queryByText("Executed")).toBeNull();
  });

  it("labels a command with done status but running result payload as running, never as executed", () => {
    render(
      <ToolCallCard
        tc={shellTc("done", {
          status: "running",
          running: true,
          commandId: "c1:cmd_2",
          command: "pytest",
        })}
      />,
    );

    expect(screen.getByText("Running…")).toBeTruthy();
    expect(screen.queryByText("Executed")).toBeNull();
  });

  it("labels a failed non-shell tool as failed", () => {
    render(
      <ToolCallCard
        tc={{
          id: "t2",
          name: "mcp_call",
          args: JSON.stringify({ tool: "do_thing" }),
          parsedArgs: { tool: "do_thing" },
          status: "error",
          result: { error: "server unreachable" },
        }}
      />,
    );

    expect(screen.getByText("Failed")).toBeTruthy();
  });
});
