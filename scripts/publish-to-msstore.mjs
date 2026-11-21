// Publishes the packaged HermOS IDE MSIX to the Microsoft Store via the
// Store submission API (managed flow). Mirrors the steps performed by the
// Microsoft Store Developer CLI's `publish` command:
//   token → resolve app → recreate draft → replace packages → PUT submission
//   → upload zip bundle to the SAS URL → commit.
// Docs: https://learn.microsoft.com/windows/uwp/monetize/manage-app-submissions
//
// The app's FIRST publication must be completed manually in Partner Center;
// afterwards this script can run unattended on every release tag.
//
// Required Environment Variables (set as secret pipeline variables in Azure DevOps):
//   MSSTORE_TENANT_ID      - Microsoft Entra ID Tenant ID
//   MSSTORE_CLIENT_ID      - Azure AD App Registration Client ID
//   MSSTORE_CLIENT_SECRET  - Azure AD App Registration Client Secret
//   MSSTORE_PRODUCT_ID     - Microsoft Store Product ID (e.g. 9NXXXXXXXXXX)
// Optional:
//   RELEASE_TAG            - e.g. v1.1.4 (Azure provides Build.SourceBranchName)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");

const DEVCENTER_BASE = "https://manage.devcenter.microsoft.com/v1.0/my";
const TAG_REGEX = /^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const SUBMISSION_POLL_INTERVAL_MS = 30_000;
const SUBMISSION_POLL_TIMEOUT_MS = 15 * 60_000;

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
    config: { tenantId, clientId, clientSecret, productId, tag },
  };
}

export function resolveMsixPath(version) {
  const clean = String(version || "").trim().replace(/^v/i, "");
  return path.join(
    ROOT_DIR,
    "src-tauri",
    "target",
    "release",
    "bundle",
    "msix",
    `HermOS.IDE_${clean}_x64.msix`,
  );
}

// The Dev Center API speaks camelCase; tolerate PascalCase echoes defensively.
function pick(obj, key) {
  if (!obj || typeof obj !== "object") return undefined;
  const lower = key.toLowerCase();
  for (const k of Object.keys(obj)) {
    if (k.toLowerCase() === lower) return obj[k];
  }
  return undefined;
}

/**
 * Retire every existing .msix entry (same-extension packages must be marked
 * PendingDelete or the upload is rejected as a duplicate) and add the new
 * package as PendingUpload. Mutates and returns the submission's package list.
 */
export function replacePackages(submission, fileName) {
  const packages = pick(submission, "applicationPackages");
  if (!Array.isArray(packages)) {
    throw new Error("Submission JSON has no applicationPackages array");
  }
  for (const pkg of packages) {
    if (String(pick(pkg, "fileName") || "").toLowerCase().endsWith(".msix")) {
      pkg.fileStatus = "PendingDelete";
    }
  }
  packages.push({ fileName, fileStatus: "PendingUpload" });
  return packages;
}

export function buildZipBundle(msixPath, outPath) {
  const zip = new AdmZip();
  zip.addLocalFile(msixPath);
  zip.writeZip(outPath);
  return outPath;
}

async function getAccessToken({ tenantId, clientId, clientSecret }) {
  const res = await fetch(
    `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
        scope: "https://manage.devcenter.microsoft.com/.default",
      }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.access_token) {
    throw new Error(`Failed to obtain Entra ID access token: ${res.status} ${JSON.stringify(data)?.slice(0, 500)}`);
  }
  return data.access_token;
}

async function devCenterApi(token, method, urlPath, body) {
  const res = await fetch(`${DEVCENTER_BASE}${urlPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${method} ${urlPath} failed: ${res.status} ${text.slice(0, 2000)}`);
  }
  return text ? JSON.parse(text) : null;
}

async function uploadBundle(fileUploadUrl, bundlePath) {
  const body = fs.readFileSync(bundlePath);
  const res = await fetch(fileUploadUrl.replace(/\+/g, "%2B"), {
    method: "PUT",
    headers: {
      "x-ms-blob-type": "BlockBlob",
      "Content-Type": "application/zip",
      "Content-Length": String(body.length),
    },
    body,
  });
  if (!res.ok) {
    throw new Error(`Package upload failed: ${res.status} ${await res.text().catch(() => "")}`.slice(0, 2000));
  }
}

async function main() {
  if (process.argv[1] !== fileURLToPath(import.meta.url)) return;

  const result = validateConfig(process.env);
  if (!result.valid) {
    console.log(`[msstore] ${result.reason}. Skipping Microsoft Store submission.`);
    return;
  }
  const { tenantId, clientId, clientSecret, productId, tag } = result.config;

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, "package.json"), "utf-8"));
  const msixPath = resolveMsixPath(pkg.version);
  if (!fs.existsSync(msixPath)) {
    throw new Error(`MSIX not found at ${msixPath} — run scripts/pack-msix.mjs first.`);
  }
  const msixName = path.basename(msixPath);
  const bundlePath = `${msixPath}.zip`;

  console.log(`[msstore] Publishing ${msixName} to the Microsoft Store (${tag})...`);

  const token = await getAccessToken({ tenantId, clientId, clientSecret });
  console.log("[msstore] Authenticated with Partner Center.");

  const app = await devCenterApi(token, "GET", `/applications/${encodeURIComponent(productId)}`);
  const appId = pick(app, "id");
  const pendingId = pick(app, "pendingApplicationSubmission")?.id ?? null;
  const lastPublishedId = pick(app, "lastPublishedApplicationSubmission")?.id ?? null;
  if (!appId) throw new Error(`Store product ${productId} not found on this account.`);

  let submission;
  if (pendingId && !lastPublishedId) {
    // First publication still sitting as a draft in Partner Center — reuse it.
    submission = await devCenterApi(token, "GET", `/applications/${appId}/submissions/${pendingId}`);
    if (pick(submission, "status") === "CommitFailed") {
      await devCenterApi(token, "DELETE", `/applications/${appId}/submissions/${pendingId}`);
      submission = await devCenterApi(token, "POST", `/applications/${appId}/submissions?isMinimalResponse=true`);
    }
  } else {
    // Publishing recreates the draft from the last published submission,
    // discarding staged-but-uncommitted changes (same as the CLI).
    if (pendingId) {
      await devCenterApi(token, "DELETE", `/applications/${appId}/submissions/${pendingId}`);
    }
    submission = await devCenterApi(token, "POST", `/applications/${appId}/submissions?isMinimalResponse=true`);
  }
  const submissionId = pick(submission, "id");
  if (!submissionId) throw new Error("Could not create or reuse a draft submission.");

  submission = await devCenterApi(token, "GET", `/applications/${appId}/submissions/${submissionId}`);
  const fileUploadUrl = pick(submission, "fileUploadUrl");
  if (!fileUploadUrl) {
    throw new Error(
      "Draft has no fileUploadUrl (submission was created in Partner Center UI) — delete the draft and retry.",
    );
  }

  replacePackages(submission, msixName);
  await devCenterApi(token, "PUT", `/applications/${appId}/submissions/${submissionId}`, submission);
  console.log(`[msstore] Draft ${submissionId} updated with package ${msixName}.`);

  buildZipBundle(msixPath, bundlePath);
  console.log(`[msstore] Uploading package bundle (${(fs.statSync(bundlePath).size / 1024 / 1024).toFixed(1)} MB)...`);
  await uploadBundle(fileUploadUrl, bundlePath);
  fs.rmSync(bundlePath, { force: true });

  const commit = await devCenterApi(token, "POST", `/applications/${appId}/submissions/${submissionId}/commit`);
  console.log(`[msstore] Submission committed — status: ${pick(commit, "status") ?? "unknown"}.`);

  // Catch immediate validation failures; certification itself takes hours and
  // is tracked in Partner Center, so do not block CI on full completion.
  const deadline = Date.now() + SUBMISSION_POLL_TIMEOUT_MS;
  let status = pick(commit, "status");
  while (status === "CommitStarted" && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, SUBMISSION_POLL_INTERVAL_MS));
    const statusResponse = await devCenterApi(
      token,
      "GET",
      `/applications/${appId}/submissions/${submissionId}/status`,
    );
    status = pick(statusResponse, "status");
    console.log(`[msstore] Submission status: ${status}`);
  }

  if (status === "CommitFailed") {
    throw new Error(`Submission ${submissionId} failed validation — see statusDetails in Partner Center.`);
  }

  console.log(
    `[msstore] Submitted ${tag} to the Microsoft Store (submission ${submissionId}). Certification progress: https://partner.microsoft.com/dashboard/products/${productId}/submissions/${submissionId}`,
  );
}

main().catch((err) => {
  console.error(`[msstore] Submission failed: ${err.message}`);
  process.exit(1);
});
