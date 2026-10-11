import { describe, it, expect, vi, beforeEach } from "vitest";
import { useAppStore, addUndoTombstones, isUndoneMessage } from "@/stores/app-store";
import { apiGet } from "@/lib/api-client";

vi.mock("@/lib/api-client", () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPatch: vi.fn(),
  apiDelete: vi.fn(),
}));

const mockApiGet = vi.mocked(apiGet);

describe("undo tombstones (no resurrection of undone messages)", () => {
  const convId = "conv-tombstone-test";

  beforeEach(() => {
    vi.restoreAllMocks();
    useAppStore.setState({
      activeConversationId: convId,
      messages: [],
      messagesByConversation: { [convId]: [] },
    });
  });

  it("tracks and reports undone ids", () => {
    expect(isUndoneMessage(convId, "m1")).toBe(false);
    addUndoTombstones(convId, ["m1", "m2"]);
    expect(isUndoneMessage(convId, "m1")).toBe(true);
    expect(isUndoneMessage(convId, "m2")).toBe(true);
    expect(isUndoneMessage("other-conv", "m1")).toBe(false);
  });

  it("removeMessageAndAfter tombstones the removed ids", () => {
    const msgs = [
      { id: "keep", role: "user", content: "hi", createdAt: new Date().toISOString() },
      { id: "drop1", role: "user", content: "undo me", createdAt: new Date().toISOString() },
      { id: "drop2", role: "assistant", content: "answer", createdAt: new Date().toISOString() },
    ];
    useAppStore.setState({
      activeConversationId: convId,
      messages: msgs as never[],
      messagesByConversation: { [convId]: msgs as never[] },
    });
    useAppStore.getState().removeMessageAndAfter("drop1");
    expect(useAppStore.getState().messages.map((m) => m.id)).toEqual(["keep"]);
    expect(isUndoneMessage(convId, "drop1")).toBe(true);
    expect(isUndoneMessage(convId, "drop2")).toBe(true);
    expect(isUndoneMessage(convId, "keep")).toBe(false);
  });

  it("refreshMessages drops tombstoned server rows instead of resurrecting them", async () => {
    const serverRows = [
      { id: "keep", role: "user", content: "hi", createdAt: new Date().toISOString() },
      { id: "drop1", role: "user", content: "undo me", createdAt: new Date().toISOString() },
      { id: "drop2", role: "assistant", content: "answer", createdAt: new Date().toISOString() },
    ];
    mockApiGet.mockResolvedValue({
      conversation: { id: convId, isAgentRunning: false, messages: serverRows },
    } as never);
    addUndoTombstones(convId, ["drop1", "drop2"]);
    await useAppStore.getState().refreshMessages(convId);
    const ids = (useAppStore.getState().messagesByConversation[convId] ?? []).map((m) => m.id);
    expect(ids).toEqual(["keep"]);
  });
});
