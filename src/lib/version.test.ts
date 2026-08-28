import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  getAppVersion,
  getAppRepo,
  getReleaseChannel,
  getBuildHash,
  getAppInfo,
  parseSemver,
  compareSemver,
  isNewerVersion,
  resetVersionCache,
} from "./version";

describe("HermOS Version Management Engine", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    resetVersionCache();
    process.env = { ...originalEnv };
    delete process.env.HERMOS_VERSION;
    delete process.env.NEXT_PUBLIC_APP_VERSION;
    delete process.env.HERMOS_REPO;
    delete process.env.NEXT_PUBLIC_HERMOS_REPO;
    delete process.env.HERMOS_RELEASE_CHANNEL;
    delete process.env.NEXT_PUBLIC_HERMOS_RELEASE_CHANNEL;
    delete process.env.HERMOS_BUILD_HASH;
  });

  afterEach(() => {
    process.env = originalEnv;
    resetVersionCache();
  });

  describe("Semver parsing and comparisons", () => {
    it("parses valid semver strings correctly", () => {
      const s1 = parseSemver("1.2.3");
      expect(s1).toEqual({
        major: 1,
        minor: 2,
        patch: 3,
        prerelease: null,
        build: null,
        raw: "1.2.3",
      });

      const s2 = parseSemver("v2.0.0-beta.1+build.123");
      expect(s2).toEqual({
        major: 2,
        minor: 0,
        patch: 0,
        prerelease: "beta.1",
        build: "build.123",
        raw: "v2.0.0-beta.1+build.123",
      });
    });

    it("returns null for invalid semver strings", () => {
      expect(parseSemver("invalid")).toBeNull();
      expect(parseSemver("1.0")).toBeNull();
      expect(parseSemver("")).toBeNull();
    });

    it("compares semver versions accurately", () => {
      expect(compareSemver("1.0.0", "1.0.0")).toBe(0);
      expect(compareSemver("1.0.1", "1.0.0")).toBe(1);
      expect(compareSemver("1.0.0", "1.0.1")).toBe(-1);
      expect(compareSemver("1.1.0", "1.0.9")).toBe(1);
      expect(compareSemver("2.0.0", "1.99.99")).toBe(1);

      // Prerelease comparison
      expect(compareSemver("1.0.0", "1.0.0-beta.1")).toBe(1);
      expect(compareSemver("1.0.0-beta.2", "1.0.0-beta.1")).toBe(1);
      expect(compareSemver("1.0.0-beta.1", "1.0.0-alpha.1")).toBe(1);
    });

    it("evaluates isNewerVersion accurately", () => {
      expect(isNewerVersion("1.0.0", "1.0.1")).toBe(true);
      expect(isNewerVersion("1.0.0", "1.1.0")).toBe(true);
      expect(isNewerVersion("1.0.0", "2.0.0")).toBe(true);
      expect(isNewerVersion("1.0.0", "1.0.0")).toBe(false);
      expect(isNewerVersion("1.0.1", "1.0.0")).toBe(false);
    });
  });

  describe("Dynamic configuration without hardcoding", () => {
    it("respects HERMOS_VERSION env variable override", () => {
      process.env.HERMOS_VERSION = "2.5.0";
      expect(getAppVersion()).toBe("2.5.0");
    });

    it("respects HERMOS_REPO env variable override", () => {
      process.env.HERMOS_REPO = "EnterpriseCorp/Custom-IDE";
      expect(getAppRepo()).toBe("EnterpriseCorp/Custom-IDE");
    });

    it("respects HERMOS_RELEASE_CHANNEL override", () => {
      process.env.HERMOS_RELEASE_CHANNEL = "enterprise";
      expect(getReleaseChannel()).toBe("enterprise");
    });

    it("generates full AppInfoDTO dynamically", () => {
      process.env.HERMOS_VERSION = "3.0.0";
      process.env.HERMOS_REPO = "Company/HermOS";
      process.env.HERMOS_RELEASE_CHANNEL = "beta";
      process.env.HERMOS_BUILD_HASH = "a1b2c3d";

      const info = getAppInfo();
      expect(info.version).toBe("3.0.0");
      expect(info.repo).toBe("Company/HermOS");
      expect(info.channel).toBe("beta");
      expect(info.buildHash).toBe("a1b2c3d");
      expect(info.repoUrl).toBe("https://github.com/Company/HermOS");
      expect(info.releasesUrl).toBe("https://github.com/Company/HermOS/releases");
    });
  });
});
