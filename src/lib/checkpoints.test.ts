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
});
