import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";

// Mock prisma db dependency in checkpoints
vi.mock("@/lib/db", () => ({
  db: {
    conversation: {
      findUnique: vi.fn().mockResolvedValue({ id: "conv-test-1", userId: "user-test-1" }),
    },
  },
}));

import {
  createCheckpoint,
  snapshotFile,
  trackNewFile,
  trackNewDir,
  restoreCheckpointsSinceTimestamp,
  restoreCheckpoint,
  buildUndoPreview,
  sha1Hex,
  getSafeRelativePath,
  deleteConversationCheckpoints,
  listCheckpoints,
} from "@/lib/checkpoints";

describe("Multi-Turn Checkpoint & Undo System", () => {
  let tmpDir: string;
  const userId = "user-test-1";
  const conversationId = "conv-test-1";

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hermos-cp-test-"));
  });

  afterEach(async () => {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("should restore multi-turn file edits and new directories in reverse chronological order", async () => {
    const fileA = path.join(tmpDir, "fileA.txt");
    const fileB = path.join(tmpDir, "fileB.txt");
    const newDir = path.join(tmpDir, "subfolder");
    const newFileC = path.join(newDir, "fileC.txt");

    // Initial state before Turn 1
    await fs.writeFile(fileA, "Original File A Content", "utf-8");
    await fs.writeFile(fileB, "Original File B Content", "utf-8");

    const t1 = Date.now();
    const cp1 = await createCheckpoint(userId, conversationId, "Turn 1");

    // Turn 1 edits fileA
    await snapshotFile(userId, conversationId, cp1.id, fileA);
    await fs.writeFile(fileA, "Turn 1 Modified File A", "utf-8");

    // Turn 2
    await new Promise((r) => setTimeout(r, 20));
    const t2 = Date.now();
    const cp2 = await createCheckpoint(userId, conversationId, "Turn 2");

    // Turn 2 edits fileA again and edits fileB
    await snapshotFile(userId, conversationId, cp2.id, fileA);
    await fs.writeFile(fileA, "Turn 2 Modified File A", "utf-8");

    await snapshotFile(userId, conversationId, cp2.id, fileB);
    await fs.writeFile(fileB, "Turn 2 Modified File B", "utf-8");

    // Turn 3 (Subagent creates new directory and new file)
    await new Promise((r) => setTimeout(r, 20));
    const cp3 = await createCheckpoint(userId, conversationId, "Turn 3");

    await fs.mkdir(newDir, { recursive: true });
    await trackNewDir(userId, conversationId, cp3.id, newDir);

    await fs.writeFile(newFileC, "Created by subagent", "utf-8");
    await trackNewFile(userId, conversationId, cp3.id, newFileC);

    // Verify current state before Undo
    expect(await fs.readFile(fileA, "utf-8")).toBe("Turn 2 Modified File A");
    expect(await fs.readFile(fileB, "utf-8")).toBe("Turn 2 Modified File B");
    expect(await fs.readFile(newFileC, "utf-8")).toBe("Created by subagent");

    // Undo back to Turn 1 timestamp (should revert Turns 3, 2, 1 in reverse order)
    const result = await restoreCheckpointsSinceTimestamp(userId, conversationId, t1);
    expect(result.ok).toBe(true);

    // Verify workspace is restored to exact initial state
    expect(await fs.readFile(fileA, "utf-8")).toBe("Original File A Content");
    expect(await fs.readFile(fileB, "utf-8")).toBe("Original File B Content");
    expect(await fs.stat(newFileC).catch(() => null)).toBeNull();
    expect(await fs.stat(newDir).catch(() => null)).toBeNull();
  });

  it("should safely convert Windows and POSIX absolute paths to relative paths without colons", () => {
    const p1 = getSafeRelativePath("C:\\Users\\ASUS\\repo\\src\\index.ts");
    expect(p1.includes(":")).toBe(false);
    expect(p1.startsWith("drive-C")).toBe(true);

    const p2 = getSafeRelativePath("c:/Users/ASUS/repo/src/index.ts");
    expect(p2.includes(":")).toBe(false);
    expect(p2.startsWith("drive-C")).toBe(true);

    const p3 = getSafeRelativePath("/home/user/project/src/index.ts");
    expect(p3.includes(":")).toBe(false);
    expect(p3).toBe("home/user/project/src/index.ts".replace(/\//g, path.sep));
  });

  it("should completely delete all checkpoints for a conversation", async () => {
    const convId = "conv-delete-test";
    const cp = await createCheckpoint(userId, convId, "Turn 1");
    expect(cp.id).toBeDefined();

    let list = await listCheckpoints(userId, convId);
    expect(list.length).toBeGreaterThanOrEqual(1);

    await deleteConversationCheckpoints(userId, convId);

    list = await listCheckpoints(userId, convId);
    expect(list.length).toBe(0);
  });
});

describe("Undo truth propagation (no silent partial success)", () => {
  let tmpDir: string;
  const userId = "user-test-1";
  const conversationId = "conv-truth-test";

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hermos-cp-truth-"));
  });

  afterEach(async () => {
    await deleteConversationCheckpoints(userId, conversationId).catch(() => {});
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("collects per-checkpoint failures, keeps failed checkpoints, reports ok:false", async () => {
    const inside = path.join(tmpDir, "inside.txt");
    const outside = path.join(tmpDir, "outer", "outside.txt");
    await fs.mkdir(path.dirname(outside), { recursive: true });
    await fs.writeFile(inside, "v1", "utf-8");
    await fs.writeFile(outside, "v1", "utf-8");

    const t0 = Date.now();
    const cp = await createCheckpoint(userId, conversationId, "turn");
    await snapshotFile(userId, conversationId, cp.id, inside);
    await snapshotFile(userId, conversationId, cp.id, outside);
    await fs.writeFile(inside, "v2", "utf-8");
    await fs.writeFile(outside, "v2", "utf-8");

    // Contain restores to tmpDir itself: `outside` (in tmpDir/outer) still
    // passes, so scope tighter — restore with a root that excludes BOTH by
    // pointing at an empty dir: every target throws containment.
    const fenced = await fs.mkdtemp(path.join(os.tmpdir(), "hermos-cp-fence-"));
    try {
      const result = await restoreCheckpointsSinceTimestamp(userId, conversationId, t0, {
        workspaceRoot: fenced,
      });
      expect(result.attempted).toBe(1);
      expect(result.ok).toBe(false);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0].id).toBe(cp.id);
      expect(result.restoredFiles).toEqual([]);
      // Failed checkpoints are NOT purged — a later retry can still apply them.
      const remaining = await listCheckpoints(userId, conversationId);
      expect(remaining.some((c) => c.id === cp.id)).toBe(true);
      // And nothing was written through the refused gate.
      expect(await fs.readFile(inside, "utf-8")).toBe("v2");
      expect(await fs.readFile(outside, "utf-8")).toBe("v2");
    } finally {
      await fs.rm(fenced, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("first snapshot wins under concurrent snapshotFile calls", async () => {
    const file = path.join(tmpDir, "race.txt");
    await fs.writeFile(file, "original", "utf-8");
    const cp = await createCheckpoint(userId, conversationId, "turn");
    await Promise.all([
      snapshotFile(userId, conversationId, cp.id, file),
      snapshotFile(userId, conversationId, cp.id, file),
    ]);
    await fs.writeFile(file, "edited", "utf-8");
    // Second snapshot round must be a no-op (keeps the original).
    await snapshotFile(userId, conversationId, cp.id, file);
    const res = await restoreCheckpoint(userId, cp.id);
    expect(res.ok).toBe(true);
    expect(await fs.readFile(file, "utf-8")).toBe("original");
  });

  it("refuses restore targets outside the workspace root", async () => {
    const file = path.join(tmpDir, "far.txt");
    await fs.writeFile(file, "v1", "utf-8");
    const cp = await createCheckpoint(userId, conversationId, "turn");
    await snapshotFile(userId, conversationId, cp.id, file);
    await fs.writeFile(file, "v2", "utf-8");
    const otherRoot = await fs.mkdtemp(path.join(os.tmpdir(), "hermos-cp-other-"));
    try {
      await expect(
        restoreCheckpoint(userId, cp.id, { workspaceRoot: otherRoot }),
      ).rejects.toThrow(/outside the workspace/);
      // File untouched by the refused restore.
      expect(await fs.readFile(file, "utf-8")).toBe("v2");
    } finally {
      await fs.rm(otherRoot, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("buildUndoPreview inverts +/- for display and echoes verifiable hashes", async () => {
    const file = path.join(tmpDir, "plan.txt");
    // Snapshot: lines a, b. Current: lines b, c.
    await fs.writeFile(file, "a\nb\n", "utf-8");
    const t0 = Date.now();
    const cp = await createCheckpoint(userId, conversationId, "turn");
    await snapshotFile(userId, conversationId, cp.id, file);
    await fs.writeFile(file, "b\nc\n", "utf-8");

    const preview = await buildUndoPreview(userId, conversationId, t0, {
      workspaceRoot: tmpDir,
    });
    expect(preview.attempted).toBe(1);
    expect(preview.files).toHaveLength(1);
    const entry = preview.files[0];
    // Agent deleted "a" → undo restores it (+1 green); added "c" → removed (−1 red).
    expect(entry.restored).toBe(1);
    expect(entry.removed).toBe(1);
    expect(entry.status).toBe("modified");
    expect(entry.hash).toBe(sha1Hex("b\nc\n"));
    expect(preview.expected).toEqual([{ path: file, hash: sha1Hex("b\nc\n") }]);
  });

  it("preview shows created-then-edited files as deleted (matches restore)", async () => {
    // Create in turn 3, edit in turn 5, undo to turn 2: restore writes the
    // turn-5 snapshot then deletes via turn-3 newFiles → final DELETED.
    // The preview must show deletion, not a modified diff.
    const file = path.join(tmpDir, "overlap.txt");
    const t0 = Date.now();
    const cp3 = await createCheckpoint(userId, conversationId, "turn3");
    await fs.writeFile(file, "hello\n", "utf-8");
    await trackNewFile(userId, conversationId, cp3.id, file);
    await new Promise((r) => setTimeout(r, 20));
    const cp5 = await createCheckpoint(userId, conversationId, "turn5");
    await snapshotFile(userId, conversationId, cp5.id, file);
    await fs.writeFile(file, "hello world\n", "utf-8");

    const preview = await buildUndoPreview(userId, conversationId, t0, {
      workspaceRoot: tmpDir,
    });
    expect(preview.files).toHaveLength(1);
    expect(preview.files[0]).toMatchObject({ status: "created", restored: 0 });
    expect(preview.files[0].removed).toBeGreaterThan(0);

    // And the actual restore really deletes it.
    const res = await restoreCheckpointsSinceTimestamp(userId, conversationId, t0, {
      workspaceRoot: tmpDir,
    });
    expect(res.ok).toBe(true);
    expect(await fs.stat(file).catch(() => null)).toBeNull();
  });

  it("buildUndoPreview lists agent-created files as full removals", async () => {
    const created = path.join(tmpDir, "newfile.txt");
    const t0 = Date.now();
    const cp = await createCheckpoint(userId, conversationId, "turn");
    await fs.writeFile(created, "one\ntwo\nthree\n", "utf-8");
    await trackNewFile(userId, conversationId, cp.id, created);

    const preview = await buildUndoPreview(userId, conversationId, t0, {
      workspaceRoot: tmpDir,
    });
    expect(preview.files).toHaveLength(1);
    expect(preview.files[0]).toMatchObject({
      restored: 0,
      removed: 3,
      status: "created",
    });
  });
});

