// @vitest-environment jsdom
import * as React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import { useSubagentPermissionStream } from "./use-subagent-permissions";
import { useAppStore } from "@/stores/app-store";

const { toastMock } = vi.hoisted(() => ({ toastMock: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastMock }));

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  private listeners = new Map<string, Array<(e: MessageEvent) => void>>();
  closed = false;

  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, cb: (e: MessageEvent) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(cb);
    this.listeners.set(type, list);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, data: unknown): void {
    const event = new MessageEvent(type, { data: JSON.stringify(data) });
    for (const cb of this.listeners.get(type) ?? []) cb(event);
  }
}

function Harness(): React.ReactElement {
  useSubagentPermissionStream();
  return <div />;
}

function permissionFrame(conversationId: string) {
  return {
    sessionId: "sa-1",
    conversationId,
    name: "worker",
    permission: {
      approvalId: "pa_0123456789abcdef",
      toolCallId: "tc-1",
      toolName: "run_command",
      action: "command.run",
      target: "run `npm test`",
      createdAt: Date.now(),
      ttlMs: 1_800_000,
    },
  };
}

describe("useSubagentPermissionStream", () => {
  const originalEventSource = globalThis.EventSource;

  beforeEach(() => {
    vi.clearAllMocks();
    FakeEventSource.instances = [];
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
    useAppStore.setState({
      activeConversationId: "conv-active",
      conversations: [{ id: "conv-bg", title: "Background chat" }],
      pendingConversations: [],
      permissionPrompt: null,
      permissionPromptsByConversation: {},
      permissionPromptQueue: {},
      language: "en",
    });
  });

  afterEach(() => {
    cleanup();
    globalThis.EventSource = originalEventSource;
  });

  it("stores the approval of a background conversation and raises a toast", () => {
    render(<Harness />);
    const source = FakeEventSource.instances[0];
    expect(source.url).toBe("/api/agents/subagents/permissions/stream");

    act(() => {
      source.emit("permission", permissionFrame("conv-bg"));
    });

    const prompt = useAppStore.getState().permissionPromptsByConversation["conv-bg"];
    expect(prompt?.id).toBe("pa_0123456789abcdef");
    expect(prompt?.subagentName).toBe("worker");
    expect(prompt?.ttlMs).toBe(1_800_000);

    expect(toastMock).toHaveBeenCalledTimes(1);
    const [message, options] = toastMock.mock.calls[0];
    expect(message).toBe("Permission requested");
    expect((options as { description: string }).description).toContain("Background chat");
  });

  it("does not toast for the conversation the user is looking at", () => {
    render(<Harness />);
    const source = FakeEventSource.instances[0];

    act(() => {
      source.emit("permission", permissionFrame("conv-active"));
    });

    expect(useAppStore.getState().permissionPrompt?.id).toBe("pa_0123456789abcdef");
    expect(toastMock).not.toHaveBeenCalled();
  });

  it("ignores malformed frames", () => {
    render(<Harness />);
    const source = FakeEventSource.instances[0];

    act(() => {
      source.emit("permission", { sessionId: "sa-1" });
    });

    expect(useAppStore.getState().permissionPromptsByConversation).toEqual({});
    expect(toastMock).not.toHaveBeenCalled();
  });

  it("closes the stream on unmount", () => {
    const { unmount } = render(<Harness />);
    const source = FakeEventSource.instances[0];
    unmount();
    expect(source.closed).toBe(true);
  });
});
