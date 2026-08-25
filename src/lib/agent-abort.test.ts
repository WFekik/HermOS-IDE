import { describe, it, expect, beforeEach } from "vitest";
import {
  registerAgentAbort,
  unregisterAgentAbort,
  abortAgentStream,
  isAgentRunning,
  getActiveAgentConversations,
} from "./agent-abort";

describe("Agent Abort Registry", () => {
  const convA = "c_conv_test_a";
  const convB = "c_conv_test_b";

  beforeEach(() => {
    // Clean up registry before each test
    unregisterAgentAbort(convA);
    unregisterAgentAbort(convB);
  });

  it("should register active controllers and track running status", () => {
    expect(isAgentRunning(convA)).toBe(false);
    expect(getActiveAgentConversations()).not.toContain(convA);

    const controller = new AbortController();
    registerAgentAbort(convA, controller);

    expect(isAgentRunning(convA)).toBe(true);
    expect(getActiveAgentConversations()).toContain(convA);
    expect(controller.signal.aborted).toBe(false);
  });

  it("should unregister controllers", () => {
    const controller = new AbortController();
    registerAgentAbort(convA, controller);
    expect(isAgentRunning(convA)).toBe(true);

    unregisterAgentAbort(convA);
    expect(isAgentRunning(convA)).toBe(false);
    expect(getActiveAgentConversations()).not.toContain(convA);
    // Unregistering does not abort the controller itself
    expect(controller.signal.aborted).toBe(false);
  });

  it("should abort controller when abortAgentStream is called", () => {
    const controller = new AbortController();
    registerAgentAbort(convA, controller);

    const aborted = abortAgentStream(convA);
    expect(aborted).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    expect(isAgentRunning(convA)).toBe(false);
  });

  it("should return false when aborting non-existent stream", () => {
    const aborted = abortAgentStream("non_existent_conversation");
    expect(aborted).toBe(false);
  });

  it("should track multiple concurrent conversations independently", () => {
    const ctrlA = new AbortController();
    const ctrlB = new AbortController();

    registerAgentAbort(convA, ctrlA);
    registerAgentAbort(convB, ctrlB);

    expect(isAgentRunning(convA)).toBe(true);
    expect(isAgentRunning(convB)).toBe(true);

    abortAgentStream(convA);

    expect(ctrlA.signal.aborted).toBe(true);
    expect(ctrlB.signal.aborted).toBe(false);
    expect(isAgentRunning(convA)).toBe(false);
    expect(isAgentRunning(convB)).toBe(true);

    unregisterAgentAbort(convB);
    expect(isAgentRunning(convB)).toBe(false);
  });
});
