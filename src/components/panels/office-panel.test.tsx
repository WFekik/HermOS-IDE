// @vitest-environment jsdom
import * as React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { OfficePanel } from "./office-panel";
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
    t: (key: string) => key,
  }),
}));

describe("OfficePanel Empty State & Document Hub", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAppStore.setState({
      activeOfficeDoc: null,
      activeWorkspace: {
        id: "ws-1",
        name: "Test Workspace",
        rootDir: "/tmp/ws",
      } as any,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the empty state starters when no documents exist and no active doc is set", async () => {
    vi.mocked(apiGet).mockResolvedValueOnce({
      ok: true,
      documents: [],
    } as any);

    render(<OfficePanel />);

    await waitFor(() => {
      expect(screen.getByText("HermOS Office Studio")).toBeTruthy();
    });
    expect(screen.getByText("Step-by-Step Agent Starters:")).toBeTruthy();
  });

  it("renders Document Hub workspace cards when documents exist but no document is active (eliminating black void)", async () => {
    vi.mocked(apiGet).mockResolvedValueOnce({
      ok: true,
      documents: [
        {
          path: "report.pdf",
          relPath: "report.pdf",
          name: "report.pdf",
          type: "pdf",
          size: 45000,
          updatedAt: Date.now(),
        },
        {
          path: "presentation.pptx",
          relPath: "presentation.pptx",
          name: "presentation.pptx",
          type: "presentation",
          size: 120000,
          updatedAt: Date.now(),
        },
      ],
    } as any);

    render(<OfficePanel />);

    await waitFor(() => {
      expect(screen.getByText("Workspace Office Documents")).toBeTruthy();
    });
    expect(screen.getAllByText("report.pdf").length).toBeGreaterThan(0);
    expect(screen.getAllByText("presentation.pptx").length).toBeGreaterThan(0);
  });

  it("renders the active document studio interface when an activeOfficeDoc is present", async () => {
    useAppStore.setState({
      activeOfficeDoc: {
        version: 1,
        path: "spec.docx",
        type: "document",
        title: "Technical Specification",
        theme: "executive",
        sections: [
          {
            id: "sec-1",
            heading: "Architecture Overview",
            paragraphs: ["Core system architecture details."],
          },
        ],
        updatedAt: Date.now(),
      } as any,
    });

    vi.mocked(apiGet).mockResolvedValueOnce({
      ok: true,
      documents: [
        {
          path: "spec.docx",
          relPath: "spec.docx",
          name: "spec.docx",
          type: "document",
          size: 24000,
          updatedAt: Date.now(),
        },
      ],
    } as any);

    render(<OfficePanel />);

    await waitFor(() => {
      expect(screen.getAllByText("Technical Specification").length).toBeGreaterThan(0);
    });
  });
});
