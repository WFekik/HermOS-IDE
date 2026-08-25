/**
 * Tests for src/lib/workspace.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "path";
import os from "os";
import fs from "fs/promises";
import { existsSync } from "fs";
import { safePathFromRoot, safePath } from "./workspace";

describe("safePathFromRoot — basic containment", () => {
  const root = path.join(os.tmpdir(), "hermos-safe-path-test");
  beforeAll(async () => {
    await fs.mkdir(root, { recursive: true });
  });

  it("returns the resolved root for empty input", () => {
    expect(safePathFromRoot(root, "")).toBe(path.resolve(root));
    expect(safePathFromRoot(root, ".")).toBe(path.resolve(root));
    expect(safePathFromRoot(root, "./")).toBe(path.resolve(root));
  });

  it("joins a simple relative path", () => {
    const result = safePathFromRoot(root, "foo.ts");
    expect(result).toBe(path.join(path.resolve(root), "foo.ts"));
  });

  it("joins a nested relative path", () => {
    const result = safePathFromRoot(root, "src/lib/foo.ts");
    expect(result).toBe(path.join(path.resolve(root), "src", "lib", "foo.ts"));
  });

  it("normalizes a leading ./", () => {
    const result = safePathFromRoot(root, "./foo.ts");
    expect(result).toBe(path.join(path.resolve(root), "foo.ts"));
  });

  it("strips leading slashes", () => {
    const result = safePathFromRoot(root, "/foo.ts");
    expect(result).toBe(path.join(path.resolve(root), "foo.ts"));
    const result2 = safePathFromRoot(root, "//foo.ts");
    expect(result2).toBe(path.join(path.resolve(root), "foo.ts"));
  });

  it("strips trailing slashes", () => {
    const result = safePathFromRoot(root, "foo/");
    expect(result).toBe(path.join(path.resolve(root), "foo"));
  });

  it("returns null for null/empty root", () => {
    expect(safePathFromRoot("", "foo")).toBeNull();
    expect(safePathFromRoot(" " as string, "foo")).not.toBeNull(); // " " is technically a path
  });
});

describe("safePathFromRoot — traversal defense", () => {
  const root = path.join(os.tmpdir(), "hermos-traversal-test");
  beforeAll(async () => {
    await fs.mkdir(root, { recursive: true });
  });

  it("rejects simple ../ escape", () => {
    expect(safePathFromRoot(root, "../etc/passwd")).toBeNull();
  });

  it("rejects multi-level ../../escape", () => {
    expect(safePathFromRoot(root, "../../etc/passwd")).toBeNull();
    expect(safePathFromRoot(root, "../../../etc/passwd")).toBeNull();
    expect(safePathFromRoot(root, "../../../../../../../../etc/passwd")).toBeNull();
  });

  it("rejects ./.. escape", () => {
    expect(safePathFromRoot(root, "./../etc/passwd")).toBeNull();
  });

  it("rejects /../escape", () => {
    expect(safePathFromRoot(root, "/../etc/passwd")).toBeNull();
  });

  it("rejects ../../ followed by anything starting with ..", () => {
    expect(safePathFromRoot(root, "../..")).toBeNull();
    expect(safePathFromRoot(root, "../../")).toBeNull();
    expect(safePathFromRoot(root, "../foo/..")).toBeNull();
  });

  it("rejects ../foo/.. traversal in the middle", () => {
    expect(safePathFromRoot(root, "foo/../bar")).toBeNull();
    expect(safePathFromRoot(root, "src/../secrets")).toBeNull();
  });

  it("rejects traversal disguised as a filename (../foo)", () => {
    // The `..` appears as a path segment, not part of a filename.
    expect(safePathFromRoot(root, "foo/../bar")).toBeNull();
  });

  it("ALLOWS filenames that contain '..' but are not segments", () => {
    // "foo..bar" or "..foo" or "foo.." are filenames, not traversal.
    expect(safePathFromRoot(root, "foo..bar.ts")).not.toBeNull();
    expect(safePathFromRoot(root, "..hidden")).not.toBeNull(); // filename starting with ..
    expect(safePathFromRoot(root, "foo..")).not.toBeNull();
  });

  it("rejects backslash-based traversal (Windows-style)", () => {
    expect(safePathFromRoot(root, "..\\..\\windows\\system32")).toBeNull();
    expect(safePathFromRoot(root, "..\\secret")).toBeNull();
  });

  it("rejects mixed forward/backslash traversal", () => {
    expect(safePathFromRoot(root, "..\\../etc/passwd")).toBeNull();
    expect(safePathFromRoot(root, "../..\\secrets")).toBeNull();
  });

  it("rejects double-encoded traversal", () => {
    // Slightly paranoid: a hardcoded `..` segment is rejected regardless
    // of surrounding context. (URL-encoded dots aren't decoded by Node's
    // path APIs, but a raw `..` always fails.)
    expect(safePathFromRoot(root, "foo/./../bar")).toBeNull();
    expect(safePathFromRoot(root, "foo//../bar")).toBeNull();
  });
});

describe("safePathFromRoot — symlink defense-in-depth", () => {
  // Create a real symlink INSIDE the workspace pointing OUTSIDE.
  // safePathFromRoot must reject access through the symlink.
  const root = path.join(os.tmpdir(), "hermos-symlink-test");
  const outsideDir = path.join(os.tmpdir(), "hermos-symlink-outside");
  const symlinkPath = path.join(root, "escape");
  beforeAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
    await fs.mkdir(root, { recursive: true });
    await fs.mkdir(outsideDir, { recursive: true });
    await fs.writeFile(path.join(outsideDir, "secret.txt"), "TOP SECRET");
    if (process.platform !== "win32") {
      try {
        await fs.symlink(outsideDir, symlinkPath);
      } catch {
        // Skip if symlinks aren't supported in this environment.
      }
    }
  });
  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
  });

  it("rejects symlinks that point outside the workspace", () => {
    if (!existsSync(symlinkPath)) {
      // Symlinks unsupported on this platform — skip without failing.
      return;
    }
    const result = safePathFromRoot(root, "escape/secret.txt");
    expect(result).toBeNull();
  });
});

describe("safePathFromRoot — non-existent paths within root are allowed", () => {
  const root = path.join(os.tmpdir(), "hermos-nonexist-test");
  beforeAll(async () => {
    await fs.mkdir(root, { recursive: true });
  });

  it("allows paths to files that don't yet exist (creation case)", () => {
    const result = safePathFromRoot(root, "new-file.ts");
    expect(result).toBe(path.join(path.resolve(root), "new-file.ts"));
  });

  it("allows paths to directories that don't yet exist", () => {
    const result = safePathFromRoot(root, "src/never-created/foo.ts");
    expect(result).toBe(path.join(path.resolve(root), "src", "never-created", "foo.ts"));
  });
});

describe("safePathFromRoot — audit payloads & Windows edge paths", () => {
  const root = path.join(os.tmpdir(), "hermos-audit-edge-test");
  beforeAll(async () => {
    await fs.mkdir(root, { recursive: true });
  });

  const isInside = (candidate: string | null, base: string) => {
    if (candidate === null) return true;
    const t = candidate.toLowerCase();
    const b = base.toLowerCase();
    if (t === b) return true;
    const bs = b.endsWith(path.sep) ? b : b + path.sep;
    return t.startsWith(bs);
  };

  it("rejects the audit traversal payloads (posix and windows)", () => {
    expect(safePathFromRoot(root, "../../../Windows/System32/drivers/etc/hosts")).toBeNull();
    expect(safePathFromRoot(root, "..\\..\\secret.txt")).toBeNull();
  });

  it("never escapes the root via UNC, device, or drive-relative paths", () => {
    const base = path.resolve(root);
    const payloads = [
      "\\\\server\\share\\foo",
      "\\\\server\\share\\..\\..\\x",
      "\\\\.\\C:\\Windows\\system32",
      "\\\\.\\GLOBALROOT\\device\\HarddiskVolumeShadowCopy1\\Windows\\system32",
      "C:foo",
      "C:\\Windows\\system32",
      "/etc/passwd",
    ];
    for (const p of payloads) {
      expect(isInside(safePathFromRoot(root, p), base)).toBe(true);
    }
  });

  it("accepts absolute paths that live inside the root", () => {
    const abs = path.join(path.resolve(root), "src", "lib", "x.ts");
    expect(safePathFromRoot(root, abs)).toBe(abs);
  });

  it("rejects absolute paths outside the root", () => {
    const outside = path.join(path.resolve(root), "..", "sibling", "x.ts");
    expect(safePathFromRoot(root, outside)).toBeNull();
  });
});

describe("safePath — workspace-context wrapper", () => {
  it("uses the provided rootDir when given", () => {
    const root = path.join(os.tmpdir(), "hermos-ws-context-test");
    const result = safePath("u1", "ws1", "foo.ts", root);
    expect(result).toBe(path.join(path.resolve(root), "foo.ts"));
  });

  it("rejects traversal even through the wrapper", () => {
    const root = path.join(os.tmpdir(), "hermos-ws-context-test");
    expect(safePath("u1", "ws1", "../escape", root)).toBeNull();
    expect(safePath("u1", "ws1", "foo/../../escape", root)).toBeNull();
  });

  it("returns null when rootDir is unknown and traversal attempted", () => {
    // Without a rootDir, the wrapper falls back to APP_DATA_DIR/workspaces/user/wsName.
    // A traversal attempt should still be rejected.
    expect(safePath("nonexistent-user", "nonexistent-ws", "../escape")).toBeNull();
  });
});