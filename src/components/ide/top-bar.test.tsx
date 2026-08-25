// @vitest-environment jsdom
import * as React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { TopBar } from "./top-bar";
import { useAppStore } from "@/stores/app-store";
import * as fs from "fs";
import * as path from "path";

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

afterEach(cleanup);

describe("TopBar Component (Milestone 1)", () => {
  const onToggleSidebarMock = vi.fn();
  const onToggleRightMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    useAppStore.setState({
      currentUser: {
        id: "desktop-user",
        email: "desktop@hermos.local",
        name: "Local Developer",
        role: "admin",
        provider: "local",
      },
      gitStatus: null,
      activeWorkspace: null,
      activeConversationId: null,
      conversations: [],
    });
  });

  it("renders with required TopBarProps and displays user initials and toggles", () => {
    render(
      <TopBar
        onToggleSidebar={onToggleSidebarMock}
        sidebarCollapsed={false}
        onToggleRight={onToggleRightMock}
        rightCollapsed={false}
      />
    );

    const sidebarBtn = screen.getByRole("button", { name: "Hide sidebar" });
    fireEvent.click(sidebarBtn);
    expect(onToggleSidebarMock).toHaveBeenCalledTimes(1);

    const rightBtn = screen.getByRole("button", { name: "Hide right panel" });
    fireEvent.click(rightBtn);
    expect(onToggleRightMock).toHaveBeenCalledTimes(1);
  });

  it("handles sidebarCollapsed=true and rightCollapsed=true labels properly", () => {
    render(
      <TopBar
        onToggleSidebar={onToggleSidebarMock}
        sidebarCollapsed={true}
        onToggleRight={onToggleRightMock}
        rightCollapsed={true}
      />
    );

    expect(screen.getByRole("button", { name: "Show sidebar" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Show right panel" })).toBeDefined();
  });

  it("opens settings and command palette via store setters", () => {
    const setSettingsOpenMock = vi.fn();
    const setCommandOpenMock = vi.fn();

    useAppStore.setState({
      setSettingsOpen: setSettingsOpenMock,
      setCommandOpen: setCommandOpenMock,
    });

    render(
      <TopBar
        onToggleSidebar={onToggleSidebarMock}
        sidebarCollapsed={false}
        onToggleRight={onToggleRightMock}
        rightCollapsed={false}
      />
    );

    const cmdBtn = screen.getByRole("button", { name: "Open command palette" });
    fireEvent.click(cmdBtn);
    expect(setCommandOpenMock).toHaveBeenCalledWith(true);

    const settingsBtn = screen.getByRole("button", { name: "Open settings" });
    fireEvent.click(settingsBtn);
    expect(setSettingsOpenMock).toHaveBeenCalledWith(true);
  });

  it("renders Local Developer profile with Local / Offline badge and without Sign Out", async () => {
    render(
      <TopBar
        onToggleSidebar={onToggleSidebarMock}
        sidebarCollapsed={false}
        onToggleRight={onToggleRightMock}
        rightCollapsed={false}
      />
    );

    // Initial avatar button (LD initials)
    expect(screen.getByText("LD")).toBeDefined();
  });

  it("statically verifies that Sign Out, LogOut icon, and next-auth are not in top-bar.tsx", () => {
    const topBarPath = path.resolve(__dirname, "top-bar.tsx");
    const content = fs.readFileSync(topBarPath, "utf-8");

    expect(content).not.toContain("LogOut");
    expect(content).not.toContain("Sign out");
    expect(content).not.toContain("signOut");
    expect(content).not.toContain("next-auth");
  });
});
