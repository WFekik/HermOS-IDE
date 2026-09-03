import { describe, it, expect, vi, beforeEach } from "vitest";
import { useAppStore } from "@/stores/app-store";
import { apiGet, apiPost, apiPatch, apiDelete, ApiRequestError } from "@/lib/api-client";
import type { ConversationDTO, MessageDTO } from "@/lib/types";

vi.mock("@/lib/api-client", () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPatch: vi.fn(),
  apiDelete: vi.fn(),
  ApiRequestError: class ApiRequestError extends Error {
    status?: number;
    code?: string;
    constructor(message: string, code?: string, status?: number) {
      super(message);
      this.name = "ApiRequestError";
      this.code = code;
      this.status = status;
    }
  },
}));

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    dismiss: vi.fn(),
    custom: vi.fn(),
  }),
}));

const mockApiGet = vi.mocked(apiGet);
const mockApiPost = vi.mocked(apiPost);
const mockApiPatch = vi.mocked(apiPatch);
const mockApiDelete = vi.mocked(apiDelete);

describe("useAppStore Unit Test Suite", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Reset store state between tests
    useAppStore.setState({
      currentUser: null,
      authLoading: false,
      authChecked: true,
      conversations: [],
      activeConversationId: null,
      messages: [],
      messagesByConversation: {},
      streamingStateByConversation: {},
      activeTodosByConversation: {},
      thinkingExpanded: {},
      scrollPositions: {},
      isStreaming: false,
      streamingMessageId: null,
      streamError: null,
      composerDraft: "",
      composerDrafts: {},
      pendingConversations: [],
      composerMode: "agent",
      selectedProvider: "openai",
      selectedModel: "gpt-4o",
      openFiles: [],
      openFilesByProject: {},
      activeFileTab: null,
      activeFileTabByProject: {},
      splitEditorOpen: false,
      splitEditorFile: null,
      splitEditorActive: "left",
      workspaces: [],
      activeWorkspace: null,
      selectedProjectId: null,
      permissionPrompt: null,
      questionPrompt: null,
      checkpoints: [],
      subagents: [],
      subagentsConversationId: null,
      rightPanelOpen: false,
      rightPanelTab: "files",
      sidebarCollapsed: true,
    });
  });

  describe("Store Creation & Initial State", () => {
    it("initializes with expected default values", () => {
      const state = useAppStore.getState();

      expect(state.currentUser).toBeNull();
      expect(state.conversations).toEqual([]);
      expect(state.activeConversationId).toBeNull();
      expect(state.messages).toEqual([]);
      expect(state.messagesByConversation).toEqual({});
      expect(state.openFiles).toEqual([]);
      expect(state.activeFileTab).toBeNull();
      expect(state.activeFileTabByProject).toEqual({});
      expect(state.splitEditorOpen).toBe(false);
      expect(state.splitEditorFile).toBeNull();
      expect(state.splitEditorActive).toBe("left");
      expect(state.permissionPrompt).toBeNull();
      expect(state.questionPrompt).toBeNull();
      expect(state.checkpoints).toEqual([]);
      expect(state.subagents).toEqual([]);
      expect(state.composerMode).toBe("agent");
      expect(state.isStreaming).toBe(false);
    });

    it("toggles sidebar and right panel state", () => {
      expect(useAppStore.getState().sidebarCollapsed).toBe(true);
      useAppStore.getState().toggleSidebar();
      expect(useAppStore.getState().sidebarCollapsed).toBe(false);

      useAppStore.getState().setRightPanelTab("git");
      expect(useAppStore.getState().rightPanelTab).toBe("git");
    });
  });

  describe("Workspace Switching & Tab Isolation (openFilesByProject / activeFileTabByProject)", () => {
    it("tracks open files and active tabs", () => {
      const store = useAppStore.getState();

      store.openFileTab("src/index.ts");
      expect(useAppStore.getState().openFiles).toEqual(["src/index.ts"]);
      expect(useAppStore.getState().activeFileTab).toBe("src/index.ts");

      store.openFileTab("src/app.tsx");
      expect(useAppStore.getState().openFiles).toEqual(["src/index.ts", "src/app.tsx"]);
      expect(useAppStore.getState().activeFileTab).toBe("src/app.tsx");

      store.setActiveFileTab("src/index.ts");
      expect(useAppStore.getState().activeFileTab).toBe("src/index.ts");

      // setActiveFileTab is a no-op for non-open file
      store.setActiveFileTab("src/non-existent.ts");
      expect(useAppStore.getState().activeFileTab).toBe("src/index.ts");
    });

    it("saves and restores open files and active tabs per project during workspace switching (openFilesByProject)", async () => {
      useAppStore.setState({
        workspaces: [
          { id: "ws-1", name: "Project Alpha", isActive: true },
          { id: "ws-2", name: "Project Beta", isActive: false },
        ],
        activeWorkspace: { id: "ws-1", name: "Project Alpha", isActive: true },
        selectedProjectId: "ws-1",
        openFiles: ["src/alpha.ts"],
        activeFileTab: "src/alpha.ts",
        openFilesByProject: { "ws-1": ["src/alpha.ts"] },
        activeFileTabByProject: { "ws-1": "src/alpha.ts" },
      });

      mockApiPost.mockResolvedValueOnce({
        workspace: { id: "ws-2", name: "Project Beta", isActive: true },
      });
      mockApiGet.mockResolvedValueOnce({ conversations: [] });

      // Switch to ws-2
      const switched = await useAppStore.getState().switchWorkspace("ws-2", undefined, { skipAutoSelectConversation: true });
      expect(switched).toBe(true);

      const stateAfterSwitch = useAppStore.getState();
      expect(stateAfterSwitch.selectedProjectId).toBe("ws-2");
      // Previous state for ws-1 should be saved in ByProject maps
      expect(stateAfterSwitch.openFilesByProject["ws-1"]).toEqual(["src/alpha.ts"]);
      expect(stateAfterSwitch.activeFileTabByProject["ws-1"]).toBe("src/alpha.ts");
      // Target ws-2 starts with empty openFiles
      expect(stateAfterSwitch.openFiles).toEqual([]);
      expect(stateAfterSwitch.activeFileTab).toBeNull();

      // Now open and set active tab in ws-2
      useAppStore.getState().openFileTab("src/beta.ts");
      expect(useAppStore.getState().openFiles).toEqual(["src/beta.ts"]);
      expect(useAppStore.getState().activeFileTab).toBe("src/beta.ts");

      // Switch back to ws-1
      mockApiPost.mockResolvedValueOnce({
        workspace: { id: "ws-1", name: "Project Alpha", isActive: true },
      });
      mockApiGet.mockResolvedValueOnce({ conversations: [] });

      await useAppStore.getState().switchWorkspace("ws-1", undefined, { skipAutoSelectConversation: true });

      const stateBack = useAppStore.getState();
      expect(stateBack.selectedProjectId).toBe("ws-1");
      // State for ws-2 should be recorded
      expect(stateBack.openFilesByProject["ws-2"]).toEqual(["src/beta.ts"]);
      expect(stateBack.activeFileTabByProject["ws-2"]).toBe("src/beta.ts");
      // Saved state for ws-1 should be restored
      expect(stateBack.openFiles).toEqual(["src/alpha.ts"]);
      expect(stateBack.activeFileTab).toBe("src/alpha.ts");
    });

    it("cleans up activeFileTabByProject when a workspace is deleted", async () => {
      useAppStore.setState({
        activeFileTabByProject: {
          "ws-1": "src/file1.ts",
          "ws-2": "src/file2.ts",
        },
      });

      mockApiPost.mockResolvedValueOnce({ ok: true });
      await useAppStore.getState().deleteWorkspace("ws-2");

      expect(useAppStore.getState().activeFileTabByProject["ws-2"]).toBeUndefined();
      expect(useAppStore.getState().activeFileTabByProject["ws-1"]).toBe("src/file1.ts");
    });

    it("resets all open files and tabs on closeAllFileTabs", () => {
      useAppStore.setState({
        openFiles: ["src/a.ts", "src/b.ts"],
        activeFileTab: "src/a.ts",
        activeFileTabByProject: { "ws-1": "src/a.ts" },
        splitEditorOpen: true,
        splitEditorFile: "src/b.ts",
      });

      useAppStore.getState().closeAllFileTabs();

      const state = useAppStore.getState();
      expect(state.openFiles).toEqual([]);
      expect(state.activeFileTab).toBeNull();
      expect(state.activeFileTabByProject).toEqual({});
      expect(state.splitEditorOpen).toBe(false);
      expect(state.splitEditorFile).toBeNull();
      expect(state.splitEditorActive).toBe("left");
    });
  });

  describe("Conversation Creation, Selection, and Deletion State Cleanup", () => {
    it("creates a conversation lazily (pending) without writing to the DB", async () => {
      useAppStore.setState({ composerDraft: "Draft text", composerDrafts: {} });

      const created = await useAppStore.getState().createConversation({
        title: "Test Conversation",
      });

      // No API call — the conversation is a client-side placeholder until send.
      expect(mockApiPost).not.toHaveBeenCalled();
      expect(created).not.toBeNull();
      expect(created!.id.startsWith("pending-")).toBe(true);
      expect(useAppStore.getState().conversations).toHaveLength(0);
      expect(useAppStore.getState().pendingConversations).toHaveLength(1);
      expect(useAppStore.getState().activeConversationId).toBe(created!.id);
      // Explicit titles start with a cleared draft.
      expect(useAppStore.getState().composerDraft).toBe("");
    });

    it("reuses an existing pending conversation instead of creating another", async () => {
      const first = await useAppStore.getState().createConversation();
      const second = await useAppStore.getState().createConversation();

      expect(second!.id).toBe(first!.id);
      expect(useAppStore.getState().pendingConversations).toHaveLength(1);
      expect(mockApiPost).not.toHaveBeenCalled();
    });

    it("materializes a pending conversation into a real DB row on first send", async () => {
      const pending = await useAppStore.getState().createConversation();
      const pendingId = pending!.id;

      const realConv: ConversationDTO = {
        id: "conv-real-1",
        userId: "u1",
        title: "New conversation",
        provider: "openai",
        model: "gpt-4o",
        mode: "agent",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      mockApiPost.mockResolvedValueOnce({ conversation: realConv });

      const realId = await useAppStore.getState().ensureRealConversation(pendingId);

      expect(realId).toBe("conv-real-1");
      expect(mockApiPost).toHaveBeenCalledWith("/api/conversations", expect.any(Object));
      const state = useAppStore.getState();
      expect(state.pendingConversations).toHaveLength(0);
      expect(state.conversations.map((c) => c.id)).toContain("conv-real-1");
      expect(state.activeConversationId).toBe("conv-real-1");
    });

    it("preserves an unsent draft when navigating away and returns it via New conversation", async () => {
      mockApiGet.mockResolvedValue({ messages: [], checkpoints: [], subagents: [], pending: [] });

      // 1. Fresh state — type a message without sending.
      useAppStore.setState({ activeConversationId: null, composerDrafts: {} });
      useAppStore.getState().setComposerDraft("hello world");

      // 2. Navigate to an existing conversation.
      const convB: ConversationDTO = {
        id: "conv-B",
        userId: "u1",
        title: "B",
        provider: "openai",
        model: "gpt-4o",
        mode: "agent",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      useAppStore.setState({ conversations: [convB] });
      await useAppStore.getState().selectConversation("conv-B");
      expect(useAppStore.getState().composerDraft).toBe("");

      // 3. Click "New conversation" — lands back on the pending chat.
      const pending = await useAppStore.getState().createConversation();

      // 4. The unsent text is restored.
      expect(useAppStore.getState().composerDraft).toBe("hello world");
      expect(pending!.id.startsWith("pending-")).toBe(true);

      // 5. A second click reuses the same pending conversation.
      const again = await useAppStore.getState().createConversation();
      expect(again!.id).toBe(pending!.id);
    });

    it("restores per-conversation drafts when switching between conversations", async () => {
      mockApiGet.mockResolvedValue({ messages: [], checkpoints: [], subagents: [], pending: [] });

      const convA: ConversationDTO = {
        id: "conv-A",
        userId: "u1",
        title: "A",
        provider: "openai",
        model: "gpt-4o",
        mode: "agent",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const convB: ConversationDTO = {
        id: "conv-B",
        userId: "u1",
        title: "B",
        provider: "openai",
        model: "gpt-4o",
        mode: "agent",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      useAppStore.setState({
        conversations: [convA, convB],
        activeConversationId: "conv-A",
        messagesByConversation: { "conv-A": [], "conv-B": [] },
      });

      useAppStore.getState().setComposerDraft("draft for A");
      await useAppStore.getState().selectConversation("conv-B");
      expect(useAppStore.getState().composerDraft).toBe("");

      useAppStore.getState().setComposerDraft("draft for B");
      await useAppStore.getState().selectConversation("conv-A");
      expect(useAppStore.getState().composerDraft).toBe("draft for A");

      await useAppStore.getState().selectConversation("conv-B");
      expect(useAppStore.getState().composerDraft).toBe("draft for B");
    });

    it("caches previous messages and resets transient state on selectConversation", async () => {
      const convA: ConversationDTO = {
        id: "conv-A",
        userId: "u1",
        title: "A",
        provider: "openai",
        model: "gpt-4o",
        mode: "agent",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const convB: ConversationDTO = {
        id: "conv-B",
        userId: "u1",
        title: "B",
        provider: "anthropic",
        model: "claude-3-5-sonnet",
        mode: "architect",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const msgA: MessageDTO = {
        id: "msg-1",
        conversationId: "conv-A",
        role: "user",
        content: "Hello from A",
        createdAt: new Date().toISOString(),
      };
      const msgB: MessageDTO = {
        id: "msg-2",
        conversationId: "conv-B",
        role: "user",
        content: "Hello from B",
        createdAt: new Date().toISOString(),
      };

      useAppStore.setState({
        conversations: [convA, convB],
        activeConversationId: "conv-A",
        messages: [msgA],
        messagesByConversation: { "conv-A": [msgA], "conv-B": [msgB] },
        streamingStateByConversation: { "conv-A": { isStreaming: false, streamingMessageId: null } },
        preTurnCheckpointId: "cp-old",
        activeSubagentId: "sub-1",
        editingMessageId: "msg-edit",
      });

      mockApiGet.mockResolvedValue({ messages: [msgB], checkpoints: [], subagents: [], pending: [] });

      await useAppStore.getState().selectConversation("conv-B");

      const state = useAppStore.getState();
      expect(state.activeConversationId).toBe("conv-B");
      // Previous conv messages cached
      expect(state.messagesByConversation["conv-A"]).toEqual([msgA]);
      // Transient conversation-scoped state reset
      expect(state.preTurnCheckpointId).toBeNull();
      expect(state.activeSubagentId).toBeNull();
      expect(state.editingMessageId).toBeNull();
      // Switched to conv-B messages
      expect(state.messages).toEqual([msgB]);
      // Mode and provider synced from active conversation
      expect(state.selectedProvider).toBe("anthropic");
      expect(state.selectedModel).toBe("claude-3-5-sonnet");
      expect(state.composerMode).toBe("architect");
    });

    it("cleans up conversation state on deleteConversation", async () => {
      const conv: ConversationDTO = {
        id: "conv-to-delete",
        userId: "u1",
        title: "Delete me",
        provider: "openai",
        model: "gpt-4o",
        mode: "agent",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      useAppStore.setState({
        conversations: [conv],
        activeConversationId: "conv-to-delete",
        messages: [{ id: "m1", conversationId: "conv-to-delete", role: "user", content: "hi", createdAt: "" }],
        messagesByConversation: { "conv-to-delete": [{ id: "m1", conversationId: "conv-to-delete", role: "user", content: "hi", createdAt: "" }] },
        streamingStateByConversation: { "conv-to-delete": { isStreaming: true, streamingMessageId: "m1" } },
        activeTodosByConversation: { "conv-to-delete": [] },
        thinkingExpanded: { "conv-to-delete": true },
        scrollPositions: { "conv-to-delete": 150 },
      });

      mockApiDelete.mockResolvedValueOnce({ ok: true });

      await useAppStore.getState().deleteConversation("conv-to-delete");

      const state = useAppStore.getState();
      expect(state.conversations).toEqual([]);
      expect(state.activeConversationId).toBeNull();
      expect(state.messages).toEqual([]);
      expect(state.messagesByConversation["conv-to-delete"]).toBeUndefined();
      expect(state.streamingStateByConversation["conv-to-delete"]).toBeUndefined();
      expect(state.activeTodosByConversation["conv-to-delete"]).toBeUndefined();
      expect(state.thinkingExpanded["conv-to-delete"]).toBeUndefined();
      expect(state.scrollPositions["conv-to-delete"]).toBeUndefined();
    });

    it("manages question prompts resolution and recovery", async () => {
      const store = useAppStore.getState();

      store.setQuestionPrompt({
        id: "q-1",
        toolCallId: "call-1",
        conversationId: "conv-1",
        questions: [{ question: "Deploy to prod?", options: ["Yes", "No"], isMultiSelect: false }],
        question: "Deploy to prod?",
        options: ["Yes", "No"],
        isMultiSelect: false,
        createdAt: new Date().toISOString(),
      });

      expect(useAppStore.getState().questionPrompt?.id).toBe("q-1");

      mockApiPost.mockResolvedValueOnce({ ok: true });
      await useAppStore.getState().resolveQuestionPrompt("q-1", { answers: ["Yes"] });

      expect(mockApiPost).toHaveBeenCalledWith("/api/agents/questions/pending", {
        id: "q-1",
        answers: ["Yes"],
      });
      expect(useAppStore.getState().questionPrompt).toBeNull();

      // Question recovery for target conversation
      mockApiGet.mockResolvedValueOnce({
        pending: [
          {
            id: "q-2",
            toolCallId: "call-2",
            conversationId: "conv-target",
            questions: [{ question: "Pick framework", options: ["React", "Vue"] }],
            createdAt: new Date().toISOString(),
          },
        ],
      });

      await useAppStore.getState().recoverQuestionPrompt("conv-target");
      expect(useAppStore.getState().questionPrompt?.id).toBe("q-2");
      expect(useAppStore.getState().questionPrompt?.conversationId).toBe("conv-target");
    });

    it("manages checkpoints and subagents lifecycle", async () => {
      // Checkpoints refresh
      mockApiGet.mockResolvedValueOnce({
        checkpoints: [
          { id: "cp-1", conversationId: "conv-1", label: "Initial", createdAt: "2026-08-16T10:00:00Z" },
          { id: "cp-2", conversationId: "conv-1", label: "After Edit", createdAt: "2026-08-16T10:05:00Z" },
        ],
      });

      await useAppStore.getState().refreshCheckpoints("conv-1");
      expect(useAppStore.getState().checkpoints).toHaveLength(2);
      expect(useAppStore.getState().checkpoints[0].id).toBe("cp-2");
      expect(useAppStore.getState().preTurnCheckpointId).toBe("cp-2");

      // Subagents refresh
      mockApiGet.mockResolvedValueOnce({
        subagents: [
          { id: "sub-1", conversationId: "conv-1", name: "Tester", task: "Run tests", status: "idle", createdAt: "2026-08-16T10:00:00Z" },
        ],
      });

      await useAppStore.getState().refreshSubagents("conv-1");
      expect(useAppStore.getState().subagents).toHaveLength(1);
      expect(useAppStore.getState().subagents[0].id).toBe("sub-1");

      // Delete subagent optimistically
      mockApiDelete.mockResolvedValueOnce({ ok: true });
      await useAppStore.getState().deleteSubagent("sub-1");
      expect(useAppStore.getState().subagents).toEqual([]);
    });
  });

  describe("Split Editor Tab LRU Eviction Safety", () => {
    it("evicts the oldest non-active tab when opening tabs beyond MAX_OPEN_TABS (10)", () => {
      const store = useAppStore.getState();

      // Open 10 tabs
      for (let i = 1; i <= 10; i++) {
        store.openFileTab(`file${i}.ts`);
      }

      expect(useAppStore.getState().openFiles).toHaveLength(10);
      expect(useAppStore.getState().activeFileTab).toBe("file10.ts");

      // Set active tab to file5.ts
      store.setActiveFileTab("file5.ts");
      expect(useAppStore.getState().activeFileTab).toBe("file5.ts");

      // Open 11th tab — should evict file1.ts (oldest non-active) and retain file5.ts
      store.openFileTab("file11.ts");

      const openFiles = useAppStore.getState().openFiles;
      expect(openFiles).toHaveLength(10);
      expect(openFiles).not.toContain("file1.ts");
      expect(openFiles).toContain("file5.ts");
      expect(openFiles).toContain("file11.ts");
      expect(useAppStore.getState().activeFileTab).toBe("file11.ts");
    });

    it("protects both active tab and split editor tab from LRU eviction", () => {
      const store = useAppStore.getState();

      // Open 10 tabs
      for (let i = 1; i <= 10; i++) {
        store.openFileTab(`file${i}.ts`);
      }

      // Active tab is file2.ts
      store.setActiveFileTab("file2.ts");
      // Set split editor file to file1.ts
      store.setSplitEditorOpen(true);
      store.setSplitEditorFile("file1.ts");

      expect(useAppStore.getState().activeFileTab).toBe("file2.ts");
      expect(useAppStore.getState().splitEditorFile).toBe("file1.ts");

      // Open new split editor file file99.ts when tabs are full
      // Eviction victim should be file3.ts (first non-active, non-split), protecting file1 and file2
      store.setSplitEditorFile("file99.ts");

      const openFiles = useAppStore.getState().openFiles;
      expect(openFiles).toHaveLength(10);
      expect(openFiles).toContain("file1.ts");
      expect(openFiles).toContain("file2.ts");
      expect(openFiles).toContain("file99.ts");
      expect(openFiles).not.toContain("file3.ts");
      expect(useAppStore.getState().splitEditorFile).toBe("file99.ts");
    });

    it("closes split editor when split editor file tab is closed", () => {
      const store = useAppStore.getState();

      store.openFileTab("src/main.ts");
      store.openFileTab("src/split.ts");
      store.setSplitEditorOpen(true);
      store.setSplitEditorFile("src/split.ts");
      store.setActiveFileTab("src/main.ts");

      expect(useAppStore.getState().splitEditorOpen).toBe(true);
      expect(useAppStore.getState().splitEditorFile).toBe("src/split.ts");

      // Close the split file tab
      store.closeFileTab("src/split.ts");

      const state = useAppStore.getState();
      expect(state.openFiles).toEqual(["src/main.ts"]);
      expect(state.activeFileTab).toBe("src/main.ts");
      expect(state.splitEditorOpen).toBe(false);
      expect(state.splitEditorFile).toBeNull();
      expect(state.splitEditorActive).toBe("left");
    });

    it("clamps active tab to adjacent when active tab is closed", () => {
      const store = useAppStore.getState();

      store.openFileTab("src/a.ts");
      store.openFileTab("src/b.ts");
      store.openFileTab("src/c.ts");
      store.setActiveFileTab("src/b.ts");

      store.closeFileTab("src/b.ts");

      const state = useAppStore.getState();
      expect(state.openFiles).toEqual(["src/a.ts", "src/c.ts"]);
      // Clamped to adjacent tab at index 1 -> src/c.ts
      expect(state.activeFileTab).toBe("src/c.ts");
    });
  });

  describe("Permission Prompt Resolution Targeting Prompt conversationId", () => {
    it("resolves permission prompt with allow-once", async () => {
      const resolveMock = vi.fn();
      useAppStore.setState({
        permissionPrompt: {
          id: "perm-1",
          action: "run_command",
          target: "npm run test",
          toolCallId: "call-1",
          createdAt: new Date().toISOString(),
          resolve: resolveMock,
        },
      });

      mockApiPost.mockResolvedValueOnce({ ok: true });

      await useAppStore.getState().resolvePermissionPrompt("perm-1", "allow-once");

      expect(mockApiPost).toHaveBeenCalledWith("/api/permissions/pending", {
        id: "perm-1",
        decision: "allow",
      });
      expect(resolveMock).toHaveBeenCalledWith("allow-once");
      expect(useAppStore.getState().permissionPrompt).toBeNull();
    });

    it("resolves permission prompt with always-allow", async () => {
      const resolveMock = vi.fn();
      useAppStore.setState({
        permissionPrompt: {
          id: "perm-2",
          action: "write_file",
          target: "src/app.ts",
          createdAt: new Date().toISOString(),
          resolve: resolveMock,
        },
      });

      mockApiPost.mockResolvedValueOnce({ ok: true });

      await useAppStore.getState().resolvePermissionPrompt("perm-2", "always-allow");

      expect(mockApiPost).toHaveBeenCalledWith("/api/permissions/pending", {
        id: "perm-2",
        decision: "always_allow",
      });
      expect(resolveMock).toHaveBeenCalledWith("always-allow");
      expect(useAppStore.getState().permissionPrompt).toBeNull();
    });

    it("resolves permission prompt with deny and updates live tool call error optimistically", async () => {
      const resolveMock = vi.fn();
      const initialMessage: MessageDTO = {
        id: "msg-1",
        conversationId: "conv-1",
        role: "assistant",
        content: "Running tool...",
        createdAt: new Date().toISOString(),
      };

      useAppStore.setState({
        activeConversationId: "conv-1",
        messages: [
          {
            ...initialMessage,
            liveToolCalls: [
              {
                id: "tool-call-deny-1",
                name: "run_command",
                args: "{}",
                status: "running",
              },
            ],
          },
        ],
        messagesByConversation: {
          "conv-1": [
            {
              ...initialMessage,
              liveToolCalls: [
                {
                  id: "tool-call-deny-1",
                  name: "run_command",
                  args: "{}",
                  status: "running",
                },
              ],
            },
          ],
        },
        permissionPrompt: {
          id: "perm-deny",
          action: "run_command",
          target: "rm -rf /",
          toolCallId: "tool-call-deny-1",
          createdAt: new Date().toISOString(),
          resolve: resolveMock,
        },
      });

      mockApiPost.mockResolvedValueOnce({ ok: true });

      await useAppStore.getState().resolvePermissionPrompt("perm-deny", "deny");

      expect(mockApiPost).toHaveBeenCalledWith("/api/permissions/pending", {
        id: "perm-deny",
        decision: "deny",
      });
      expect(resolveMock).toHaveBeenCalledWith("deny");
      expect(useAppStore.getState().permissionPrompt).toBeNull();

      // Tool call in active conversation should be updated to error
      const activeMsgs = useAppStore.getState().messages;
      const toolCall = activeMsgs[0]?.liveToolCalls?.[0];
      expect(toolCall?.status).toBe("error");
      expect(toolCall?.result).toEqual({ error: "Permission denied by user." });
    });

    it("recovers permission prompt targeting specific conversationId", async () => {
      mockApiGet.mockResolvedValueOnce({
        pending: [
          {
            id: "perm-other",
            action: "read_file",
            target: "other.txt",
            conversationId: "conv-other",
            createdAt: new Date().toISOString(),
          },
          {
            id: "perm-target",
            action: "run_command",
            target: "git status",
            toolCallId: "tc-target",
            conversationId: "conv-target",
            createdAt: new Date().toISOString(),
          },
        ],
      });

      await useAppStore.getState().recoverPermissionPrompt("conv-target");

      const prompt = useAppStore.getState().permissionPrompt;
      expect(prompt).not.toBeNull();
      expect(prompt?.id).toBe("perm-target");
      expect(prompt?.target).toBe("git status");
      expect(prompt?.toolCallId).toBe("tc-target");

      // Verify the bound resolve function delegates to resolvePermissionPrompt
      mockApiPost.mockResolvedValueOnce({ ok: true });
      prompt?.resolve("allow-once");

      await vi.waitFor(() => {
        expect(useAppStore.getState().permissionPrompt).toBeNull();
      });
    });

    it("does not overwrite existing permissionPrompt during recovery", async () => {
      const existingResolve = vi.fn();
      useAppStore.setState({
        permissionPrompt: {
          id: "perm-existing",
          action: "existing_action",
          target: "existing_target",
          createdAt: Date.now(),
          resolve: existingResolve,
        },
      });

      await useAppStore.getState().recoverPermissionPrompt("conv-target");

      // Should remain untouched without calling API
      expect(mockApiGet).not.toHaveBeenCalled();
      expect(useAppStore.getState().permissionPrompt?.id).toBe("perm-existing");
    });
  });

  describe("Workspace Open Files Scoping (openFilesByProject)", () => {
    it("saves and restores openFiles and activeFileTab per project on switchWorkspace", async () => {
      mockApiPost.mockResolvedValueOnce({
        workspace: { id: "ws-2", name: "Project 2", isActive: true },
      });

      useAppStore.setState({
        workspaces: [
          { id: "ws-1", name: "Project 1", isActive: true, rootDir: "/p1" },
          { id: "ws-2", name: "Project 2", isActive: false, rootDir: "/p2" },
        ],
        selectedProjectId: "ws-1",
        openFiles: ["/p1/a.ts", "/p1/b.ts"],
        activeFileTab: "/p1/b.ts",
        openFilesByProject: {},
        activeFileTabByProject: {},
        conversations: [{ id: "c-2", workspaceId: "ws-2", title: "C2", mode: "agent" } as any],
      });

      const success = await useAppStore.getState().switchWorkspace("ws-2", "Project 2");
      expect(success).toBe(true);

      const state = useAppStore.getState();
      expect(state.selectedProjectId).toBe("ws-2");
      // ws-1 files saved
      expect(state.openFilesByProject["ws-1"]).toEqual(["/p1/a.ts", "/p1/b.ts"]);
      expect(state.activeFileTabByProject["ws-1"]).toBe("/p1/b.ts");
      // ws-2 had no open files previously
      expect(state.openFiles).toEqual([]);
      expect(state.activeFileTab).toBeNull();

      // Now open files in ws-2
      useAppStore.setState({
        openFiles: ["/p2/main.ts"],
        activeFileTab: "/p2/main.ts",
      });

      // Switch back to ws-1
      mockApiPost.mockResolvedValueOnce({
        workspace: { id: "ws-1", name: "Project 1", isActive: true },
      });
      await useAppStore.getState().switchWorkspace("ws-1", "Project 1");

      const state2 = useAppStore.getState();
      expect(state2.selectedProjectId).toBe("ws-1");
      expect(state2.openFiles).toEqual(["/p1/a.ts", "/p1/b.ts"]);
      expect(state2.activeFileTab).toBe("/p1/b.ts");
      expect(state2.openFilesByProject["ws-2"]).toEqual(["/p2/main.ts"]);
    });

    it("cleans up openFilesByProject on deleteWorkspace", async () => {
      mockApiPost.mockResolvedValueOnce({ ok: true });
      useAppStore.setState({
        workspaces: [
          { id: "ws-1", name: "Project 1", isActive: true, rootDir: "/p1" },
          { id: "ws-2", name: "Project 2", isActive: false, rootDir: "/p2" },
        ],
        openFilesByProject: { "ws-1": ["a.ts"], "ws-2": ["b.ts"] },
        activeFileTabByProject: { "ws-1": "a.ts", "ws-2": "b.ts" },
      });

      await useAppStore.getState().deleteWorkspace("ws-2");
      const state = useAppStore.getState();
      expect(state.openFilesByProject["ws-2"]).toBeUndefined();
      expect(state.activeFileTabByProject["ws-2"]).toBeUndefined();
    });
  });

  describe("Scoped Permission Prompt Resolution", () => {
    it("updates target conversation messages without mutating active conversation when resolving background prompt", async () => {
      mockApiPost.mockResolvedValueOnce({ ok: true });

      const activeMsgs: MessageDTO[] = [
        {
          id: "m-active",
          role: "assistant",
          content: "Active",
          createdAt: new Date().toISOString(),
        },
      ];
      const bgMsgs: MessageDTO[] = [
        {
          id: "m-bg",
          role: "assistant",
          content: "BG",
          createdAt: new Date().toISOString(),
          liveToolCalls: [
            {
              id: "tc-123",
              name: "file_write",
              arguments: "{}",
              status: "running",
            },
          ],
        },
      ];

      useAppStore.setState({
        activeConversationId: "conv-active",
        messages: activeMsgs,
        messagesByConversation: {
          "conv-active": activeMsgs,
          "conv-bg": bgMsgs,
        },
        permissionPrompt: {
          id: "perm-bg-1",
          conversationId: "conv-bg",
          action: "file.write",
          target: "src/file.ts",
          toolCallId: "tc-123",
          createdAt: Date.now(),
          resolve: vi.fn(),
        },
      });

      await useAppStore.getState().resolvePermissionPrompt("perm-bg-1", "deny");

      const state = useAppStore.getState();
      // Active messages untouched
      expect(state.messages).toEqual(activeMsgs);
      // Background conversation messages updated with optimistic error
      const updatedBgMsgs = state.messagesByConversation["conv-bg"];
      expect(updatedBgMsgs?.[0]?.liveToolCalls?.[0]?.status).toBe("error");
      expect(state.permissionPrompt).toBeNull();
    });
  });

  describe("deleteConversation State Reset", () => {
    it("resets checkpoints, subagents, questionPrompt, and permissionPrompt when active conversation is deleted", async () => {
      mockApiDelete.mockResolvedValueOnce({ ok: true });

      useAppStore.setState({
        conversations: [{ id: "conv-active", title: "Active", mode: "agent" } as any],
        activeConversationId: "conv-active",
        messages: [{ id: "m1", role: "user", content: "hi", createdAt: new Date().toISOString() }],
        checkpoints: [{ id: "cp-1", label: "Initial" } as any],
        subagents: [{ id: "sa-1", name: "Researcher" } as any],
        questionPrompt: { id: "qp-1", conversationId: "conv-active", toolCallId: "tc-1", questions: [] },
        permissionPrompt: { id: "pp-1", action: "cmd", target: "ls", createdAt: Date.now(), resolve: vi.fn() },
      });

      await useAppStore.getState().deleteConversation("conv-active");

      const state = useAppStore.getState();
      expect(state.activeConversationId).toBeNull();
      expect(state.messages).toEqual([]);
      expect(state.checkpoints).toEqual([]);
      expect(state.subagents).toEqual([]);
      expect(state.questionPrompt).toBeNull();
      expect(state.permissionPrompt).toBeNull();
    });
  });

  describe("openFileTab LRU Eviction with Split Editor Protection", () => {
    it("protects both activeFileTab and splitEditorFile when evicting at MAX_OPEN_TABS", () => {
      const initialTabs = [
        "tab-0.ts",
        "tab-1.ts",
        "tab-2.ts",
        "tab-3.ts",
        "tab-4.ts",
        "tab-5.ts",
        "tab-6.ts",
        "tab-7.ts",
        "tab-8.ts",
        "tab-9.ts", // 10 tabs (MAX_OPEN_TABS)
      ];

      useAppStore.setState({
        openFiles: [...initialTabs],
        activeFileTab: "tab-0.ts",
        splitEditorFile: "tab-1.ts",
      });

      // Opening a new 11th tab should evict the first non-active, non-split tab (which is tab-2.ts)
      useAppStore.getState().openFileTab("tab-new.ts");

      const state = useAppStore.getState();
      expect(state.openFiles).toContain("tab-0.ts"); // activeFileTab preserved
      expect(state.openFiles).toContain("tab-1.ts"); // splitEditorFile preserved
      expect(state.openFiles).not.toContain("tab-2.ts"); // evicted
      expect(state.openFiles).toContain("tab-new.ts"); // newly added
      expect(state.openFiles.length).toBe(10);
      expect(state.activeFileTab).toBe("tab-new.ts");
    });
  });

  describe("Parallel Chats & Cross-Session Isolation", () => {
    it("stores and scopes permission prompts per conversation without overwriting active prompt", () => {
      useAppStore.setState({
        activeConversationId: "conv-1",
        permissionPrompt: null,
        permissionPromptsByConversation: {},
      });

      // Background chat requests permission
      useAppStore.getState().setPermissionPrompt(
        {
          id: "perm-bg",
          conversationId: "conv-2",
          action: "execute_command",
          target: "npm test",
          createdAt: Date.now(),
          resolve: vi.fn(),
        },
        "conv-2",
      );

      let state = useAppStore.getState();
      expect(state.permissionPromptsByConversation["conv-2"]?.id).toBe("perm-bg");
      expect(state.permissionPrompt).toBeNull(); // Active conversation has no prompt

      // Active chat requests permission
      useAppStore.getState().setPermissionPrompt(
        {
          id: "perm-active",
          conversationId: "conv-1",
          action: "write_file",
          target: "index.ts",
          createdAt: Date.now(),
          resolve: vi.fn(),
        },
        "conv-1",
      );

      state = useAppStore.getState();
      expect(state.permissionPromptsByConversation["conv-1"]?.id).toBe("perm-active");
      expect(state.permissionPromptsByConversation["conv-2"]?.id).toBe("perm-bg");
      expect(state.permissionPrompt?.id).toBe("perm-active");
    });

    it("restores conversation-scoped permission and question prompts on selectConversation", async () => {
      useAppStore.setState({
        activeConversationId: "conv-1",
        permissionPromptsByConversation: {
          "conv-2": {
            id: "perm-2",
            conversationId: "conv-2",
            action: "cmd",
            target: "git status",
            createdAt: Date.now(),
            resolve: vi.fn(),
          },
        },
        questionPromptsByConversation: {
          "conv-2": {
            id: "quest-2",
            conversationId: "conv-2",
            questions: [{ question: "Deploy now?", options: ["Yes", "No"] }],
            createdAt: Date.now(),
          },
        },
      });

      mockApiGet.mockResolvedValue({ conversation: { id: "conv-2", messages: [] } });

      await useAppStore.getState().selectConversation("conv-2");

      const state = useAppStore.getState();
      expect(state.activeConversationId).toBe("conv-2");
      expect(state.permissionPrompt?.id).toBe("perm-2");
      expect(state.questionPrompt?.id).toBe("quest-2");
    });

    it("isolates background message streaming so active messages are never contaminated", () => {
      const activeMsgs = [{ id: "m-active-1", role: "user" as const, content: "hello from active", createdAt: new Date().toISOString() }];
      useAppStore.setState({
        activeConversationId: "conv-active",
        messages: [...activeMsgs],
        messagesByConversation: {
          "conv-active": [...activeMsgs],
        },
        streamingStateByConversation: {
          "conv-bg": { isStreaming: true, streamingMessageId: "m-bg-assistant" },
        },
      });

      // Streaming events arriving for background conversation
      useAppStore.getState().appendAssistantPlaceholder("m-bg-assistant", "conv-bg");
      useAppStore.getState().appendSegmentText("m-bg-assistant", "Background text delta", "conv-bg");
      useAppStore.getState().startToolCall("tc-bg-1", "edit_file", "conv-bg");
      useAppStore.getState().finishToolCall("tc-bg-1", { path: "src/test.ts" }, true, "conv-bg");

      const state = useAppStore.getState();
      // Active messages must remain exactly unchanged!
      expect(state.messages).toEqual(activeMsgs);

      // Background messages must contain the assistant message with its tool calls
      const bgMsgs = state.messagesByConversation["conv-bg"];
      expect(bgMsgs).toBeDefined();
      expect(bgMsgs?.length).toBe(1);
      expect(bgMsgs?.[0]?.content).toBe("Background text delta");
      expect(bgMsgs?.[0]?.liveToolCalls?.[0]?.name).toBe("edit_file");
      expect(bgMsgs?.[0]?.liveToolCalls?.[0]?.status).toBe("done");
    });

    it("refreshes background conversation messages without discarding server updates", async () => {
      useAppStore.setState({
        activeConversationId: "conv-active",
        messages: [{ id: "m-act", role: "user", content: "active text", createdAt: new Date().toISOString() }],
        messagesByConversation: {},
      });

      mockApiGet.mockResolvedValueOnce({
        conversation: {
          id: "conv-bg",
          isAgentRunning: false,
          messages: [
            { id: "m-bg-1", role: "user", content: "background task", createdAt: new Date().toISOString() },
            { id: "m-bg-2", role: "assistant", content: "completed work in background", createdAt: new Date().toISOString() },
          ],
        },
      });

      await useAppStore.getState().refreshMessages("conv-bg");

      const state = useAppStore.getState();
      // Active messages remain untouched
      expect(state.messages[0]?.content).toBe("active text");

      // Background conversation cache is populated with server messages
      const bgMsgs = state.messagesByConversation["conv-bg"];
      expect(bgMsgs?.length).toBe(2);
      expect(bgMsgs?.[1]?.content).toBe("completed work in background");
    });

    it("clears prompts globally across all sessions when prompt is null without conversationId", () => {
      useAppStore.setState({
        activeConversationId: "conv-1",
        permissionPrompt: { id: "p1", conversationId: "conv-1", action: "test", createdAt: 1, resolve: vi.fn() },
        questionPrompt: { id: "q1", conversationId: "conv-1", questions: [], createdAt: 1 },
        permissionPromptsByConversation: {
          "conv-1": { id: "p1", conversationId: "conv-1", action: "test", createdAt: 1, resolve: vi.fn() },
          "conv-2": { id: "p2", conversationId: "conv-2", action: "test2", createdAt: 2, resolve: vi.fn() },
        },
        questionPromptsByConversation: {
          "conv-1": { id: "q1", conversationId: "conv-1", questions: [], createdAt: 1 },
          "conv-2": { id: "q2", conversationId: "conv-2", questions: [], createdAt: 2 },
        },
      });

      // Global clear
      useAppStore.getState().setQuestionPrompt(null);
      useAppStore.getState().setPermissionPrompt(null);

      const state = useAppStore.getState();
      expect(state.permissionPrompt).toBeNull();
      expect(state.questionPrompt).toBeNull();
      expect(state.permissionPromptsByConversation).toEqual({});
      expect(state.questionPromptsByConversation).toEqual({});
    });

    it("clears prompt for specific background session without disturbing active session", () => {
      useAppStore.setState({
        activeConversationId: "conv-1",
        permissionPrompt: { id: "p1", conversationId: "conv-1", action: "test", createdAt: 1, resolve: vi.fn() },
        questionPrompt: { id: "q1", conversationId: "conv-1", questions: [], createdAt: 1 },
        permissionPromptsByConversation: {
          "conv-1": { id: "p1", conversationId: "conv-1", action: "test", createdAt: 1, resolve: vi.fn() },
          "conv-2": { id: "p2", conversationId: "conv-2", action: "test2", createdAt: 2, resolve: vi.fn() },
        },
        questionPromptsByConversation: {
          "conv-1": { id: "q1", conversationId: "conv-1", questions: [], createdAt: 1 },
          "conv-2": { id: "q2", conversationId: "conv-2", questions: [], createdAt: 2 },
        },
      });

      // Clear specific background session conv-2
      useAppStore.getState().setQuestionPrompt(null, "conv-2");
      useAppStore.getState().setPermissionPrompt(null, "conv-2");

      const state = useAppStore.getState();
      // Active prompt is preserved
      expect(state.permissionPrompt?.id).toBe("p1");
      expect(state.questionPrompt?.id).toBe("q1");
      expect(state.permissionPromptsByConversation["conv-1"]?.id).toBe("p1");
      expect(state.questionPromptsByConversation["conv-1"]?.id).toBe("q1");
      // Background session conv-2 is cleared
      expect(state.permissionPromptsByConversation["conv-2"]).toBeUndefined();
      expect(state.questionPromptsByConversation["conv-2"]).toBeUndefined();
    });
  });

  describe("Office Studio Routing & State Management", () => {
    it("routes office documents (.pptx, .docx, .pdf) exclusively to the Office tab without adding to openFiles", () => {
      useAppStore.setState({
        openFiles: ["src/index.ts"],
        activeFileTab: "src/index.ts",
        rightPanelTab: "files",
      });

      useAppStore.getState().openFileTab("presentation.pptx");
      const state1 = useAppStore.getState();
      expect(state1.rightPanelTab).toBe("office");
      expect(state1.openFiles).not.toContain("presentation.pptx");
      expect(state1.activeFileTab).toBe("src/index.ts");

      useAppStore.getState().openFileTab("docs/summary.docx");
      const state2 = useAppStore.getState();
      expect(state2.rightPanelTab).toBe("office");
      expect(state2.openFiles).not.toContain("docs/summary.docx");

      useAppStore.getState().openFileTab("report.pdf");
      const state3 = useAppStore.getState();
      expect(state3.rightPanelTab).toBe("office");
      expect(state3.openFiles).not.toContain("report.pdf");
    });

    it("allows updating slide content and theme on activeOfficeDoc", () => {
      useAppStore.setState({
        activeOfficeDoc: {
          version: 1,
          path: "pitch.pptx",
          type: "presentation",
          title: "Pitch Deck",
          theme: "executive",
          slides: [
            { title: "Intro", bullets: ["Point 1"] },
            { title: "Metrics", bullets: ["99.9% Uptime"] },
          ],
          updatedAt: 1000,
        },
      });

      useAppStore.getState().updateActiveOfficeSlide(1, {
        title: "Updated Metrics",
        bullets: ["99.99% High Availability", "140+ tokens/sec"],
      });

      const updated = useAppStore.getState().activeOfficeDoc;
      expect(updated?.slides?.[1].title).toBe("Updated Metrics");
      expect(updated?.slides?.[1].bullets?.length).toBe(2);

      useAppStore.getState().setActiveOfficeTheme("emerald");
      expect(useAppStore.getState().activeOfficeDoc?.theme).toBe("emerald");
    });
  });
});
