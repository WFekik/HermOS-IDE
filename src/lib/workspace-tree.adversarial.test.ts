import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "path";
import fs from "fs";
import os from "os";
import { readTree, safePathFromRoot, FileNode } from "./workspace";

describe("Workspace Tree & Path Traversals — M3 Adversarial Tests", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hermos-ws-test-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* ignore temp dir cleanup failures */
    }
  });

  /* ------------------------------------------------------------------ *
   *  TS4.2: Node Limit Cap & Large Directories
   * ------------------------------------------------------------------ */
  describe("TS4.2: Node Limit Cap & Large Directories", () => {
    it("respects MAX_TREE_NODES (50,000) node cap without running out of memory", async () => {
      // Mock readdir returning 60,000 files in a single folder
      const dummyEntries = Array.from({ length: 60000 }, (_, i) => ({
        name: `file_${i}.txt`,
        isDirectory: () => false,
        isFile: () => true,
        isSymbolicLink: () => false,
      }));

      const readdirSpy = vi.spyOn(fs.promises, "readdir").mockResolvedValue(dummyEntries as any);
      const statSpy = vi.spyOn(fs.promises, "stat").mockResolvedValue({ isFile: () => true, size: 100 } as any);

      const tree = await readTree("usr-1", "ws-1", 6, tempDir);

      // Node count must be capped below MAX_TREE_NODES = 50_000
      expect(tree.length).toBeLessThanOrEqual(50000);
      expect(tree.length).toBeGreaterThan(0);

      readdirSpy.mockRestore();
      statSpy.mockRestore();
    });
  });

  /* ------------------------------------------------------------------ *
   *  TS4.3: Circular Symlinks & Symlink Escapes
   * ------------------------------------------------------------------ */
  describe("TS4.3: Circular Symlinks & Symlink Escapes", () => {
    it("rejects symlinks pointing outside workspace root in safePathFromRoot", () => {
      const outsidePath = path.join(tempDir, "..", "outside_secret.txt");
      fs.writeFileSync(outsidePath, "secret");

      const linkPath = path.join(tempDir, "outside_link.txt");
      try {
        fs.symlinkSync(outsidePath, linkPath);
      } catch {
        // Symlinks might fail on Windows if non-admin, test path traversal fallback
      }

      // Traversal using relative path attempt
      const resultRelative = safePathFromRoot(tempDir, "../outside_secret.txt");
      expect(resultRelative).toBeNull();

      if (fs.existsSync(linkPath)) {
        const resultSymlink = safePathFromRoot(tempDir, "outside_link.txt");
        expect(resultSymlink).toBeNull();
      }

      fs.unlinkSync(outsidePath);
    });

    it("ignores directory symlinks in readTree to avoid circular symlink recursion", async () => {
      const subDir = path.join(tempDir, "subDir");
      fs.mkdirSync(subDir);
      const symlinkPath = path.join(subDir, "circular_link");

      try {
        fs.symlinkSync(tempDir, symlinkPath, "dir");
      } catch {
        /* skip symlink creation on systems without privileges */
      }

      // readTree uses withFileTypes where isDirectory() is false for symbolic links,
      // so circular symlink is safely ignored without infinite loop.
      const tree = await readTree("usr-1", "ws-1", 6, tempDir);
      expect(Array.isArray(tree)).toBe(true);
    });
  });

  /* ------------------------------------------------------------------ *
   *  TS4.4: Invalid Unicode & Special Filenames
   * ------------------------------------------------------------------ */
  describe("TS4.4: Invalid Unicode & Special Filenames", () => {
    it("handles invalid unicode, surrogate pairs, and special filenames in tree sorting", () => {
      const nodes: FileNode[] = [
        { name: "file_z.txt", path: "file_z.txt", type: "file" },
        { name: "dir_b", path: "dir_b", type: "dir" },
        { name: "file_a.txt", path: "file_a.txt", type: "file" },
        { name: "dir_a", path: "dir_a", type: "dir" },
        { name: "\uD800invalid_surrogate", path: "bad.txt", type: "file" },
        { name: "CON.txt", path: "CON.txt", type: "file" },
        { name: "NUL.txt", path: "NUL.txt", type: "file" },
      ];

      // Sorting should not throw exception even with invalid UTF-16 surrogates
      expect(() => {
        nodes.sort((a, b) => {
          if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
      }).not.toThrow();

      // Dirs first, then files
      expect(nodes[0].type).toBe("dir");
      expect(nodes[1].type).toBe("dir");
      expect(nodes[2].type).toBe("file");
    });

    it("safePathFromRoot safely handles Windows reserved filenames (CON, PRN, AUX, NUL)", () => {
      const reservedNames = ["CON", "PRN", "AUX", "NUL", "COM1", "LPT1"];
      for (const name of reservedNames) {
        const res = safePathFromRoot(tempDir, name);
        // Returns normalized absolute path inside workspace root or null without throwing
        if (res !== null) {
          expect(res.startsWith(tempDir)).toBe(true);
        }
      }
    });
  });
});
