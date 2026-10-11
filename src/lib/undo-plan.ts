/**
 * Shared wire types for the Confirm Undo flow (client + server).
 * The server computes the plan (POST undo-preview) and re-verifies it on
 * confirm (DELETE with expected hashes); the dialog renders it. No runtime
 * code here — safe to import from client bundles.
 */

export interface UndoPreviewFile {
  /** Absolute path (also the verify key). */
  path: string;
  /** Root-relative (or basename) display path for the dialog. */
  display: string;
  /** Lines that will be ADDED back (agent had deleted them). Green +N. */
  restored: number;
  /** Lines that will be REMOVED (agent had added them). Red −N. */
  removed: number;
  status: "modified" | "created" | "missing";
  /** Current on-disk sha1 (null when missing) — echoed back on confirm. */
  hash: string | null;
}

export interface UndoPreviewExpected {
  path: string;
  hash: string | null;
}

export interface UndoPreview {
  files: UndoPreviewFile[];
  expected: UndoPreviewExpected[];
  attempted: number;
  dirsRemoved: number;
}
