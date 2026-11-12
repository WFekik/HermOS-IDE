// @vitest-environment jsdom
import * as React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { ArtifactPanel } from "./artifact-panel";
import { useAppStore } from "@/stores/app-store";
import { apiGet } from "@/lib/api-client";

vi.mock("@/lib/api-client", () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiDelete: vi.fn().mockResolvedValue({}),
  ApiRequestError: class ApiRequestError extends Error {
    status = 500;
  },
}));

vi.mock("@/hooks/use-translation", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

describe("ArtifactPanel scoping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAppStore.setState({
      activeConversationId: "conv-1",
      selectedProjectId: "project-1",
      artifactsList: ["implementation_plan.md"],
      activeArtifactPath: "implementation_plan.md",
      artifactsByConversation: {
        "conv-1": ["implementation_plan.md"],
        "conv-2": ["other_secret_doc.md"],
      },
      activeArtifactByConversation: {
        "conv-1": "implementation_plan.md",
        "conv-2": "other_secret_doc.md",
      },
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the active artifact tab belonging to the current conversation", async () => {
    vi.mocked(apiGet).mockResolvedValue({ content: "# Implementation Plan\n\nStep 1" });

    render(<ArtifactPanel />);

    await waitFor(() => {
      expect(screen.getByText("implementation_plan.md")).toBeDefined();
    });

    // Should not render artifacts belonging to conv-2
    expect(screen.queryByText("other_secret_doc.md")).toBeNull();
  });

  it("renders empty state when current conversation has no artifacts", async () => {
    useAppStore.setState({
      activeConversationId: "conv-3",
      artifactsList: [],
      activeArtifactPath: null,
    });

    render(<ArtifactPanel />);

    expect(screen.getByText("no_artifacts_selected")).toBeDefined();
    expect(screen.queryByText("implementation_plan.md")).toBeNull();
    expect(screen.queryByText("other_secret_doc.md")).toBeNull();
  });

  it("dynamically synchronizes and switches content when active conversation changes", async () => {
    vi.mocked(apiGet).mockImplementation(async (url: string) => {
      if (url.includes("conv-1")) {
        return { content: "# Conv 1 Implementation Plan" };
      }
      if (url.includes("conv-2")) {
        return { content: "# Conv 2 Other Secret Doc" };
      }
      return { content: "" };
    });

    const { rerender } = render(<ArtifactPanel />);

    await waitFor(() => {
      expect(screen.getByText("implementation_plan.md")).toBeDefined();
    });

    // Switch to conv-2 in store
    useAppStore.setState({
      activeConversationId: "conv-2",
      artifactsList: ["other_secret_doc.md"],
      activeArtifactPath: "other_secret_doc.md",
    });

    rerender(<ArtifactPanel />);

    await waitFor(() => {
      expect(screen.getByText("other_secret_doc.md")).toBeDefined();
    });
    expect(screen.queryByText("implementation_plan.md")).toBeNull();

    // Switch to conv-3 (empty)
    useAppStore.setState({
      activeConversationId: "conv-3",
      artifactsList: [],
      activeArtifactPath: null,
    });

    rerender(<ArtifactPanel />);

    await waitFor(() => {
      expect(screen.getByText("no_artifacts_selected")).toBeDefined();
    });
    expect(screen.queryByText("other_secret_doc.md")).toBeNull();
    expect(screen.queryByText("implementation_plan.md")).toBeNull();
  });

  it("resets artifacts and active path when switching to pending conversation", async () => {
    useAppStore.setState({
      activeConversationId: "conv-1",
      artifactsList: ["implementation_plan.md"],
      activeArtifactPath: "implementation_plan.md",
      rightPanelTab: "artifacts",
      pendingConversations: [{ id: "pending-new-1", title: "New conversation" } as any],
    });

    await useAppStore.getState().selectConversation("pending-new-1");

    const st = useAppStore.getState();
    expect(st.activeConversationId).toBe("pending-new-1");
    expect(st.artifactsList).toEqual([]);
    expect(st.activeArtifactPath).toBeNull();
  });

  it("preserves scoped artifacts and active artifact paths per conversation", async () => {
    useAppStore.setState({
      activeConversationId: "conv-1",
      selectedProjectId: "ws-1",
      artifactsList: ["plan.md"],
      activeArtifactPath: "plan.md",
      rightPanelTab: "artifacts",
      artifactsByConversation: {
        "conv-1": ["plan.md"],
        "conv-2": [],
      },
      activeArtifactByConversation: {
        "conv-1": "plan.md",
        "conv-2": null,
      },
      conversations: [
        { id: "conv-1", title: "First Conv", workspaceId: "ws-1" } as any,
        { id: "conv-2", title: "Second Conv", workspaceId: "ws-1" } as any,
      ],
    });

    // Switch to conv-2 (empty of artifacts)
    await useAppStore.getState().selectConversation("conv-2");
    let st = useAppStore.getState();
    expect(st.activeConversationId).toBe("conv-2");
    expect(st.artifactsList).toEqual([]);
    expect(st.activeArtifactPath).toBeNull();

    // Switch back to conv-1
    await useAppStore.getState().selectConversation("conv-1");
    st = useAppStore.getState();
    expect(st.activeConversationId).toBe("conv-1");
    expect(st.artifactsList).toEqual(["plan.md"]);
    expect(st.activeArtifactPath).toBe("plan.md");
  });

  it("clears artifactsList, activeArtifactPath, and scoped cache when active conversation is deleted", async () => {
    useAppStore.setState({
      activeConversationId: "conv-1",
      artifactsList: ["plan.md"],
      activeArtifactPath: "plan.md",
      artifactsByConversation: {
        "conv-1": ["plan.md"],
        "conv-2": ["other.md"],
      },
      activeArtifactByConversation: {
        "conv-1": "plan.md",
        "conv-2": "other.md",
      },
      conversations: [
        { id: "conv-1", title: "First Conv" } as any,
        { id: "conv-2", title: "Second Conv" } as any,
      ],
    });

    await useAppStore.getState().deleteConversation("conv-1");

    const st = useAppStore.getState();
    expect(st.activeConversationId).toBeNull();
    expect(st.artifactsList).toEqual([]);
    expect(st.activeArtifactPath).toBeNull();
    expect(st.artifactsByConversation["conv-1"]).toBeUndefined();
    expect(st.activeArtifactByConversation["conv-1"]).toBeUndefined();
    // conv-2 remains intact
    expect(st.artifactsByConversation["conv-2"]).toEqual(["other.md"]);
    expect(st.activeArtifactByConversation["conv-2"]).toBe("other.md");
  });
});
