import { describe, it, expect } from "vitest";

describe("git.ts — adversarial tests (public API only)", () => {
  // Internal functions (isValidBranchName, confineWorktreePath, unquoteGitPath,
  // parseUnifiedDiff) are not exported. We test the public API with bad inputs.

  describe("gitIsRepo: safe defaults for bad inputs", () => {
    async function getMod() {
      return await import("./git");
    }

    it("returns false for empty rootDir", async () => {
      const { gitIsRepo } = await getMod();
      expect(await gitIsRepo("")).toBe(false);
    });

    it("returns false for nullish rootDir", async () => {
      const { gitIsRepo } = await getMod();
      // @ts-expect-error — runtime resilience
      expect(await gitIsRepo(null)).toBe(false);
      // @ts-expect-error
      expect(await gitIsRepo(undefined)).toBe(false);
    });
  });

  describe("gitStatus: safe defaults", () => {
    it("returns empty status for empty rootDir", async () => {
      const { gitStatus } = await import("./git");
      const r = await gitStatus("");
      expect(r.clean).toBe(true);
      expect(r.branch).toBe("");
      expect(r.staged).toEqual([]);
      expect(r.modified).toEqual([]);
      expect(r.untracked).toEqual([]);
    });
  });

  describe("gitDiff: safe defaults", () => {
    it("returns empty diff for empty rootDir", async () => {
      const { gitDiff } = await import("./git");
      const r = await gitDiff("");
      expect(r.files).toEqual([]);
      expect(r.totalAdditions).toBe(0);
    });

    it("returns empty diff for nonexistent rootDir", async () => {
      const { gitDiff } = await import("./git");
      const r = await gitDiff("/nonexistent/path");
      expect(r.files).toEqual([]);
    });
  });

  describe("gitDiffBranches: input validation", () => {
    it("rejects empty base or compare", async () => {
      const { gitDiffBranches } = await import("./git");
      expect((await gitDiffBranches("/repo", "", "feature")).files).toEqual([]);
      expect((await gitDiffBranches("/repo", "main", "")).files).toEqual([]);
    });

    it("rejects refs starting with dash", async () => {
      const { gitDiffBranches } = await import("./git");
      expect((await gitDiffBranches("/repo", "-branch", "main")).files).toEqual([]);
      expect((await gitDiffBranches("/repo", "main", "-branch")).files).toEqual([]);
    });

    it("rejects refs with whitespace", async () => {
      const { gitDiffBranches } = await import("./git");
      expect((await gitDiffBranches("/repo", "main branch", "feature")).files).toEqual([]);
    });

    it("rejects overly long refs", async () => {
      const { gitDiffBranches } = await import("./git");
      expect((await gitDiffBranches("/repo", "x".repeat(300), "feature")).files).toEqual([]);
    });

    it("never throws with arbitrary ref values", async () => {
      const { gitDiffBranches } = await import("./git");
      const r = await gitDiffBranches("/repo", "a\nb", "c\td");
      // Should not throw — returns empty diff instead
      expect(Array.isArray(r.files)).toBe(true);
    });
  });

  describe("gitLog: safe defaults", () => {
    it("returns empty array for empty rootDir", async () => {
      const { gitLog } = await import("./git");
      expect(await gitLog("")).toEqual([]);
    });
  });

  describe("gitBranches: safe defaults", () => {
    it("returns empty array for empty rootDir", async () => {
      const { gitBranches } = await import("./git");
      expect(await gitBranches("")).toEqual([]);
    });
  });

  describe("gitWorktreeList: safe defaults", () => {
    it("returns empty array for empty rootDir", async () => {
      const { gitWorktreeList } = await import("./git");
      expect(await gitWorktreeList("")).toEqual([]);
    });
  });

  describe("gitWorktreeAdd: input validation", () => {
    it("rejects empty rootDir", async () => {
      const { gitWorktreeAdd } = await import("./git");
      const r = await gitWorktreeAdd("", "feature", "/path");
      expect(r.ok).toBe(false);
    });

    it("rejects invalid branch names without calling git", async () => {
      const { gitWorktreeAdd } = await import("./git");
      // These should be rejected by isValidBranchName BEFORE any git call
      const bad = ["", "-branch", "branch..name", "branch~1", "branch^"];
      for (const b of bad) {
        const r = await gitWorktreeAdd("/repo", b, "/repo/.worktrees/test");
        expect(r.ok, `expected branch "${b}" to be rejected`).toBe(false);
      }
    });

    it("rejects paths outside worktrees sandbox", async () => {
      const { gitWorktreeAdd } = await import("./git");
      // This should be rejected by confineWorktreePath BEFORE any git call
      const r = await gitWorktreeAdd("/repo", "feature", "/etc");
      expect(r.ok).toBe(false);
    });
  });

  describe("gitWorktreeRemove: input validation", () => {
    it("rejects empty rootDir", async () => {
      const { gitWorktreeRemove } = await import("./git");
      const r = await gitWorktreeRemove("", "/path");
      expect(r.ok).toBe(false);
    });

    it("rejects paths outside worktrees sandbox", async () => {
      const { gitWorktreeRemove } = await import("./git");
      const r = await gitWorktreeRemove("/repo", "/etc");
      expect(r.ok).toBe(false);
    });
  });
});
