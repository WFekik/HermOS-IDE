import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import {
  validateConfig,
  resolveMsixPath,
  replacePackages,
  buildZipBundle,
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
      };
      const res = validateConfig(full);
      expect(res.valid).toBe(true);
      expect(res.skip).toBe(false);
      expect(res.config.tag).toBe("v1.2.0");
      expect(res.config.productId).toBe("9NXXXXXXXXXX");
      expect(res.config.tenantId).toBe("tenant-123");
    });
  });

  describe("resolveMsixPath", () => {
    it("targets the pack-msix output for the given version", () => {
      expect(resolveMsixPath("1.2.0").endsWith("HermOS.IDE_1.2.0_x64.msix")).toBe(true);
    });

    it("strips a v prefix", () => {
      expect(resolveMsixPath("v1.2.0").endsWith("HermOS.IDE_1.2.0_x64.msix")).toBe(true);
    });
  });

  describe("replacePackages", () => {
    it("retires existing .msix packages and appends the new one as PendingUpload", () => {
      const submission = {
        applicationPackages: [
          { fileName: "HermOS.IDE_1.1.4_x64.msix", fileStatus: "Processed", id: "1" },
          { fileName: "icon.png", fileStatus: "Uploaded", id: "2" },
        ],
      };
      const packages = replacePackages(submission, "HermOS.IDE_1.2.0_x64.msix");
      expect(packages.find((p) => p.fileName === "HermOS.IDE_1.1.4_x64.msix")?.fileStatus).toBe(
        "PendingDelete",
      );
      expect(packages.find((p) => p.fileName === "icon.png")?.fileStatus).toBe("Uploaded");
      expect(packages.filter((p) => p.fileName === "HermOS.IDE_1.2.0_x64.msix")).toEqual([
        { fileName: "HermOS.IDE_1.2.0_x64.msix", fileStatus: "PendingUpload" },
      ]);
    });

    it("tolerates PascalCase submission payloads", () => {
      const submission = { ApplicationPackages: [{ FileName: "old.msix", FileStatus: "Uploaded" }] };
      const packages = replacePackages(submission, "new.msix");
      const oldPkg = packages.find((p) => (p.fileName ?? p.FileName) === "old.msix");
      expect(oldPkg?.fileStatus).toBe("PendingDelete");
      expect(packages.find((p) => p.fileName === "new.msix")?.fileStatus).toBe("PendingUpload");
    });

    it("throws when the submission has no package list", () => {
      expect(() => replacePackages({}, "new.msix")).toThrow("applicationPackages");
    });
  });

  describe("buildZipBundle", () => {
    it("zips the msix so the archive root holds the package file", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hermos-msstore-"));
      try {
        const msixPath = path.join(dir, "HermOS.IDE_1.2.0_x64.msix");
        fs.writeFileSync(msixPath, "fake-msix-bytes");
        const bundlePath = path.join(dir, "bundle.zip");
        buildZipBundle(msixPath, bundlePath);
        const zip = new AdmZip(bundlePath);
        expect(zip.getEntries().map((e) => e.entryName)).toEqual(["HermOS.IDE_1.2.0_x64.msix"]);
        expect(zip.readAsText("HermOS.IDE_1.2.0_x64.msix")).toBe("fake-msix-bytes");
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
