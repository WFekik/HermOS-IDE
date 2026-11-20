import { describe, it, expect } from "vitest";
import {
  validateConfig,
  buildPackagePayload,
  resolveInstallerName,
  buildInstallerUrl,
} from "../../scripts/publish-to-msstore.mjs";

describe("Microsoft Store submission helper (publish-to-msstore.mjs)", () => {
  describe("validateConfig", () => {
    it("skips gracefully when RELEASE_TAG is not set", () => {
      const res = validateConfig({});
      expect(res.valid).toBe(false);
      expect(res.skip).toBe(true);
      expect(res.reason).toContain("RELEASE_TAG is not set");
    });

    it("skips gracefully on non-semver tags (e.g. branch or custom build tags)", () => {
      const res = validateConfig({ RELEASE_TAG: "beta-build-1" });
      expect(res.valid).toBe(false);
      expect(res.skip).toBe(true);
      expect(res.reason).toContain("not a semver tag");
    });

    it("skips gracefully when any required MSSTORE credentials are missing", () => {
      const incomplete = {
        RELEASE_TAG: "v1.2.0",
        MSSTORE_TENANT_ID: "test-tenant",
        // missing CLIENT_ID, CLIENT_SECRET, PRODUCT_ID
      };
      const res = validateConfig(incomplete);
      expect(res.valid).toBe(false);
      expect(res.skip).toBe(true);
      expect(res.reason).toContain("Missing MSSTORE_* credentials");
    });

    it("validates successfully when all required parameters are provided", () => {
      const full = {
        RELEASE_TAG: "v1.2.0",
        MSSTORE_TENANT_ID: "tenant-123",
        MSSTORE_CLIENT_ID: "client-456",
        MSSTORE_CLIENT_SECRET: "secret-789",
        MSSTORE_PRODUCT_ID: "9NXXXXXXXXXX",
        MSSTORE_SELLER_ID: "seller-111",
      };
      const res = validateConfig(full);
      expect(res.valid).toBe(true);
      expect(res.skip).toBe(false);
      expect(res.config.tag).toBe("v1.2.0");
      expect(res.config.productId).toBe("9NXXXXXXXXXX");
      expect(res.config.tenantId).toBe("tenant-123");
      expect(res.config.sellerId).toBe("seller-111");
    });
  });

  describe("buildPackagePayload", () => {
    it("formats the unmanaged Win32 EXE package payload correctly", () => {
      const url = "https://github.com/WFekik/HermOS-IDE/releases/download/v1.2.0/HermOS.IDE_1.2.0_x64-setup.exe";
      const payload = buildPackagePayload({ downloadUrl: url });

      expect(payload).toEqual({
        packages: [
          {
            packageUrl: url,
            languages: ["en", "fr", "de", "es", "zh", "ja", "ar", "ru", "pt"],
            architectures: ["X64"],
            isSilentInstall: true,
          },
        ],
      });
    });

    it("throws when downloadUrl is missing", () => {
      expect(() => buildPackagePayload({})).toThrow("downloadUrl is required");
    });
  });

  describe("resolveInstallerName", () => {
    it("identifies the NSIS setup executable and filters out signatures and other files", () => {
      const files = [
        "latest.json",
        "HermOS IDE_1.2.0_x64-setup.exe.sig",
        "HermOS IDE_1.2.0_x64_en-US.msi",
        "HermOS IDE_1.2.0_x64-setup.exe",
      ];
      expect(resolveInstallerName(files)).toBe("HermOS IDE_1.2.0_x64-setup.exe");
    });

    it("returns null when no matching installer exists", () => {
      expect(resolveInstallerName(["readme.txt", "latest.json"])).toBeNull();
    });
  });

  describe("buildInstallerUrl", () => {
    it("generates an immutable, normalized GitHub release asset download URL", () => {
      const url = buildInstallerUrl("WFekik/HermOS-IDE", "v1.2.0", "HermOS IDE_1.2.0_x64-setup.exe");
      expect(url).toBe(
        "https://github.com/WFekik/HermOS-IDE/releases/download/v1.2.0/HermOS.IDE_1.2.0_x64-setup.exe",
      );
    });

    it("throws when parameters are missing", () => {
      expect(() => buildInstallerUrl("", "v1.0.0", "app.exe")).toThrow();
    });
  });
});
