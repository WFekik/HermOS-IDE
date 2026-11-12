// @vitest-environment jsdom
import * as React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { GitPanel } from "./git-panel";
import { useAppStore } from "@/stores/app-store";
import { apiGet } from "@/lib/api-client";

vi.mock("@/lib/api-client", () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiDelete: vi.fn(),
  ApiRequestError: class ApiRequestError extends Error {
    status = 500;
  },
}));

vi.mock("@/hooks/use-translation", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (params?.count !== undefined) return `${key}:${params.count}`;
      return key;
    },
  }),
}));

vi.mock("@/components/ide/git-diff-view", () => ({
  GitDiffView: ({ diff }: { diff: string }) => <div data-testid="git-diff-view">{diff}</div>,
}));

describe("GitPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAppStore.setState({
      gitStatus: {
        branch: "main",
        ahead: 0,
        behind: 0,
        isRepo: true,
        clean: false,
        staged: [],
        modified: [
          { path: "src/app/api/_lib/helpers.ts", status: "M" },
          { path: "src/app/api/conversations/route.ts", status: "M" },
        ],
        untracked: [{ path: "new-file.ts", status: "?" }],
        commits: [],
        branches: [],
        worktrees: [],
      } as any,
      gitStatusLoading: false,
      gitStatusError: null,
      rightPanelTab: "git",
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("opens diff dialog for a specific file when clicking a modified file row instead of switching tabs", async () => {
    vi.mocked(apiGet).mockResolvedValue({
      isRepo: true,
      diff: {
        files: [
          {
            path: "src/app/api/_lib/helpers.ts",
            patch: "diff --git a/src/app/api/_lib/helpers.ts b/src/app/api/_lib/helpers.ts\n+added line",
          },
        ],
      },
    });

    render(<GitPanel />);

    const fileButton = screen.getByRole("button", { name: /src\/app\/api\/_lib\/helpers\.ts/i });
    fireEvent.click(fileButton);

    // Verify it called /api/git/diff with the path
    await waitFor(() => {
      expect(apiGet).toHaveBeenCalledWith(
        expect.stringContaining("/api/git/diff?path=src%2Fapp%2Fapi%2F_lib%2Fhelpers.ts"),
      );
    });

    // Panel tab must NOT be switched to "files"
    expect(useAppStore.getState().rightPanelTab).toBe("git");

    // Diff view must render the file's patch
    expect(await screen.findByTestId("git-diff-view")).toBeDefined();
    expect(screen.getByText(/diff --git a\/src\/app\/api\/_lib\/helpers\.ts/)).toBeDefined();
  });

  it("opens full diff when 'View diff' button is clicked", async () => {
    vi.mocked(apiGet).mockResolvedValue({
      isRepo: true,
      diff: {
        files: [
          { path: "file1.ts", patch: "diff1" },
          { path: "file2.ts", patch: "diff2" },
        ],
      },
    });

    render(<GitPanel />);

    const viewDiffBtn = screen.getByRole("button", { name: /view_full_diff/i });
    fireEvent.click(viewDiffBtn);

    await waitFor(() => {
      expect(apiGet).toHaveBeenCalledWith("/api/git/diff");
    });

    expect(await screen.findByTestId("git-diff-view")).toBeDefined();
    expect(screen.getByText(/diff1[\s\S]*diff2/)).toBeDefined();
  });

  it("allows switching back to full diff from single file diff view", async () => {
    vi.mocked(apiGet).mockImplementation(async (url: string) => {
      if (url.includes("path=")) {
        return {
          isRepo: true,
          diff: { files: [{ path: "single.ts", patch: "patch-single" }] },
        };
      }
      return {
        isRepo: true,
        diff: { files: [{ path: "all.ts", patch: "patch-all" }] },
      };
    });

    render(<GitPanel />);

    const fileButton = screen.getByRole("button", { name: /src\/app\/api\/_lib\/helpers\.ts/i });
    fireEvent.click(fileButton);

    expect(await screen.findByText("patch-single")).toBeDefined();

    // Click "view_full_diff" inside dialog header
    const viewFullBtn = screen.getByText(/view_full_diff/i);
    fireEvent.click(viewFullBtn);

    await waitFor(() => {
      expect(apiGet).toHaveBeenCalledWith("/api/git/diff");
    });
    expect(await screen.findByText("patch-all")).toBeDefined();
  });
});
