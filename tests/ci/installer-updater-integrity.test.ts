import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * CI Invariant Guard: Auto-Update & Sidecar Lifecycle Integrity
 *
 * Verifies the multi-layer defensive architecture documented in AGENTS.md:
 * 1. NSIS Pre-install hook purges the full .next-build directory (preventing Next.js
 *    runtime route-cache and chunk poisoning across updates).
 * 2. NSIS Post-uninstall hook wipes the entire _up_ directory.
 * 3. Root layout strictly disables static route caching with force-dynamic and revalidate=0.
 * 4. Desktop window navigation tags document URL with version query (?v=X.Y.Z) to bypass WebView2 disk caching.
 * 5. Next.js config sends Cache-Control: no-store headers for root document.
 */
const rootDir = path.resolve(__dirname, "..", "..");
const installerHooksNsh = fs.readFileSync(
  path.join(rootDir, "src-tauri", "installer-hooks.nsh"),
  "utf-8",
);
const rootLayoutTsx = fs.readFileSync(
  path.join(rootDir, "src", "app", "layout.tsx"),
  "utf-8",
);
const nextConfigTs = fs.readFileSync(
  path.join(rootDir, "next.config.ts"),
  "utf-8",
);
const tauriLibRs = fs.readFileSync(
  path.join(rootDir, "src-tauri", "src", "lib.rs"),
  "utf-8",
);

describe("installer and updater caching integrity", () => {
  describe("NSIS installer hooks (installer-hooks.nsh)", () => {
    it("purges entire .next-build directory in NSIS_HOOK_PREINSTALL", () => {
      // Must purge full .next-build (not merely static/chunks) so runtime
      // route-cache (server/route-cache) and stale server components never poison the new release.
      expect(installerHooksNsh).toContain(
        'RMDir /r "$INSTDIR\\_up_\\.next-build\\standalone\\.next-build"',
      );
    });

    it("wipes entire _up_ directory in NSIS_HOOK_POSTUNINSTALL", () => {
      expect(installerHooksNsh).toContain('RMDir /r "$INSTDIR\\_up_"');
    });

    it("uses HERMOS_INSTDIR environment variable for safe PowerShell path passing", () => {
      expect(installerHooksNsh).toContain('SetEnvironmentVariable(t "HERMOS_INSTDIR"');
      expect(installerHooksNsh).toContain('$$env:HERMOS_INSTDIR');
    });

    it("scopes orphan node cleanup by both ExecutablePath and CommandLine", () => {
      expect(installerHooksNsh).toContain("ExecutablePath -like ('*' + $$env:HERMOS_INSTDIR + '*')");
      expect(installerHooksNsh).toContain("CommandLine -like ('*' + $$env:HERMOS_INSTDIR + '*')");
    });
  });

  describe("Next.js runtime caching defenses", () => {
    it("root layout enforces force-dynamic and revalidate = 0", () => {
      expect(rootLayoutTsx).toMatch(/export\s+const\s+dynamic\s*=\s*["']force-dynamic["']/);
      expect(rootLayoutTsx).toMatch(/export\s+const\s+revalidate\s*=\s*0/);
    });

    it("next.config.ts enforces no-store Cache-Control on root route", () => {
      expect(nextConfigTs).toContain('source: "/"');
      expect(nextConfigTs).toMatch(/no-store/i);
      expect(nextConfigTs).toMatch(/no-cache/i);
    });
  });

  describe("Tauri desktop cache bypassing", () => {
    it("lib.rs version-tags document navigation URL (?v=CARGO_PKG_VERSION)", () => {
      expect(tauriLibRs).toContain('format!(\n      "{}/?v={}"');
      expect(tauriLibRs).toContain('env!("CARGO_PKG_VERSION")');
    });
  });
});
