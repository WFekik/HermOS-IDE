// @vitest-environment jsdom
import * as React from "react";
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MessageRenderer } from "@/components/ide/message-renderer";
import { useAppStore, type UIMessage } from "@/stores/app-store";

afterEach(cleanup);

beforeEach(() => {
  useAppStore.setState({ language: "en", thinkingExpanded: {} });
});

function turn(latencyMs: number | undefined): UIMessage {
  return {
    id: "m1",
    role: "assistant",
    content: "All done.",
    thinking: "Checking the project.",
    createdAt: new Date().toISOString(),
    latencyMs,
    liveToolCalls: [
      { id: "t1", name: "read_file", args: JSON.stringify({ path: "a.ts" }), parsedArgs: { path: "a.ts" }, status: "done" },
    ],
  } as unknown as UIMessage;
}

describe("AgentWorkBlock — worked-for duration", () => {
  it("renders a bare 'Worked' when the persisted latency is 0", () => {
    render(<MessageRenderer message={turn(0)} />);

    expect(screen.getByText(/^Worked\b/)).toBeTruthy();
    expect(screen.queryByText(/0ms/)).toBeNull();
  });

  it("renders a bare 'Worked' when latency is missing", () => {
    render(<MessageRenderer message={turn(undefined)} />);

    expect(screen.getByText(/^Worked\b/)).toBeTruthy();
    expect(screen.queryByText(/0ms/)).toBeNull();
  });

  it("keeps the duration for measured turns", () => {
    render(<MessageRenderer message={turn(2_500)} />);

    expect(screen.getByText(/Worked for 2\.5s/)).toBeTruthy();
  });
});
