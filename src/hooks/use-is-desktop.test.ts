import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { detectDesktop, useIsDesktop } from "./use-is-desktop";

describe("detectDesktop", () => {
  const originalEnv = { ...process.env };
  const originalWindow = globalThis.window;
  const originalNavigator = globalThis.navigator;

  beforeEach(() => {
    delete process.env.HERMOS_DESKTOP;
    // Reset globals
    delete (globalThis as any).window;
    delete (globalThis as any).navigator;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    if (originalWindow !== undefined) {
      globalThis.window = originalWindow;
    } else {
      delete (globalThis as any).window;
    }
    if (originalNavigator !== undefined) {
      globalThis.navigator = originalNavigator;
    } else {
      delete (globalThis as any).navigator;
    }
    vi.restoreAllMocks();
  });

  describe("SSR / Node environment (window is undefined)", () => {
    it("returns false by default when window is undefined and env is not set", () => {
      expect(detectDesktop()).toBe(false);
    });

    it("returns true when process.env.HERMOS_DESKTOP is 'true'", () => {
      process.env.HERMOS_DESKTOP = "true";
      expect(detectDesktop()).toBe(true);
    });

    it("returns false when process.env.HERMOS_DESKTOP is 'false' or another string", () => {
      process.env.HERMOS_DESKTOP = "false";
      expect(detectDesktop()).toBe(false);
      process.env.HERMOS_DESKTOP = "1";
      expect(detectDesktop()).toBe(false);
    });
  });

  describe("Browser environment (window is defined)", () => {
    it("detects window.__TAURI_INTERNALS__", () => {
      (globalThis as any).window = {
        __TAURI_INTERNALS__: {},
        location: { search: "" },
      };
      (globalThis as any).navigator = { userAgent: "Mozilla/5.0 Chrome/120.0" };

      expect(detectDesktop()).toBe(true);
    });

    it("detects window.__TAURI__", () => {
      (globalThis as any).window = {
        __TAURI__: {},
        location: { search: "" },
      };
      (globalThis as any).navigator = { userAgent: "Mozilla/5.0 Chrome/120.0" };

      expect(detectDesktop()).toBe(true);
    });

    it("detects ?mode=ide search parameter", () => {
      (globalThis as any).window = {
        location: { search: "?mode=ide" },
      };
      (globalThis as any).navigator = { userAgent: "Mozilla/5.0 Chrome/120.0" };

      expect(detectDesktop()).toBe(true);
    });

    it("detects ?mode=desktop search parameter", () => {
      (globalThis as any).window = {
        location: { search: "?mode=desktop" },
      };
      (globalThis as any).navigator = { userAgent: "Mozilla/5.0 Chrome/120.0" };

      expect(detectDesktop()).toBe(true);
    });

    it("handles case-insensitivity in mode parameter (?MODE=IDE, ?mode=DESKTOP)", () => {
      (globalThis as any).window = {
        location: { search: "?MODE=IDE" },
      };
      (globalThis as any).navigator = { userAgent: "Mozilla/5.0 Chrome/120.0" };
      expect(detectDesktop()).toBe(true);

      (globalThis as any).window.location.search = "?mode=DESKTOP";
      expect(detectDesktop()).toBe(true);
    });

    it("detects mode parameter amidst multiple query params", () => {
      (globalThis as any).window = {
        location: { search: "?utm_source=google&mode=ide&ref=123" },
      };
      (globalThis as any).navigator = { userAgent: "Mozilla/5.0 Chrome/120.0" };

      expect(detectDesktop()).toBe(true);
    });

    it("returns false for non-desktop mode parameters", () => {
      (globalThis as any).window = {
        location: { search: "?mode=chat&foo=bar" },
      };
      (globalThis as any).navigator = { userAgent: "Mozilla/5.0 Chrome/120.0" };

      expect(detectDesktop()).toBe(false);
    });

    it("detects Tauri in userAgent", () => {
      (globalThis as any).window = {
        location: { search: "" },
      };
      (globalThis as any).navigator = {
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Tauri/2.0.0",
      };

      expect(detectDesktop()).toBe(true);
    });

    it("detects hermos-desktop in userAgent", () => {
      (globalThis as any).window = {
        location: { search: "" },
      };
      (globalThis as any).navigator = {
        userAgent: "Mozilla/5.0 HermOS-Desktop/1.0.0 (Windows NT 10.0)",
      };

      expect(detectDesktop()).toBe(true);
    });

    it("returns false for standard web browser without desktop indicators", () => {
      (globalThis as any).window = {
        location: { search: "" },
      };
      (globalThis as any).navigator = {
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      };

      expect(detectDesktop()).toBe(false);
    });

    it("handles partial or missing window properties gracefully without throwing", () => {
      (globalThis as any).window = {};
      expect(detectDesktop()).toBe(false);

      (globalThis as any).window = { location: null };
      expect(detectDesktop()).toBe(false);
    });
  });
});
