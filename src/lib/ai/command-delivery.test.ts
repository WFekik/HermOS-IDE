import { describe, it, expect, vi, beforeEach } from "vitest";
import { initCommandDelivery, resetCommandDeliveryForTest } from "./command-delivery";
import * as workspace from "@/lib/workspace";
import * as subagentQueue from "@/lib/ai/subagent-queue";
import * as subagentDelivery from "@/lib/ai/subagent-delivery";
import * as subagentSession from "@/lib/ai/subagent-session";
import { db } from "@/lib/db";

describe("command-delivery — background tool wake-up architecture", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetCommandDeliveryForTest();
  });

  it("delivers completed background command, updates tool call, and wakes idle agent", async () => {
    let capturedListener: ((userId: string, conversationId: string, completed: workspace.CompletedCommand) => Promise<void>) | null = null;
    vi.spyOn(workspace, "onBackgroundCommandCompleted").mockImplementation((fn: any) => {
      capturedListener = fn;
      return () => {};
    });

    vi.spyOn(subagentQueue, "isRunActive").mockReturnValue(false);
    const wakeSpy = vi.spyOn(subagentDelivery, "grantAndPublishWake").mockImplementation(() => {});
    const ackSpy = vi.spyOn(workspace, "acknowledgeCompletedCommand").mockImplementation(() => {});

    const mockCreateMessage = vi.spyOn(db.message, "create").mockResolvedValue({ id: "msg-1" } as any);
    vi.spyOn(db.message, "findFirst").mockResolvedValue({
      id: "asst-1",
      role: "assistant",
      toolCalls: JSON.stringify([
        {
          id: "tc-1",
          name: "run_command",
          status: "running",
          result: { status: "running", running: true },
        },
      ]),
    } as any);
    const mockUpdateMessage = vi.spyOn(db.message, "update").mockResolvedValue({} as any);

    initCommandDelivery();

    expect(capturedListener).toBeTruthy();

    // Simulate background command completion
    await capturedListener!("u1", "conv1", {
      command: "npm test",
      stdout: "PASS all 10 tests",
      stderr: "",
      exitCode: 0,
      completedAt: Date.now(),
      execId: "exec_123",
    });

    // 1. Verifies message is created with command output
    expect(mockCreateMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          conversationId: "conv1",
          role: "user",
          content: expect.stringContaining("npm test"),
        }),
      }),
    );

    // 2. Verifies previous assistant tool call is updated from running to done
    expect(mockUpdateMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "asst-1" },
        data: expect.objectContaining({
          toolCalls: expect.stringContaining('"status":"done"'),
        }),
      }),
    );

    // 3. Verifies command was acknowledged
    expect(ackSpy).toHaveBeenCalledWith("u1", "conv1", "exec_123");

    // 4. Verifies wake was issued to wake up the agent
    expect(wakeSpy).toHaveBeenCalledWith("u1", "conv1");

    // 5. Verifies the completion is claimed before any awaited DB writes,
    // so the executor drain can never double-post the same command
    expect(ackSpy.mock.invocationCallOrder[0]).toBeLessThan(
      mockCreateMessage.mock.invocationCallOrder[0],
    );
  });

  it("does not wake or post message if agent run is currently active", async () => {
    let capturedListener: ((userId: string, conversationId: string, completed: workspace.CompletedCommand) => Promise<void>) | null = null;
    vi.spyOn(workspace, "onBackgroundCommandCompleted").mockImplementation((fn: any) => {
      capturedListener = fn;
      return () => {};
    });

    vi.spyOn(subagentQueue, "isRunActive").mockReturnValue(true);
    const wakeSpy = vi.spyOn(subagentDelivery, "grantAndPublishWake");
    const mockCreateMessage = vi.spyOn(db.message, "create");

    initCommandDelivery();
    expect(capturedListener).toBeTruthy();

    await capturedListener!("u1", "conv1", {
      command: "npm run build",
      stdout: "Building...",
      stderr: "",
      exitCode: 0,
      completedAt: Date.now(),
      execId: "exec_456",
    });

    expect(mockCreateMessage).not.toHaveBeenCalled();
    expect(wakeSpy).not.toHaveBeenCalled();
  });

  it("updates only the tool call whose execId matches the completed command", async () => {
    let capturedListener: ((userId: string, conversationId: string, completed: workspace.CompletedCommand) => Promise<void>) | null = null;
    vi.spyOn(workspace, "onBackgroundCommandCompleted").mockImplementation((fn: any) => {
      capturedListener = fn;
      return () => {};
    });

    vi.spyOn(subagentQueue, "isRunActive").mockReturnValue(false);
    const ackSpy = vi.spyOn(workspace, "acknowledgeCompletedCommand").mockImplementation(() => {});
    const wakeSpy = vi.spyOn(subagentDelivery, "grantAndPublishWake").mockImplementation(() => {});

    vi.spyOn(db.message, "create").mockResolvedValue({ id: "msg-1" } as any);
    vi.spyOn(db.message, "findFirst").mockResolvedValue({
      id: "asst-1",
      role: "assistant",
      toolCalls: JSON.stringify([
        {
          id: "tc-1",
          name: "run_command",
          status: "running",
          result: { status: "running", commandId: "u1:conv1:exec_A", command: "npm test" },
        },
        {
          id: "tc-2",
          name: "run_command",
          status: "running",
          result: { status: "running", commandId: "u1:conv1:exec_B", command: "pytest" },
        },
      ]),
    } as any);
    const mockUpdateMessage = vi.spyOn(db.message, "update").mockResolvedValue({} as any);

    initCommandDelivery();
    expect(capturedListener).toBeTruthy();

    await capturedListener!("u1", "conv1", {
      command: "npm test",
      stdout: "PASS all 10 tests",
      stderr: "",
      exitCode: 0,
      completedAt: Date.now(),
      execId: "exec_A",
    });

    expect(mockUpdateMessage).toHaveBeenCalledTimes(1);
    const written = (mockUpdateMessage.mock.calls[0][0] as { data: { toolCalls: string } }).data.toolCalls;
    const tcs = JSON.parse(written) as Array<Record<string, unknown>>;
    expect(tcs[0].status).toBe("done");
    expect((tcs[0].result as { exitCode: number }).exitCode).toBe(0);
    expect(tcs[1].status).toBe("running");
    expect((tcs[1].result as { status: string }).status).toBe("running");
    expect(ackSpy).toHaveBeenCalledWith("u1", "conv1", "exec_A");
    expect(wakeSpy).toHaveBeenCalledWith("u1", "conv1");
  });

  it("never posts into a live subagent session — the subagent executor drains its own commands", async () => {
    let capturedListener: ((userId: string, conversationId: string, completed: workspace.CompletedCommand) => Promise<void>) | null = null;
    vi.spyOn(workspace, "onBackgroundCommandCompleted").mockImplementation((fn: any) => {
      capturedListener = fn;
      return () => {};
    });

    vi.spyOn(subagentQueue, "isRunActive").mockReturnValue(false);
    vi.spyOn(subagentSession, "internalGet").mockReturnValue({ id: "sa-1" } as never);
    const ackSpy = vi.spyOn(workspace, "acknowledgeCompletedCommand").mockImplementation(() => {});
    const wakeSpy = vi.spyOn(subagentDelivery, "grantAndPublishWake").mockImplementation(() => {});
    const mockCreateMessage = vi.spyOn(db.message, "create");

    initCommandDelivery();
    expect(capturedListener).toBeTruthy();

    await capturedListener!("u1", "sa-1", {
      command: "npm test",
      stdout: "PASS",
      stderr: "",
      exitCode: 0,
      completedAt: Date.now(),
      execId: "exec_sub",
    });

    expect(mockCreateMessage).not.toHaveBeenCalled();
    expect(ackSpy).not.toHaveBeenCalled();
    expect(wakeSpy).not.toHaveBeenCalled();
  });

  it("keeps the completion pending while transcript undo pauses delivery", async () => {
    let capturedListener: ((userId: string, conversationId: string, completed: workspace.CompletedCommand) => Promise<void>) | null = null;
    vi.spyOn(workspace, "onBackgroundCommandCompleted").mockImplementation((fn: any) => {
      capturedListener = fn;
      return () => {};
    });

    vi.spyOn(subagentQueue, "isRunActive").mockReturnValue(false);
    vi.spyOn(subagentDelivery, "isConversationDeliveryPaused").mockReturnValue(true);
    const ackSpy = vi.spyOn(workspace, "acknowledgeCompletedCommand").mockImplementation(() => {});
    const wakeSpy = vi.spyOn(subagentDelivery, "grantAndPublishWake").mockImplementation(() => {});
    const mockCreateMessage = vi.spyOn(db.message, "create");

    initCommandDelivery();
    expect(capturedListener).toBeTruthy();

    await capturedListener!("u1", "conv1", {
      command: "npm run build",
      stdout: "Building...",
      stderr: "",
      exitCode: 0,
      completedAt: Date.now(),
      execId: "exec_789",
    });

    expect(mockCreateMessage).not.toHaveBeenCalled();
    expect(ackSpy).not.toHaveBeenCalled();
    expect(wakeSpy).not.toHaveBeenCalled();
  });
});
