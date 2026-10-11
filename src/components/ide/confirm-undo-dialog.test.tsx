// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ConfirmUndoDialog } from "./confirm-undo-dialog";
import type { UndoPreview } from "@/lib/undo-plan";

vi.mock("@/hooks/use-translation", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string | number>) => {
      const table: Record<string, string> = {
        confirm_undo: "Confirm Undo",
        confirm_undo_desc: "Confirming this undo action will make the following changes:",
        revert_file_changes: "Revert file changes",
        undo_no_file_changes: "No file changes — only the transcript will be trimmed.",
        undo_folders_removed: `${params?.count ?? 0} folder(s) will be removed`,
        cancel: "Cancel",
        confirm: "Confirm",
      };
      return table[key] ?? key;
    },
    language: "en",
    isRtl: false,
  }),
}));

const PREVIEW: UndoPreview = {
  files: [
    {
      path: "/ws/user_manager.py",
      display: "user_manager.py",
      restored: 4,
      removed: 18,
      status: "modified",
      hash: "aaa",
    },
    {
      path: "/ws/sync_db.py",
      display: "sync_db.py",
      restored: 0,
      removed: 13,
      status: "created",
      hash: "bbb",
    },
  ],
  expected: [
    { path: "/ws/user_manager.py", hash: "aaa" },
    { path: "/ws/sync_db.py", hash: "bbb" },
  ],
  attempted: 2,
  dirsRemoved: 1,
};

describe("ConfirmUndoDialog", () => {
  it("lists files with inverted +/- stats (green adds, red removals)", () => {
    render(
      <ConfirmUndoDialog
        state={{ messageId: "m1", preview: PREVIEW }}
        confirming={false}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    );
    expect(screen.getByText("Confirm Undo")).toBeTruthy();
    expect(screen.getByText("user_manager.py")).toBeTruthy();
    expect(screen.getByText("sync_db.py")).toBeTruthy();
    // Inverted stats: +4 restored back, −18 removed.
    expect(screen.getByText("+4")).toBeTruthy();
    expect(screen.getByText("−18")).toBeTruthy();
    expect(screen.getByText("−13")).toBeTruthy();
    expect(screen.getByText("1 folder(s) will be removed")).toBeTruthy();
  });

  it("confirms with revertFiles=true by default, cancel closes", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmUndoDialog
        state={{ messageId: "m1", preview: PREVIEW }}
        confirming={false}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );
    fireEvent.click(screen.getByText("Confirm"));
    expect(onConfirm).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByText("Cancel"));
    expect(onCancel).toHaveBeenCalled();
  });

  it("unchecking revert skips file restore on confirm", () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmUndoDialog
        state={{ messageId: "m1", preview: PREVIEW }}
        confirming={false}
        onCancel={() => {}}
        onConfirm={onConfirm}
      />,
    );
    fireEvent.click(screen.getByText("Revert file changes"));
    fireEvent.click(screen.getByText("Confirm"));
    expect(onConfirm).toHaveBeenCalledWith(false);
  });

  it("shows the no-file-changes note for empty plans", () => {
    render(
      <ConfirmUndoDialog
        state={{ messageId: "m1", preview: { files: [], expected: [], attempted: 0, dirsRemoved: 0 } }}
        confirming={false}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    );
    expect(screen.getByText("No file changes — only the transcript will be trimmed.")).toBeTruthy();
  });
});
