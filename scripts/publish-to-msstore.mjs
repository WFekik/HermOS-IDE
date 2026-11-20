// Updates the Microsoft Store submission for HermOS IDE unmanaged Win32 (NSIS) releases.
// Designed to run in CI (Azure Pipelines) right after scripts/release-to-github.mjs.
//
// Required Environment Variables (set as secret pipeline variables in Azure DevOps):
//   MSSTORE_TENANT_ID      - Microsoft Entra ID Tenant ID
//   MSSTORE_CLIENT_ID      - Azure AD App Registration Client ID
//   MSSTORE_CLIENT_SECRET  - Azure AD App Registration Client Secret
//   MSSTORE_PRODUCT_ID     - Microsoft Store Product ID (e.g. 9NXXXXXXXXXX)
// Optional:
//   MSSTORE_SELLER_ID      - Partner Center Seller ID (optional if linked to tenant)
//   RELEASE_TAG            - e.g. v1.1.4 (Azure provides Build.SourceBranchName)
//   GITHUB_TOKEN           - PAT with repo scope (to query release asset URLs)
//   HERMOS_REPO            - owner/repo override (default: WFekik/HermOS-IDE)

import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const TAG_REGEX = /^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

export function validateConfig(env = process.env) {
  const tag = env.RELEASE_TAG;
  if (!tag) {
    return { valid: false, skip: true, reason: "RELEASE_TAG is not set" };
  }
  if (!TAG_REGEX.test(tag)) {
    return {
      valid: false,
      skip: true,
      reason: `RELEASE_TAG ${JSON.stringify(tag)} is not a semver tag (vX.Y.Z)`,
    };
  }

  const tenantId = env.MSSTORE_TENANT_ID;
  const clientId = env.MSSTORE_CLIENT_ID;
  const clientSecret = env.MSSTORE_CLIENT_SECRET;
  const productId = env.MSSTORE_PRODUCT_ID;

  if (!tenantId || !clientId || !clientSecret || !productId) {
    return {
      valid: false,
      skip: true,
      reason: "Missing MSSTORE_* credentials (TENANT_ID, CLIENT_ID, CLIENT_SECRET, or PRODUCT_ID)",
    };
  }

  return {
    valid: true,
    skip: false,
    config: {
      tenantId,
      clientId,
      clientSecret,
      productId,
      sellerId: env.MSSTORE_SELLER_ID || "",
      tag,
      repo: env.HERMOS_REPO || env.GITHUB_REPOSITORY || "WFekik/HermOS-IDE",
      token: env.GITHUB_TOKEN || "",
    },
  };
}

export function buildPackagePayload({
  downloadUrl,
  languages = ["en", "fr", "de", "es", "zh", "ja", "ar", "ru", "pt"],
  architectures = ["X64"],
  isSilentInstall = true,
}) {
  if (!downloadUrl) throw new Error("downloadUrl is required for Store package payload");
  return {
    packages: [
      {
        packageUrl: downloadUrl,
        languages,
        architectures,
        isSilentInstall,
      },
    ],
  };
}

export function resolveInstallerName(fileList = []) {
  for (const file of fileList) {
    const base = path.basename(file);
    const lower = base.toLowerCase();
    if (
      (lower.endsWith(".exe") || lower.includes("x64-setup") || lower.includes("-setup.exe")) &&
      !lower.endsWith(".sig")
    ) {
      return base;
    }
  }
  return null;
}

export function buildInstallerUrl(repo, tag, fileName) {
  if (!repo || !tag || !fileName) {
    throw new Error("repo, tag, and fileName are required to construct installer URL");
  }
  // GitHub normalizes spaces to dots in uploaded asset names
  const normalizedName = fileName.replace(/ /g, ".");
  return `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(normalizedName)}`;
}

function findLocalNsisInstaller() {
  const nsisDir = path.resolve("src-tauri/target/release/bundle/nsis");
  if (!fs.existsSync(nsisDir)) return null;
  const entries = fs.readdirSync(nsisDir);
  return resolveInstallerName(entries);
}

function getCliCommand() {
  const check = spawnSync("msstore", ["--version"], { stdio: "ignore", shell: true });
  if (check.status === 0) return { cmd: "msstore", argsPrefix: [] };
  return { cmd: "npx", argsPrefix: ["--yes", "@microsoft/msstore-cli"] };
}

async function main() {
  const result = validateConfig(process.env);
  if (!result.valid) {
    console.log(`[msstore] ${result.reason}. Skipping Microsoft Store submission.`);
    return;
  }

  const { tenantId, clientId, clientSecret, productId, sellerId, tag, repo } = result.config;
  console.log(`[msstore] Initializing Microsoft Store submission for product ${productId} (${tag})...`);

  let installerName = findLocalNsisInstaller();
  if (!installerName) {
    const cleanVersion = tag.replace(/^v/i, "");
    installerName = `HermOS.IDE_${cleanVersion}_x64-setup.exe`;
    console.log(`[msstore] Local bundle not found; inferring canonical installer name: ${installerName}`);
  } else {
    console.log(`[msstore] Located local installer binary: ${installerName}`);
  }

  const downloadUrl = buildInstallerUrl(repo, tag, installerName);
  console.log(`[msstore] Target download URL: ${downloadUrl}`);

  const payload = buildPackagePayload({ downloadUrl });
  const payloadString = JSON.stringify(payload);

  const { cmd, argsPrefix } = getCliCommand();
  console.log(`[msstore] Using CLI tool: ${cmd} ${argsPrefix.join(" ")}`);

  console.log("[msstore] Configuring Microsoft Store authentication credentials...");
  const reconfigureArgs = [
    ...argsPrefix,
    "reconfigure",
    "--tenantId",
    tenantId,
    "--clientId",
    clientId,
    "--clientSecret",
    clientSecret,
  ];
  if (sellerId) {
    reconfigureArgs.push("--sellerId", sellerId);
  }

  // Never inherit or print credentials to console
  const authExec = spawnSync(cmd, reconfigureArgs, { stdio: ["ignore", "pipe", "pipe"], shell: true });
  if (authExec.status !== 0) {
    const stderr = authExec.stderr ? authExec.stderr.toString().trim() : "Unknown authentication error";
    throw new Error(`Failed to configure msstore CLI credentials: ${stderr}`);
  }
  console.log("[msstore] Successfully authenticated with Partner Center.");

  console.log(`[msstore] Updating draft submission for ${productId}...`);
  const updateArgs = [...argsPrefix, "submission", "update", productId, payloadString];
  execFileSync(cmd, updateArgs, { stdio: "inherit", shell: true });

  console.log(`[msstore] Publishing submission for ${productId}...`);
  const publishArgs = [...argsPrefix, "submission", "publish", productId];
  execFileSync(cmd, publishArgs, { stdio: "inherit", shell: true });

  console.log(`[msstore] Successfully submitted ${tag} to Microsoft Store!`);
}

if (process.argv[1] && process.argv[1].endsWith("publish-to-msstore.mjs")) {
  main().catch((err) => {
    console.error(`[msstore] Submission failed: ${err.message}`);
    process.exit(1);
  });
}
