import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * Static assertions for the frameless window chrome shared by the static
 * splash (public/splash.html + tauri-window-controls.js) and the React
 * titlebar (src/components/ide/window-controls.tsx).
 */
const rootDir = path.resolve(__dirname, "..", "..");
const splashHtml = fs.readFileSync(path.join(rootDir, "public", "splash.html"), "utf-8");
const chromeJs = fs.readFileSync(
  path.join(rootDir, "public", "tauri-window-controls.js"),
  "utf-8",
);
const windowControls = fs.readFileSync(
  path.join(rootDir, "src", "components", "ide", "window-controls.tsx"),
  "utf-8",
);

describe("splash window chrome", () => {
  it("splash has three labeled buttons with no-drag zones", () => {
    for (const label of ['aria-label="Minimize"', 'aria-label="Maximize"', 'aria-label="Close"']) {
      expect(splashHtml).toContain(label);
    }
    expect(splashHtml).toContain('data-tauri-drag-region="false"');
    expect(splashHtml).toContain("-webkit-app-region: no-drag");
  });

  it("splash status text is a live region", () => {
    expect(splashHtml).toContain('role="status"');
    expect(splashHtml).toContain('aria-live="polite"');
  });

  it("splash respects reduced motion", () => {
    expect(splashHtml).toContain("prefers-reduced-motion");
  });

  it("controls script wires the same IPC shapes as the React controls", () => {
    for (const method of ["minimize", "maximize", "unmaximize", "close", "isMaximized"]) {
      expect(chromeJs).toContain(method);
      expect(windowControls).toContain(method === "isMaximized" ? "isMaximized" : method);
    }
  });

  it("React controls carry no-drag marking and 44px targets", () => {
    expect(windowControls).toContain('data-tauri-drag-region="false"');
    expect(windowControls).toContain("min-w-11");
    expect(windowControls).toContain("min-h-11");
  });
});
