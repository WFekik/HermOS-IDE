import { describe, it, expect, vi, afterEach } from "vitest";

const WINDOWS_TAURI = () => {
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
  vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" });
};

describe("Windows Store-distributed updater behavior", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("isStoreDistributed detects Windows desktop builds only", async () => {
    const { isStoreDistributed } = await import("@/lib/updater");

    // Node/test env: not a Tauri desktop app.
    expect(isStoreDistributed()).toBe(false);

    WINDOWS_TAURI();
    expect(isStoreDistributed()).toBe(true);

    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" });
    expect(isStoreDistributed()).toBe(false);
  });

  it("checkForUpdates on Windows points newer GitHub releases at the Store listing", async () => {
    WINDOWS_TAURI();
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({
        version: "1.1.4",
        update: { hasUpdate: true, latestVersion: "1.2.0", releaseName: "v1.2.0" },
      }),
    })));

    const { checkForUpdates, MSSTORE_URL } = await import("@/lib/updater");
    const result = await checkForUpdates(true);

    expect(result.status).toBe("available");
    expect(result.releaseUrl).toBe(MSSTORE_URL);
    expect(result.latestVersion).toBe("1.2.0");
  });

  it("checkForUpdates on Windows degrades to up-to-date without a remote signal", async () => {
    WINDOWS_TAURI();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false })));

    const { checkForUpdates } = await import("@/lib/updater");
    const result = await checkForUpdates(false);

    expect(result.status).toBe("up-to-date");
  });
});
