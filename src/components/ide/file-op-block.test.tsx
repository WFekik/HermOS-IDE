// @vitest-environment jsdom
import * as React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FileOpBlock } from "@/components/ide/message-renderer";
import type { LiveToolCall } from "@/stores/app-store";

vi.mock("@/components/ide/code-block", () => ({
  CodeBlock: ({ value }: { value: string }) => (
    <pre data-testid="code-mock">{String(value).slice(0, 40)}</pre>
  ),
}));

afterEach(cleanup);

function writeTc(status: LiveToolCall["status"], name = "write_file"): LiveToolCall {
  return {
    id: "w1",
    name,
    args: JSON.stringify({ path: "src/foo.ts", content: "const x = 1;\n" }),
    parsedArgs: { path: "src/foo.ts", content: "const x = 1;\n" },
    status,
    ...(status === "done"
      ? { result: { created: true, newContent: "const x = 1;\n", path: "src/foo.ts" }, ok: true }
      : {}),
  };
}

function readTc(): LiveToolCall {
  return { id: "r1", name: "read_file", args: "{}", status: "running" };
}

describe("FileOpBlock — manual expand/collapse", () => {
  it("starts collapsed while running (no auto-expand)", () => {
    render(<FileOpBlock tc={writeTc("running")} />);
    expect(screen.getByRole("button", { name: /expand/i })).toBeTruthy();
    expect(screen.queryByTestId("code-mock")).toBeNull();
  });

  it("toggle opens the live preview while running", async () => {
    render(<FileOpBlock tc={writeTc("running")} />);
    fireEvent.click(screen.getByRole("button", { name: /expand/i }));
    expect(await screen.findByText(/Streaming src\/foo\.ts/)).toBeTruthy();
    expect(screen.getByTestId("code-mock")).toBeTruthy();
  });

  it("stays collapsed across a running→done status change", async () => {
    const { rerender } = render(<FileOpBlock tc={writeTc("running")} />);
    fireEvent.click(screen.getByRole("button", { name: /expand/i }));
    await screen.findByText(/Streaming/);
    fireEvent.click(screen.getByRole("button", { name: /collapse/i }));
    await waitFor(() => expect(screen.queryByTestId("code-mock")).toBeNull());
    rerender(<FileOpBlock tc={writeTc("done")} />);
    expect(screen.getByRole("button", { name: /expand/i })).toBeTruthy();
    expect(screen.queryByTestId("code-mock")).toBeNull();
  });

  it("shows the NEW badge for a created file when expanded", async () => {
    render(<FileOpBlock tc={writeTc("done")} />);
    expect(screen.getByRole("button", { name: /expand/i })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /expand/i }));
    expect(await screen.findByText("NEW")).toBeTruthy();
    expect(screen.getByTestId("code-mock")).toBeTruthy();
  });

  it("shows the DELETED badge for delete ops", () => {
    render(
      <FileOpBlock
        tc={{ id: "d1", name: "delete", args: JSON.stringify({ path: "src/old.ts" }), status: "done", result: { deleted: true }, ok: true }}
      />
    );
    expect(screen.getByText("DELETED")).toBeTruthy();
  });

  it("treats other file-op tools (write_to_file) as toggleable blocks", () => {
    render(<FileOpBlock tc={writeTc("running", "write_to_file")} />);
    expect(screen.getByRole("button", { name: /expand/i })).toBeTruthy();
  });

  it("read_file (no-toggle) never renders expanded content", () => {
    render(<FileOpBlock tc={readTc()} />);
    expect(screen.queryByTestId("code-mock")).toBeNull();
    fireEvent.click(screen.getByRole("button"));
    expect(screen.queryByTestId("code-mock")).toBeNull();
  });
});
