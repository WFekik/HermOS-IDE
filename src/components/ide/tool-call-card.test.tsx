// @vitest-environment jsdom
import * as React from "react";
import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ToolCallCard } from "@/components/ide/tool-call-card";
import type { LiveToolCall } from "@/stores/app-store";

afterEach(cleanup);

function shellTc(status: LiveToolCall["status"]): LiveToolCall {
  return {
    id: "t1",
    name: "run_command",
    args: JSON.stringify({ command: "Test-Path node_modules/jsdom" }),
    parsedArgs: { command: "Test-Path node_modules/jsdom" },
    status,
    ...(status === "error"
      ? { result: { exitCode: 1, stdout: "", stderr: "not found" } }
      : { result: { exitCode: 0, stdout: "True", stderr: "" } }),
  };
}

describe("ToolCallCard — failed command label", () => {
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
