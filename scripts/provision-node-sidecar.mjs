import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import { execFileSync, spawnSync } from "child_process";
import { join, dirname } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");
const binariesDir = join(rootDir, "src-tauri", "binaries");

// ---------------------------------------------------------------------------
// Pinned Node.js distribution version for the bundled sidecar binary.
//
// MUST be a real published release under https://nodejs.org/dist/ — the macOS
// CI leg downloads exactly this version for BOTH arch slices and lipos them
// into a universal binary that ships inside the installers.
//
// v22.23.2 is the newest patch of the Node.js 22 LTS line (published
// 2026-07-29). Bump this constant deliberately when adopting a new runtime:
// every installer embeds it, and the `.sidecar-version` marker written next
// to the sidecar invalidates previously provisioned copies on upgrade.
// ---------------------------------------------------------------------------
const NODE_SIDECAR_VERSION = "22.23.2";

// Marker file written next to each provisioned sidecar; its content records
// which build produced the binary so stale sidecars never survive upgrades.
const VERSION_MARKER_SUFFIX = ".sidecar-version";

const NODE_DIST_BASE = "https://nodejs.org/dist";

/**
 * Determine Tauri target triple based on Node.js process platform & arch.
 */
function getTargetTriple() {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === "win32") {
    if (arch === "arm64") return "aarch64-pc-windows-msvc";
    return "x86_64-pc-windows-msvc";
  } else if (platform === "darwin") {
    if (arch === "arm64") return "aarch64-apple-darwin";
    return "x86_64-apple-darwin";
  } else if (platform === "linux") {
    if (arch === "arm64") return "aarch64-unknown-linux-gnu";
    return "x86_64-unknown-linux-gnu";
  }
  return `${arch}-${platform}`;
}

/**
 * Read the expected sha256 for `fileName` from the dist SHASUMS256.txt of the
 * pinned version. Throws loudly when the checksum listing cannot be fetched
 * or does not contain the expected artifact — we never extract unverified
 * tarballs.
 */
function expectedSha256(fileName) {
  const shasumsUrl = `${NODE_DIST_BASE}/v${NODE_SIDECAR_VERSION}/SHASUMS256.txt`;
  console.log(`[sidecar] Fetching checksums ${shasumsUrl}`);
  // argv array (never string interpolation) so paths/URLs stay spaces-safe.
  const shasums = execFileSync("curl", ["-fsSL", shasumsUrl], { encoding: "utf8" });
  const line = shasums
    .split("\n")
    .find((l) => l.trimEnd().endsWith(`  ${fileName}`));
  if (!line) {
    throw new Error(
      `[sidecar] ${fileName} not listed in SHASUMS256.txt for v${NODE_SIDECAR_VERSION}`,
    );
  }
  const sha = line.trim().split(/\s+/)[0].toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha)) {
    throw new Error(`[sidecar] Malformed sha256 entry for ${fileName}: ${line}`);
  }
  return sha;
}

/**
 * Download a dist tarball via curl (argv array), verify its sha256 against
 * the official SHASUMS256.txt BEFORE extracting, then untar into destDir.
 */
function downloadAndExtractNode(url, fileName, destDir) {
  const tarball = join(destDir, fileName);
  console.log(`[sidecar] Downloading ${url}`);
  execFileSync("curl", ["-fsSL", "-o", tarball, url], { stdio: "inherit" });

  const actual = createHash("sha256").update(readFileSync(tarball)).digest("hex");
  const expected = expectedSha256(fileName);
  if (actual !== expected) {
    rmSync(tarball, { force: true });
    throw new Error(
      `[sidecar] SHA-256 MISMATCH for ${fileName}\n` +
        `  expected: ${expected}\n` +
        `  actual:   ${actual}\n` +
        `[sidecar] Refusing to extract an unverified tarball.`,
    );
  }
  console.log(`[sidecar] Checksum OK (${fileName})`);

  execFileSync("tar", ["-xzf", tarball, "-C", destDir], { stdio: "inherit" });
  // Post-extract integrity guard: re-hash the tarball bytes still on disk to
  // prove nothing clobbered the file between verification and extraction.
  const after = createHash("sha256").update(readFileSync(tarball)).digest("hex");
  if (after !== expected) {
    throw new Error(`[sidecar] Tarball changed on disk between verify and extract: ${fileName}`);
  }
  rmSync(tarball, { force: true });
}

/**
 * Marker content for a provisioned sidecar — always pinned to
 * NODE_SIDECAR_VERSION so stale sidecars never survive upgrades regardless
 * of which Node version the build host happens to run.
 */
function sidecarVersionTag(sidecarName) {
  return `${sidecarName}@v${NODE_SIDECAR_VERSION}`;
}

/**
 * Early-exit only when BOTH the sidecar exists AND its version marker matches
 * what this run would provision — otherwise a stale binary from an older
 * pinned version would silently ship in the next installer build.
 */
function shouldSkipProvisioning(sidecarName, targetPath) {
  const markerPath = `${targetPath}${VERSION_MARKER_SUFFIX}`;
  const expectedTag = sidecarVersionTag(sidecarName);
  if (!existsSync(targetPath)) return false;
  let marker = null;
  try {
    marker = readFileSync(markerPath, "utf8").trim();
  } catch {
    // missing/unreadable marker → treat as stale
  }
  if (marker === expectedTag) {
    console.log(`[sidecar] ${sidecarName} already provisioned at ${targetPath} (marker: ${marker})`);
    return true;
  }
  console.log(
    `[sidecar] Stale sidecar at ${targetPath} (marker: ${marker ?? "<none>"}, need: ${expectedTag}) — reprovisioning`,
  );
  return false;
}

function writeVersionMarker(sidecarName, targetPath) {
  writeFileSync(`${targetPath}${VERSION_MARKER_SUFFIX}`, `${sidecarVersionTag(sidecarName)}\n`);
}

function provisionUniversalMacSidecar() {
  const version = NODE_SIDECAR_VERSION;
  const distDir = `${NODE_DIST_BASE}/v${version}`;
  const ext = "";

  const targets = [
    { triple: "aarch64-apple-darwin", plat: "darwin", arch: "arm64" },
    { triple: "x86_64-apple-darwin", plat: "darwin", arch: "x64" },
  ];

  mkdirSync(binariesDir, { recursive: true });

  const workDir = mkdtempSync(join(tmpdir(), "hermos-node-sidecar-"));

  try {
    for (const t of targets) {
      const sidecarName = `node-${t.triple}${ext}`;
      const targetPath = join(binariesDir, sidecarName);

      if (shouldSkipProvisioning(sidecarName, targetPath)) continue;

      const archDir = join(workDir, t.arch);
      mkdirSync(archDir, { recursive: true });

      const fileName = `node-v${version}-${t.plat}-${t.arch}.tar.gz`;
      console.log(`[sidecar] Provisioning ${sidecarName}`);
      downloadAndExtractNode(`${distDir}/${fileName}`, fileName, archDir);

      const extracted = join(archDir, `node-v${version}-${t.plat}-${t.arch}`, "bin", "node");
      if (!existsSync(extracted)) throw new Error(`Extracted node not found at ${extracted}`);
      copyFileSync(extracted, targetPath);
      try { execFileSync("chmod", ["+x", targetPath]); } catch {}

      const isNativeArch = (t.arch === "arm64" && process.arch === "arm64") || (t.arch === "x64" && process.arch === "x64");
      if (isNativeArch) {
        validateBinary(targetPath);
      } else {
        console.log(`[sidecar] Skipping validation for non-native arch ${t.arch} (runner: ${process.arch})`);
      }
      writeVersionMarker(sidecarName, targetPath);
      console.log(`[sidecar] Successfully provisioned ${sidecarName}`);
    }
    // Also create universal binary for bundling stage (tauri expects node-universal-apple-darwin)
    const aarch64Bin = join(binariesDir, "node-aarch64-apple-darwin");
    const x64Bin = join(binariesDir, "node-x86_64-apple-darwin");
    const universalPath = join(binariesDir, "node-universal-apple-darwin");
    if (existsSync(aarch64Bin) && existsSync(x64Bin)) {
      try {
        console.log(`[sidecar] Creating universal binary via lipo...`);
        execFileSync("lipo", ["-create", "-output", universalPath, aarch64Bin, x64Bin], { stdio: "inherit" });
        execFileSync("chmod", ["+x", universalPath]);
        execFileSync("lipo", ["-info", universalPath], { stdio: "inherit" });
        writeVersionMarker("node-universal-apple-darwin", universalPath);
        console.log(`[sidecar] Successfully provisioned universal binary`);
      } catch (e) {
        console.warn(`[sidecar] Failed to create universal binary: ${e.message}`);
      }
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function provisionSingleArchSidecar() {
  const targetTriple = getTargetTriple();
  const ext = process.platform === "win32" ? ".exe" : "";
  const sidecarName = `node-${targetTriple}${ext}`;
  const targetPath = join(binariesDir, sidecarName);

  if (shouldSkipProvisioning(sidecarName, targetPath)) return;

  mkdirSync(binariesDir, { recursive: true });

  // Try to download the pinned Node distribution with checksum verification
  // (same flow as macOS universal). If network is unavailable, fall back to
  // copying the local runtime with a local marker so subsequent builds always
  // attempt to re-provision the pinned version.
  const version = NODE_SIDECAR_VERSION;
  const distDir = `${NODE_DIST_BASE}/v${version}`;
  let pinnedOk = false;
  try {
    if (process.platform === "win32") {
      const fileName = `node-v${version}-win-${process.arch === "arm64" ? "arm64" : "x64"}.zip`;
      const workDir = mkdtempSync(join(tmpdir(), "hermos-node-sidecar-"));
      try {
        const zipPath = join(workDir, fileName);
        console.log(`[sidecar] Attempting pinned download ${distDir}/${fileName}`);
        execFileSync("curl", ["-fsSL", "-o", zipPath, `${distDir}/${fileName}`], { stdio: "inherit" });
        const actual = createHash("sha256").update(readFileSync(zipPath)).digest("hex");
        const expected = expectedSha256(fileName);
        if (actual !== expected) throw new Error(`SHA-256 mismatch for ${fileName}: expected ${expected}, got ${actual}`);
        console.log(`[sidecar] Checksum OK (${fileName})`);
        // Extract via PowerShell Expand-Archive (Windows) or unzip
        try {
          execFileSync("powershell", ["-Command", `Expand-Archive -Path "${zipPath}" -DestinationPath "${workDir}" -Force`], { stdio: "inherit" });
        } catch {
          execFileSync("tar", ["-xf", zipPath, "-C", workDir], { stdio: "inherit" });
        }
        const exeName = process.arch === "arm64" ? `node-v${version}-win-arm64/node.exe` : `node-v${version}-win-x64/node.exe`;
        const extracted = join(workDir, exeName);
        if (!existsSync(extracted)) throw new Error(`Extracted node.exe not found at ${extracted}`);
        copyFileSync(extracted, targetPath);
        pinnedOk = true;
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    } else {
      // Linux / single-arch Darwin: tarball
      const plat = process.platform === "darwin" ? "darwin" : "linux";
      const arch = process.arch === "arm64" ? "arm64" : "x64";
      const fileName = `node-v${version}-${plat}-${arch}.tar.gz`;
      const altFileName = `node-v${version}-${plat}-${arch}.tar.xz`;
      const workDir = mkdtempSync(join(tmpdir(), "hermos-node-sidecar-"));
      try {
        let usedFile = fileName;
        try {
          downloadAndExtractNode(`${distDir}/${fileName}`, fileName, workDir);
        } catch (e) {
          // Try .tar.xz fallback (Node 22 Linux uses xz)
          console.log(`[sidecar] ${fileName} not found, trying ${altFileName}`);
          downloadAndExtractNode(`${distDir}/${altFileName}`, altFileName, workDir);
          usedFile = altFileName;
        }
        const binName = `node-v${version}-${plat}-${arch}`;
        const extracted = join(workDir, binName, "bin", "node");
        if (!existsSync(extracted)) throw new Error(`Extracted node not found at ${extracted}`);
        copyFileSync(extracted, targetPath);
        // Ensure executable
        try { execFileSync("chmod", ["+x", targetPath]); } catch {}
        pinnedOk = true;
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    }
    if (pinnedOk) {
      validateBinary(targetPath);
      writeVersionMarker(sidecarName, targetPath);
      console.log(`[sidecar] Successfully provisioned pinned Node.js v${version} sidecar: ${targetPath}`);
      return;
    }
  } catch (e) {
    console.warn(`[sidecar] Pinned download failed (${e.message}), falling back to local copy`);
  }

  // Fallback: copy local Node binary (offline / network failure)
  const currentNodeBinary = process.execPath;
  console.log(`[sidecar] Provisioning Node.js sidecar for target ${targetTriple} (fallback copy)...`);
  console.log(`[sidecar] Source: ${currentNodeBinary}`);
  console.log(`[sidecar] Destination: ${targetPath}`);
  copyFileSync(currentNodeBinary, targetPath);
  let valid = true;
  try {
    validateBinary(targetPath);
  } catch (err) {
    valid = false;
    console.warn(`[sidecar] Warning: post-copy validation check failed: ${err.message}`);
  }
  if (valid) {
    // Stamp a distinct fallback marker so shouldSkipProvisioning always
    // reprovisions on subsequent builds — a local fallback copy is never authoritative.
    const fallbackTag = `${sidecarName}@local-${process.versions.node}`;
    writeFileSync(`${targetPath}${VERSION_MARKER_SUFFIX}`, `${fallbackTag}\n`);
    console.log(`[sidecar] Successfully provisioned Node.js sidecar binary (fallback, marker: ${fallbackTag}).`);
  } else {
    console.error(`[sidecar] Sidecar failed validation — version marker NOT written.`);
  }
}

/**
 * Execute `<sidecar> --version` via spawnSync argv array (spaces-safe) and
 * fail loudly unless it prints a plausible version string.
 */
function validateBinary(binaryPath) {
  const result = spawnSync(binaryPath, ["--version"], { encoding: "utf8" });
  if (result.error || result.status !== 0 || !/^v\d+\.\d+\.\d+/.test((result.stdout ?? "").trim())) {
    throw new Error(
      `validation run failed: ${(result.error && result.error.message) || `exit=${result.status}`}`,
    );
  }
  console.log(`[sidecar] Validated binary execution: ${(result.stdout ?? "").trim()}`);
}

function ensureStandalonePlaceholder() {
  const standaloneDir = join(rootDir, ".next-build", "standalone");
  if (!existsSync(standaloneDir)) {
    mkdirSync(standaloneDir, { recursive: true });
  }
  const placeholder = join(standaloneDir, ".gitkeep");
  if (!existsSync(placeholder)) {
    writeFileSync(placeholder, "");
  }
}

function main() {
  ensureStandalonePlaceholder();
  if (isMacOsCi()) {
    console.log("[sidecar] macOS CI detected — provisioning arm64 + x64 Node sidecars for universal build");
    provisionUniversalMacSidecar();
    return;
  }
  provisionSingleArchSidecar();
}

function isMacOsCi() {
  if (process.env.HERMOS_MACOS_UNIVERSAL === "1") return true;
  const isCI = process.env.CI === "true" || process.env.CI === "True" || process.env.TF_BUILD === "True";
  const isMacOS =
    process.env.RUNNER_OS === "macOS" || // GitHub Actions
    process.env.AGENT_OS === "Darwin";  // Azure DevOps
  return isCI && isMacOS && process.platform === "darwin";
}

main();
