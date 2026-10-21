/**
 * Tests for the workspace file-write paths in src/lib/workspace.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "path";
import os from "os";
import fs from "fs/promises";
import {
  writeFileWs,
  createFileWs,
  readFileWs,
  globToRegex,
  readTree,
  safePath,
  isSafeWsName,
  assertValidWsName,
  buildEnv,
  HEAVY_TREE_DIRS,
  grepWorkspace,
} from "./workspace";

describe("writeFileWs — script and executable extensions are writable", () => {
  const root = path.join(os.tmpdir(), "hermos-write-test");
  beforeAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.mkdir(root, { recursive: true });
  });
  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("writes script files (.bat, .sh, .ps1, .cmd)", async () => {
    for (const name of ["run.bat", "run.sh", "run.ps1", "run.cmd"]) {
      const res = await writeFileWs("u1", "ws1", name, "echo hi", root);
      expect(res.path).toBe(name);
      expect(await fs.readFile(path.join(root, name), "utf8")).toBe("echo hi");
    }
  });

  it("writes files with allowed extensions", async () => {
    const res = await writeFileWs("u1", "ws1", "ok.ts", "hello", root);
    expect(res).toEqual({ path: "ok.ts", bytes: 5 });
    const content = await fs.readFile(path.join(root, "ok.ts"), "utf8");
    expect(content).toBe("hello");
  });

  it("createFileWs delegates to writeFileWs", async () => {
    const res = await createFileWs("u1", "ws1", "evil.bat", "x", root);
    expect(res.path).toBe("evil.bat");
  });

  it("tags missing-file reads with ENOENT so write_file distinguishes create from unreadable", async () => {
    const err = await readFileWs("u1", "ws1", "missing.txt", undefined, root).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as NodeJS.ErrnoException).code).toBe("ENOENT");
    expect((err as Error).message).toBe("File not found.");
  });
});

describe("readTree — no directory filtering (list_directory shows everything)", () => {
  const root = path.join(os.tmpdir(), "hermos-tree-nofilter-test");
  beforeAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
    for (const d of ["node_modules/pkg", ".git/objects", "dist", "src"]) {
      await fs.mkdir(path.join(root, d), { recursive: true });
    }
    await fs.writeFile(path.join(root, "node_modules/pkg/index.js"), "x", "utf8");
    await fs.writeFile(path.join(root, ".git/HEAD"), "ref", "utf8");
    await fs.writeFile(path.join(root, "dist/bundle.js"), "y", "utf8");
    await fs.writeFile(path.join(root, "src/app.ts"), "z", "utf8");
  });
  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("lists dependency/build/vcs directories instead of filtering them", async () => {
    const tree = await readTree("u1", "ws1", 6, root);
    const names = tree.map((n) => n.name);
    for (const expected of ["node_modules", ".git", "dist", "src"]) {
      expect(names).toContain(expected);
    }
    const nm = tree.find((n) => n.name === "node_modules");
    expect(nm?.children?.map((c) => c.name)).toContain("pkg");
  });
});

describe("workspace names — strict at creation, traversal-only at resolution", () => {
  it("assertValidWsName enforces the strict charset for new workspaces", () => {
    expect(assertValidWsName("my-project_1.0")).toBe("my-project_1.0");
    expect(() => assertValidWsName("my project")).toThrow("Invalid workspace name.");
    expect(() => assertValidWsName("../evil")).toThrow("Invalid workspace name.");
  });

  it("isSafeWsName allows legacy names but blocks traversal", () => {
    expect(isSafeWsName("my project")).toBe(true);
    expect(isSafeWsName("proj (2)")).toBe(true);
    expect(isSafeWsName("../evil")).toBe(false);
    expect(isSafeWsName("a/b")).toBe(false);
    expect(isSafeWsName("a\\b")).toBe(false);
    expect(isSafeWsName("")).toBe(false);
  });

  it("safePath/readTree resolve legacy names but reject traversal names", async () => {
    const root = path.join(os.tmpdir(), "hermos-wsname-test");
    await fs.rm(root, { recursive: true, force: true });
    await fs.mkdir(root, { recursive: true });
    expect(safePath("u1", "my project", "f.txt", root)).not.toBeNull();
    expect(safePath("u1", "../evil", "f.txt", root)).toBeNull();
    expect(await readTree("u1", "../evil", 6, root)).toEqual([]);
    await fs.rm(root, { recursive: true, force: true });
  });
});

describe("globToRegex — brace expansion", () => {
  it("supports brace expansion for multi-extension globs", () => {
    const re = globToRegex("**/*.{ts,tsx,js,jsx}");
    expect(re.test("src/index.ts")).toBe(true);
    expect(re.test("src/components/button.tsx")).toBe(true);
    expect(re.test("lib/utils.js")).toBe(true);
    expect(re.test("app/page.jsx")).toBe(true);
    expect(re.test("styles.css")).toBe(false);
  });

  it("escapes special regex characters within options safely", () => {
    const re = globToRegex("foo/{a.b,c+d}.txt");
    expect(re.test("foo/a.b.txt")).toBe(true);
    expect(re.test("foo/c+d.txt")).toBe(true);
    expect(re.test("foo/axb.txt")).toBe(false);
  });

  it("handles standard globs without braces unchanged", () => {
    const re = globToRegex("src/**/*.ts");
    expect(re.test("src/foo/bar.ts")).toBe(true);
    expect(re.test("src/foo/bar.js")).toBe(false);
  });
});

describe("buildEnv — environment isolation", () => {
  it("defaults NODE_ENV to development when parent process is production", () => {
    const orig = process.env.NODE_ENV;
    try {
      (process.env as Record<string, string | undefined>).NODE_ENV = "production";
      const envWin = buildEnv(true, "C:\\test");
      expect(envWin.NODE_ENV).toBe("development");

      const envPosix = buildEnv(false, "/test");
      expect(envPosix.NODE_ENV).toBe("development");
    } finally {
      (process.env as Record<string, string | undefined>).NODE_ENV = orig;
    }
  });

  it("preserves non-production NODE_ENV", () => {
    const orig = process.env.NODE_ENV;
    try {
      (process.env as Record<string, string | undefined>).NODE_ENV = "test";
      const env = buildEnv(true, "C:\\test");
      expect(env.NODE_ENV).toBe("test");
    } finally {
      (process.env as Record<string, string | undefined>).NODE_ENV = orig;
    }
  });
});


describe("safePath — leading-slash and system root path handling", () => {
  const root = path.join(os.tmpdir(), "hermos-safepath-test");
  beforeAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "index.ts"), "export const a = 1;");
  });
  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("resolves workspace root-relative paths starting with a leading slash", () => {
    const resolved = safePath("u1", "ws1", "/src/index.ts", root);
    expect(resolved).toBe(path.join(root, "src", "index.ts"));
  });

  it("rejects system root paths outside workspace base", () => {
    expect(safePath("u1", "ws1", "/tmp/other-user/file.txt", root)).toBeNull();
    expect(safePath("u1", "ws1", "/etc/passwd", root)).toBeNull();
    expect(safePath("u1", "ws1", "/home/other/file.txt", root)).toBeNull();
  });
});


describe("HEAVY_TREE_DIRS & grepWorkspace filter rules", () => {
  const root = path.join(os.tmpdir(), "hermos-heavy-filter-test");
  beforeAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.mkdir(path.join(root, ".next-build"), { recursive: true });
    await fs.mkdir(path.join(root, ".coverage"), { recursive: true });
    await fs.mkdir(path.join(root, "coverage"), { recursive: true });
    await fs.mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
    await fs.mkdir(path.join(root, ".github", "workflows"), { recursive: true });
    await fs.mkdir(path.join(root, "src"), { recursive: true });

    await fs.writeFile(path.join(root, ".next-build", "trace.log"), "TARGET_STRING_IN_NEXT_BUILD", "utf8");
    await fs.writeFile(path.join(root, ".coverage", "cov.txt"), "TARGET_STRING_IN_DOT_COVERAGE", "utf8");
    await fs.writeFile(path.join(root, "coverage", "lcov.txt"), "TARGET_STRING_IN_COVERAGE", "utf8");
    await fs.writeFile(path.join(root, "node_modules", "pkg", "index.js"), "TARGET_STRING_IN_NM", "utf8");
    await fs.writeFile(path.join(root, ".github", "workflows", "ci.yml"), "TARGET_STRING_IN_GITHUB", "utf8");
    await fs.writeFile(path.join(root, "src", "index.ts"), "TARGET_STRING_IN_SRC", "utf8");
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("contains heavy build, cache, and coverage directories in HEAVY_TREE_DIRS", () => {
    expect(HEAVY_TREE_DIRS.has(".next-build")).toBe(true);
    expect(HEAVY_TREE_DIRS.has(".coverage")).toBe(true);
    expect(HEAVY_TREE_DIRS.has("coverage")).toBe(true);
    expect(HEAVY_TREE_DIRS.has("node_modules")).toBe(true);
    expect(HEAVY_TREE_DIRS.has("target")).toBe(true);
  });

  it("strictly excludes .github and .gemini from HEAVY_TREE_DIRS", () => {
    expect(HEAVY_TREE_DIRS.has(".github")).toBe(false);
    expect(HEAVY_TREE_DIRS.has(".gemini")).toBe(false);
  });

  it("grepWorkspace skips heavy directories but traverses normal and .github folders", async () => {
    const results = await grepWorkspace("u1", "ws1", "TARGET_STRING", { rootDir: root });
    const paths = results.map((r) => r.path);

    // .github and src must be matched
    expect(paths.some((p) => p.includes(".github"))).toBe(true);
    expect(paths.some((p) => p.includes("src"))).toBe(true);

    // heavy directories must be skipped
    expect(paths.some((p) => p.includes(".next-build"))).toBe(false);
    expect(paths.some((p) => p.includes(".coverage"))).toBe(false);
    expect(paths.some((p) => p.includes("coverage"))).toBe(false);
    expect(paths.some((p) => p.includes("node_modules"))).toBe(false);
  });
});
