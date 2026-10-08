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
  globToRegex,
  readTree,
  safePath,
  isSafeWsName,
  assertValidWsName,
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

