import { describe, it, expect, afterEach, vi } from "vitest";
import path from "path";
import os from "os";
import fs from "fs";

async function freshImport() {
  vi.resetModules();
  return await import("./paths");
}

describe("Paths", () => {
  let cleanupDirs: string[] = [];

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of cleanupDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    cleanupDirs = [];
  });
  it("should use HERMOS_APP_DATA_DIR override", async () => {
    const appData = path.join(os.tmpdir(), "hermos-test-appdata-" + Date.now());
    vi.stubEnv("HERMOS_APP_DATA_DIR", appData);
    const paths = await freshImport();
    expect(paths.APP_DATA_DIR).toBe(appData);
    expect(paths.UPLOADS_ROOT).toBe(path.join(appData, "uploads"));
    expect(paths.SCREENSHOT_DIR).toBe(path.join(appData, "browser-screenshots"));
    expect(paths.CHECKPOINTS_DIR).toBe(path.join(appData, "checkpoints"));
    expect(paths.ARTIFACTS_DIR).toBe(path.join(appData, "artifacts"));
    expect(paths.WORKSPACES_ROOT).toBe(path.join(appData, "workspaces"));
  });

  it("should use HERMOS_DESKTOP with APP_DATA override", async () => {
    const appData = path.join(os.tmpdir(), "hermos-test-desktop-" + Date.now());
    vi.stubEnv("HERMOS_APP_DATA_DIR", appData);
    vi.stubEnv("HERMOS_DESKTOP", "true");
    const paths = await freshImport();
    expect(paths.APP_DATA_DIR).toBe(appData);
  });

  it("should use HERMOS_PROJECT_ROOT override", async () => {
    const projectRoot = path.join(os.tmpdir(), "hermos-test-project-" + Date.now());
    vi.stubEnv("HERMOS_PROJECT_ROOT", projectRoot);
    const paths = await freshImport();
    expect(paths.PROJECT_ROOT).toBe(projectRoot);
  });

  it("should fall back to project root when no env is set", async () => {
    vi.stubEnv("HERMOS_PROJECT_ROOT", undefined);
    const paths = await freshImport();
    expect(paths.PROJECT_ROOT).toBeTruthy();
    expect(typeof paths.PROJECT_ROOT).toBe("string");
  });

  it("should default to ~/.hermos in dev/browser mode", async () => {
    vi.stubEnv("HERMOS_APP_DATA_DIR", undefined);
    vi.stubEnv("HERMOS_DESKTOP", undefined);
    const paths = await freshImport();
    expect(paths.APP_DATA_DIR).toBe(path.join(os.homedir(), ".hermos"));
    expect(paths.WORKSPACES_ROOT).toBe(path.join(paths.APP_DATA_DIR, "workspaces"));
  });

  it("should ensure runtime dirs without throwing", async () => {
    const appData = path.join(os.tmpdir(), "hermos-test-ensure-" + Date.now());
    vi.stubEnv("HERMOS_APP_DATA_DIR", appData);
    const paths = await freshImport();
    cleanupDirs.push(appData);
    expect(() => paths.ensureRuntimeDirs()).not.toThrow();
    expect(paths.APP_DATA_DIR).toBe(appData);
    expect(fs.existsSync(paths.APP_DATA_DIR)).toBe(true);
    expect(fs.existsSync(paths.UPLOADS_ROOT)).toBe(true);
    expect(fs.existsSync(paths.SCREENSHOT_DIR)).toBe(true);
    expect(fs.existsSync(paths.CHECKPOINTS_DIR)).toBe(true);
    expect(fs.existsSync(paths.ARTIFACTS_DIR)).toBe(true);
    expect(fs.existsSync(paths.WORKSPACES_ROOT)).toBe(true);
  });
});
