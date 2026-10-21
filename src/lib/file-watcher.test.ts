import { describe, it, expect } from "vitest";
import { SKIP_DIRS, isSkipped } from "./file-watcher";

describe("file-watcher SKIP_DIRS & isSkipped", () => {
  it("includes heavy build, cache, test, and dependency directories", () => {
    const requiredHeavyDirs = [
      ".next-build",
      ".next",
      ".coverage",
      "coverage",
      ".nyc_output",
      "node_modules",
      "dist",
      "build",
      "out",
      ".output",
      ".turbo",
      ".cache",
      "target",
      "__pycache__",
      ".pytest_cache",
      ".venv",
    ];
    for (const dir of requiredHeavyDirs) {
      expect(SKIP_DIRS.has(dir)).toBe(true);
    }
  });

  it("strictly does not include .github or .gemini in skipped directories", () => {
    expect(SKIP_DIRS.has(".github")).toBe(false);
    expect(SKIP_DIRS.has(".gemini")).toBe(false);
  });

  it("isSkipped correctly skips paths inside heavy directories but allows normal and .github files", () => {
    expect(isSkipped(".next-build/manifest.json")).toBe(true);
    expect(isSkipped(".coverage/lcov.info")).toBe(true);
    expect(isSkipped("coverage/coverage-final.json")).toBe(true);
    expect(isSkipped("node_modules/foo/package.json")).toBe(true);
    expect(isSkipped("target/debug/app.exe")).toBe(true);

    expect(isSkipped("src/index.ts")).toBe(false);
    expect(isSkipped(".github/workflows/ci.yml")).toBe(false);
    expect(isSkipped(".gemini/prompt.md")).toBe(false);
  });
});
