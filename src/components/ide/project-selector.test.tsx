// @vitest-environment jsdom
import * as React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, act } from "@testing-library/react";
import { ProjectSelector } from "./project-selector";
import { useAppStore } from "@/stores/app-store";

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

afterEach(cleanup);

describe("ProjectSelector", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAppStore.setState({
      workspaces: [
        { id: "ws-1", name: "HermOS IDE", rootDir: "c:\\HermOS IDE", isActive: true },
        { id: "ws-2", name: "moumen", rootDir: "d:\\moumen", isActive: false },
        { id: "ws-3", name: "pfe + mfe", rootDir: "d:\\pfe + mfe", isActive: false },
      ],
      activeWorkspace: { id: "ws-1", name: "HermOS IDE", rootDir: "c:\\HermOS IDE", isActive: true },
      refreshWorkspaces: vi.fn().mockResolvedValue(undefined),
    });
  });

  it("renders active workspace name as trigger", () => {
    render(<ProjectSelector />);
    expect(screen.getByText("c:\\HermOS IDE")).toBeDefined();
  });

  it("opens popover and lists workspaces with actions", async () => {
    render(<ProjectSelector />);
    const trigger = screen.getByRole("button", { name: /Current project/i });
    await act(async () => {
      fireEvent.click(trigger);
    });

    expect(screen.getByText("d:\\moumen")).toBeDefined();
    expect(screen.getByText("d:\\pfe + mfe")).toBeDefined();
    // In jsdom (non-Tauri) the label is sandboxed; in Tauri it shows "Open Folder / New Project"
    expect(
      screen.queryByText("Open Folder / New Project") ?? screen.getByText("New workspace (sandboxed)"),
    ).toBeDefined();
  });

  it("switches workspace and creates new conversation when selecting a project", async () => {
    const switchWorkspaceMock = vi.fn().mockResolvedValue(true);
    const createConversationMock = vi.fn().mockResolvedValue({ id: "conv-new" });

    useAppStore.setState({
      switchWorkspace: switchWorkspaceMock,
      createConversation: createConversationMock,
    });

    render(<ProjectSelector />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Current project/i }));
    });

    const moumenBtn = screen.getByText("d:\\moumen");
    await act(async () => {
      fireEvent.click(moumenBtn);
    });

    await waitFor(() => {
      expect(switchWorkspaceMock).toHaveBeenCalledWith("ws-2", "moumen", { skipAutoSelectConversation: true });
      expect(createConversationMock).toHaveBeenCalledWith({ workspaceId: "ws-2" });
    });
  });
});
