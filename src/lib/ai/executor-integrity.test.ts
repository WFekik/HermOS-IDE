import { describe, it, expect, vi } from "vitest";
import { buildCompletionIntegrityNudge, streamOpenAICompatible } from "@/lib/ai/executor";
import type { ToolCall } from "@/lib/types";

function call(partial: Partial<ToolCall>): ToolCall {
  return {
    id: "call_1",
    name: "run_command",
    args: {},
    status: "done",
    ...partial,
  };
}

function failedCall(id: string, name = "run_command", path?: string, error = "exit code 1"): ToolCall {
  return {
    id,
    name,
    args: path !== undefined ? { path } : {},
    status: "error",
    result: { error },
  };
}

describe("buildCompletionIntegrityNudge", () => {
  it("returns null when there are no tool calls", () => {
    expect(buildCompletionIntegrityNudge([])).toBeNull();
  });

  it("returns null when every call succeeded", () => {
    const calls = [
      call({ id: "a", name: "read_file", args: { path: "src/a.ts" }, status: "done" }),
      call({ id: "b", name: "run_command", args: { command: "npm test" }, status: "done" }),
    ];
    expect(buildCompletionIntegrityNudge(calls)).toBeNull();
  });

  it("lists unresolved failures with tool, path and error", () => {
    const calls = [failedCall("c1", "run_command", "src/a.ts", "exit code 1")];
    const nudge = buildCompletionIntegrityNudge(calls);
    expect(nudge).not.toBeNull();
    expect(nudge!).toContain("- run_command(src/a.ts): exit code 1");
    expect(nudge!).toContain("Address them or acknowledge them before completing");
  });

  it("falls back to the command when args use command instead of path", () => {
    const calls = [failedCall("c1", "run_command", undefined, "exit code 2")];
    const nudge = buildCompletionIntegrityNudge([
      { ...calls[0], args: { command: "npm run build" } },
    ]);
    expect(nudge).not.toBeNull();
    expect(nudge!).toContain("- run_command(npm run build): exit code 2");
  });

  it("returns null when the failure was retried successfully later (same tool + path)", () => {
    const calls = [
      failedCall("c1", "read_file", "src/a.ts"),
      call({ id: "c2", name: "read_file", args: { path: "src/a.ts" }, status: "done" }),
    ];
    expect(buildCompletionIntegrityNudge(calls)).toBeNull();
  });

  it("still nudges when the retry was attempted but failed again", () => {
    const calls = [failedCall("c1", "read_file", "src/a.ts"), failedCall("c2", "read_file", "src/a.ts")];
    const nudge = buildCompletionIntegrityNudge(calls);
    expect(nudge).not.toBeNull();
    expect(nudge!).toContain("src/a.ts");
  });

  it("excludes permission-denied calls", () => {
    const calls = [failedCall("c1", "write_file", "src/a.ts")];
    const denied = new Set(["c1"]);
    expect(buildCompletionIntegrityNudge(calls, denied)).toBeNull();
  });

  it("caps the failure list at 5 entries", () => {
    const calls = Array.from({ length: 8 }, (_, i) =>
      failedCall(`c${i}`, `tool_${i}`, `path_${i}`),
    );
    const nudge = buildCompletionIntegrityNudge(calls)!;
    const listed = nudge.split("\n").filter((l) => l.startsWith("- "));
    expect(listed).toHaveLength(5);
  });

  it("is deterministic for the same input", () => {
    const calls = [failedCall("c1", "run_command", "src/a.ts")];
    expect(buildCompletionIntegrityNudge(calls)).toBe(buildCompletionIntegrityNudge(calls));
  });
});

describe("streamOpenAICompatible - Responses API deduplication", () => {
  it("does not duplicate text when both response.output_text.delta and response.output_text.done arrive", async () => {
    const sseChunks = [
      'data: {"type":"response.output_text.delta","output_index":0,"delta":"Hey — quick tour of what I can do."}\n\n',
      'data: {"type":"response.output_text.done","output_index":0,"text":"Hey — quick tour of what I can do."}\n\n',
      'data: [DONE]\n\n',
    ];

    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of sseChunks) {
          controller.enqueue(new TextEncoder().encode(chunk));
        }
        controller.close();
      },
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }),
    );

    try {
      const chunks: Array<{ type: string; text?: string }> = [];
      for await (const chunk of streamOpenAICompatible(
        "https://opencode.ai/zen/v1",
        "test-key",
        "muse-spark-1.3-contributor-free",
        [{ role: "user", content: "hi" }],
      )) {
        chunks.push(chunk as any);
      }

      const contentChunks = chunks.filter((c) => c.type === "content");
      const fullText = contentChunks.map((c) => c.text).join("");
      expect(fullText).toBe("Hey — quick tour of what I can do.");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("still yields full text on response.output_text.done when no deltas were emitted (collapsed gateway)", async () => {
    const sseChunks = [
      'data: {"type":"response.output_text.done","output_index":0,"text":"Collapsed full text greeting."}\n\n',
      'data: [DONE]\n\n',
    ];

    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of sseChunks) {
          controller.enqueue(new TextEncoder().encode(chunk));
        }
        controller.close();
      },
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }),
    );

    try {
      const chunks: Array<{ type: string; text?: string }> = [];
      for await (const chunk of streamOpenAICompatible(
        "https://opencode.ai/zen/v1",
        "test-key",
        "muse-spark-1.3-contributor-free",
        [{ role: "user", content: "hi" }],
      )) {
        chunks.push(chunk as any);
      }

      const contentChunks = chunks.filter((c) => c.type === "content");
      const fullText = contentChunks.map((c) => c.text).join("");
      expect(fullText).toBe("Collapsed full text greeting.");
    } finally {
      fetchSpy.mockRestore();
    }
  });
});