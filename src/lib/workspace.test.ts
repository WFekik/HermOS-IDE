/**
 * Tests for the write-path extension denylist in src/lib/workspace.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "path";
import os from "os";
import fs from "fs/promises";
import {
  deniedWriteExtension,
  writeFileWs,
  createFileWs,
  globToRegex,
} from "./workspace";

describe("deniedWriteExtension — denylist coverage", () => {
  it("rejects every extension in the denylist", () => {
    const cases: Array<[string, string]> = [
      ["evil.exe", ".exe"],
      ["evil.bat", ".bat"],
      ["evil.cmd", ".cmd"],
      ["evil.com", ".com"],
      ["evil.ps1", ".ps1"],
      ["evil.dll", ".dll"],
      ["evil.scr", ".scr"],
      ["evil.lnk", ".lnk"],
    ];
    for (const [rel, ext] of cases) {
      expect(deniedWriteExtension(rel)).toBe(ext);
    }
  });

  it("is case-insensitive", () => {
    expect(deniedWriteExtension("evil.EXE")).toBe(".exe");
    expect(deniedWriteExtension("EvIl.ExE")).toBe(".exe");
    expect(deniedWriteExtension("evil.BAT")).toBe(".bat");
    expect(deniedWriteExtension("evil.DlL")).toBe(".dll");
  });

  it("strips trailing dots/spaces before extension extraction (Windows aliasing)", () => {
    expect(deniedWriteExtension("evil.exe.")).toBe(".exe");
    expect(deniedWriteExtension("evil.exe ")).toBe(".exe");
    expect(deniedWriteExtension("evil.exe. ")).toBe(".exe");
    expect(deniedWriteExtension("evil.exe  .")).toBe(".exe");
  });

  it("rejects denied extensions in nested paths with both separators", () => {
    expect(deniedWriteExtension("dist/evil.dll")).toBe(".dll");
    expect(deniedWriteExtension("dist\\evil.bat")).toBe(".bat");
    expect(deniedWriteExtension("a/b/c/evil.ps1")).toBe(".ps1");
    expect(deniedWriteExtension("a\\b\\evil.cmd")).toBe(".cmd");
  });
});

describe("deniedWriteExtension — allowed paths", () => {
  it("allows safe source/text extensions", () => {
    expect(deniedWriteExtension("main.ts")).toBeNull();
    expect(deniedWriteExtension("app.js")).toBeNull();
    expect(deniedWriteExtension("README.txt")).toBeNull();
    expect(deniedWriteExtension("data.json")).toBeNull();
  });

  it("allows files without an extension", () => {
    expect(deniedWriteExtension("README")).toBeNull();
    expect(deniedWriteExtension("Makefile")).toBeNull();
  });

  it("allows hidden files whose name starts with a dot", () => {
    expect(deniedWriteExtension(".env")).toBeNull();
    expect(deniedWriteExtension(".gitignore")).toBeNull();
  });

  it("allows files with a dot but no denied extension", () => {
    expect(deniedWriteExtension("notes.exe.md")).toBeNull();
    expect(deniedWriteExtension("script.ps1.txt")).toBeNull();
  });

  it("only inspects the final path segment — directories named like a denied extension are not blocked", () => {
    expect(deniedWriteExtension("foo.exe/bar.txt")).toBeNull();
    expect(deniedWriteExtension("src/evil.exe/baz.ts")).toBeNull();
    expect(deniedWriteExtension("scripts/bat")).toBeNull();
  });

  it("allows a trailing-slash directory path", () => {
    expect(deniedWriteExtension("evil.exe/")).toBeNull();
  });
});

describe("writeFileWs — denylist enforcement at the FS layer", () => {
  const root = path.join(os.tmpdir(), "hermos-denywrite-test");
  beforeAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.mkdir(root, { recursive: true });
  });
  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("throws before writing when the target has a denied extension", async () => {
    await expect(
      writeFileWs("u1", "ws1", "evil.exe", "x", root),
    ).rejects.toThrow('Writing files with the ".exe" extension is not allowed.');
    await expect(
      writeFileWs("u1", "ws1", "nested/evil.ps1.", "x", root),
    ).rejects.toThrow('Writing files with the ".ps1" extension is not allowed.');
    expect(await fs.stat(path.join(root, "evil.exe")).then(() => true).catch(() => false)).toBe(false);
  });

  it("writes files with allowed extensions", async () => {
    const res = await writeFileWs("u1", "ws1", "ok.ts", "hello", root);
    expect(res).toEqual({ path: "ok.ts", bytes: 5 });
    const content = await fs.readFile(path.join(root, "ok.ts"), "utf8");
    expect(content).toBe("hello");
  });

  it("createFileWs rejects denied extensions via delegation", async () => {
    await expect(
      createFileWs("u1", "ws1", "evil.bat", "x", root),
    ).rejects.toThrow('Writing files with the ".bat" extension is not allowed.');
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

