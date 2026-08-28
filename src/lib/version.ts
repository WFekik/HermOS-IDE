import pkg from "../../package.json";

/**
 * Enterprise Version Control & Build Metadata Engine for HermOS IDE.
 * 
 * Provides a single source of truth for:
 * - Application version & semver resolution (isomorphic for Client & Server)
 * - Release channels (stable, beta, nightly, enterprise)
 * - Git commit hash, build dates, and runtime platform
 * - Dynamic repository and updater endpoints (zero hardcoding)
 * - Semantic version comparisons and update eligibility
 */

export type ReleaseChannel = "stable" | "beta" | "nightly" | "enterprise";

export interface Semver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
  build: string | null;
  raw: string;
}

export interface AppInfoDTO {
  version: string;
  name: string;
  channel: ReleaseChannel;
  buildHash: string;
  buildDate: string;
  repo: string;
  repoUrl: string;
  releasesUrl: string;
  releasesApiUrl: string;
  isDesktop: boolean;
}

export interface UpdateCheckInfo {
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
  channel: ReleaseChannel;
  releaseNotes?: string;
  downloadUrl?: string;
  publishedAt?: string;
}

const DEFAULT_REPO = "WFekik/HermOS-IDE";
const FALLBACK_VERSION = "1.0.1";

let cachedVersion: string | null = null;
let cachedBuildHash: string | null = null;

/**
 * Resolve the application version dynamically with prioritized fallback:
 * 1. HERMOS_VERSION env variable
 * 2. NEXT_PUBLIC_APP_VERSION env variable
 * 3. package.json statically bundled version
 * 4. FALLBACK_VERSION ("1.0.1")
 */
export function getAppVersion(): string {
  if (cachedVersion) return cachedVersion;

  const envVersion =
    (typeof process !== "undefined" ? process.env.HERMOS_VERSION || process.env.NEXT_PUBLIC_APP_VERSION : undefined);

  if (envVersion && isValidSemverString(envVersion.trim())) {
    cachedVersion = envVersion.trim();
    return cachedVersion;
  }

  const pkgVer = (pkg as { version?: string })?.version;
  if (typeof pkgVer === "string" && isValidSemverString(pkgVer)) {
    cachedVersion = pkgVer.trim();
    return cachedVersion;
  }

  cachedVersion = FALLBACK_VERSION;
  return cachedVersion;
}

/**
 * Resolve the GitHub or enterprise Git repository name (owner/repo).
 * Configurable via HERMOS_REPO / NEXT_PUBLIC_HERMOS_REPO without hardcoding.
 */
export function getAppRepo(): string {
  const envRepo =
    typeof process !== "undefined"
      ? process.env.HERMOS_REPO ||
        process.env.NEXT_PUBLIC_HERMOS_REPO ||
        process.env.GITHUB_REPOSITORY
      : undefined;

  if (envRepo && /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(envRepo.trim())) {
    return envRepo.trim();
  }
  return DEFAULT_REPO;
}

/**
 * Resolve the active release channel (stable, beta, nightly, enterprise).
 */
export function getReleaseChannel(): ReleaseChannel {
  const envChannel = (
    (typeof process !== "undefined"
      ? process.env.HERMOS_RELEASE_CHANNEL || process.env.NEXT_PUBLIC_HERMOS_RELEASE_CHANNEL
      : "") || ""
  ).toLowerCase().trim();

  if (envChannel === "beta" || envChannel === "nightly" || envChannel === "enterprise") {
    return envChannel;
  }

  const ver = getAppVersion();
  if (ver.includes("-beta")) return "beta";
  if (ver.includes("-nightly") || ver.includes("-dev")) return "nightly";
  if (ver.includes("-ent")) return "enterprise";

  return "stable";
}

/**
 * Resolve git build commit hash from env or git metadata.
 */
export function getBuildHash(): string {
  if (cachedBuildHash) return cachedBuildHash;

  const envHash =
    typeof process !== "undefined"
      ? process.env.HERMOS_BUILD_HASH ||
        process.env.NEXT_PUBLIC_BUILD_HASH ||
        process.env.VERCEL_GIT_COMMIT_SHA ||
        process.env.GITHUB_SHA
      : undefined;

  if (envHash && /^[a-fA-F0-9]{7,40}$/.test(envHash.trim())) {
    cachedBuildHash = envHash.trim().slice(0, 7);
    return cachedBuildHash;
  }

  cachedBuildHash = "local";
  return cachedBuildHash;
}

/**
 * Returns true if running inside Tauri desktop environment.
 */
export function isDesktopApp(): boolean {
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    return true;
  }
  return typeof process !== "undefined" && (process.env.HERMOS_DESKTOP === "1" || process.env.TAURI_ENV_PLATFORM !== undefined);
}

/**
 * Returns full application info DTO.
 */
export function getAppInfo(): AppInfoDTO {
  const version = getAppVersion();
  const repo = getAppRepo();
  const channel = getReleaseChannel();
  const buildHash = getBuildHash();
  const repoUrl = `https://github.com/${repo}`;
  const releasesUrl = `${repoUrl}/releases`;
  const releasesApiUrl = `https://api.github.com/repos/${repo}/releases`;

  return {
    version,
    name: "HermOS IDE",
    channel,
    buildHash,
    buildDate:
      (typeof process !== "undefined" ? process.env.HERMOS_BUILD_DATE : undefined) ||
      new Date().toISOString().split("T")[0],
    repo,
    repoUrl,
    releasesUrl,
    releasesApiUrl,
    isDesktop: isDesktopApp(),
  };
}

/**
 * Parse a semver string into structured components.
 */
export function parseSemver(v: string): Semver | null {
  if (!v || typeof v !== "string") return null;
  const clean = v.trim().replace(/^v/i, "");
  const match = clean.match(
    /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/,
  );
  if (!match) return null;

  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
    prerelease: match[4] || null,
    build: match[5] || null,
    raw: v,
  };
}

export function isValidSemverString(v: string): boolean {
  return parseSemver(v) !== null;
}

/**
 * Compare two semver strings according to SemVer 2.0.0 specification.
 * Returns:
 *   -1 if v1 < v2
 *    0 if v1 === v2
 *    1 if v1 > v2
 */
export function compareSemver(v1: string, v2: string): number {
  const s1 = parseSemver(v1);
  const s2 = parseSemver(v2);

  if (!s1 && !s2) return 0;
  if (!s1) return -1;
  if (!s2) return 1;

  if (s1.major !== s2.major) return s1.major > s2.major ? 1 : -1;
  if (s1.minor !== s2.minor) return s1.minor > s2.minor ? 1 : -1;
  if (s1.patch !== s2.patch) return s1.patch > s2.patch ? 1 : -1;

  // Prerelease comparison:
  // 1.0.0 > 1.0.0-beta
  if (!s1.prerelease && s2.prerelease) return 1;
  if (s1.prerelease && !s2.prerelease) return -1;
  if (!s1.prerelease && !s2.prerelease) return 0;

  if (s1.prerelease && s2.prerelease) {
    const parts1 = s1.prerelease.split(".");
    const parts2 = s2.prerelease.split(".");
    const len = Math.max(parts1.length, parts2.length);

    for (let i = 0; i < len; i++) {
      if (parts1[i] === undefined) return -1;
      if (parts2[i] === undefined) return 1;
      if (parts1[i] === parts2[i]) continue;

      const n1 = Number(parts1[i]);
      const n2 = Number(parts2[i]);
      const isNum1 = !Number.isNaN(n1);
      const isNum2 = !Number.isNaN(n2);

      if (isNum1 && isNum2) {
        return n1 > n2 ? 1 : -1;
      }
      if (isNum1 && !isNum2) return -1;
      if (!isNum1 && isNum2) return 1;
      return parts1[i].localeCompare(parts2[i]);
    }
  }

  return 0;
}

/**
 * Returns true if candidateVersion is newer than currentVersion.
 */
export function isNewerVersion(currentVersion: string, candidateVersion: string): boolean {
  return compareSemver(candidateVersion, currentVersion) > 0;
}

/**
 * Clear cached memoized version values (useful for tests and dynamic reloads).
 */
export function resetVersionCache(): void {
  cachedVersion = null;
  cachedBuildHash = null;
}
