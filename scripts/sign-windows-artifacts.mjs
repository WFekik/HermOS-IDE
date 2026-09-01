// Automated Windows binary signing via SignPath REST API for CI release pipelines.
// Replaces the un-signed bundle .exe and .msi files with trusted Authenticode signed versions.
//
// Required Environment Variables (set in Azure Pipelines / GitHub Secrets):
//   SIGNPATH_API_TOKEN        - API token generated from SignPath (Organization Settings -> API Tokens)
//   SIGNPATH_ORGANIZATION_ID  - SignPath Organization ID (default: 1390df68-6835-4914-86af-c378938047b4)
//   SIGNPATH_PROJECT_SLUG     - Project slug (default: HermOS-IDE)
//   SIGNPATH_POLICY_SLUG      - Signing policy slug (default: Release_signing or release-signing)

import fs from "node:fs";
import path from "node:path";

const API_TOKEN = process.env.SIGNPATH_API_TOKEN;
const ORG_ID = process.env.SIGNPATH_ORGANIZATION_ID || "1390df68-6835-4914-86af-c378938047b4";
const PROJECT_SLUG = process.env.SIGNPATH_PROJECT_SLUG || "HermOS-IDE";
const POLICY_SLUG = process.env.SIGNPATH_POLICY_SLUG || "Release_signing";
const ARTIFACT_CONFIG_SLUG = process.env.SIGNPATH_ARTIFACT_CONFIG_SLUG || "initial-version";

const SIGNPATH_BASE_URL = "https://app.signpath.io/api/v1";

if (!API_TOKEN) {
  console.log("ℹ️ SIGNPATH_API_TOKEN not configured — skipping automated Windows code signing.");
  console.log("  To enable automated signing, add SIGNPATH_API_TOKEN to your pipeline secrets.");
  process.exit(0);
}

const bundleDirs = [
  path.resolve("src-tauri/target/release/bundle/nsis"),
  path.resolve("src-tauri/target/release/bundle/msi"),
];

function findSignableFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".exe") || f.endsWith(".msi"))
    .map((f) => path.join(dir, f));
}

async function signFile(filePath) {
  const fileName = path.basename(filePath);
  console.log(`\n🔐 Submitting ${fileName} to SignPath for automated signing...`);

  const fileBuffer = fs.readFileSync(filePath);
  const blob = new Blob([fileBuffer]);

  const formData = new FormData();
  formData.append("ProjectId", PROJECT_SLUG);
  formData.append("SigningPolicyId", POLICY_SLUG);
  formData.append("ArtifactConfigurationId", ARTIFACT_CONFIG_SLUG);
  formData.append("Description", `Automated release build for ${fileName}`);
  formData.append("Artifact", blob, fileName);

  const submitRes = await fetch(`${SIGNPATH_BASE_URL}/${ORG_ID}/signing-requests`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      Accept: "application/json",
    },
    body: formData,
  });

  if (!submitRes.ok) {
    const errText = await submitRes.text();
    console.error(`❌ SignPath submission failed for ${fileName} (${submitRes.status}):`, errText);
    throw new Error(`SignPath submission failed: ${errText}`);
  }

  const location = submitRes.headers.get("Location");
  const requestData = await submitRes.json().catch(() => null);
  const requestId = requestData?.signingRequestId || requestData?.id || (location ? location.split("/").pop() : null);

  if (!requestId) {
    console.error("❌ Could not determine SignPath signing request ID.");
    return false;
  }

  console.log(`⏳ Signing request created (ID: ${requestId}). Polling for signed artifact...`);

  const startTime = Date.now();
  const maxWaitMs = 10 * 60 * 1000; // 10 minutes timeout

  while (Date.now() - startTime < maxWaitMs) {
    await new Promise((r) => setTimeout(r, 6000)); // Poll every 6 seconds

    const statusRes = await fetch(`${SIGNPATH_BASE_URL}/${ORG_ID}/signing-requests/${requestId}`, {
      headers: {
        Authorization: `Bearer ${API_TOKEN}`,
        Accept: "application/json",
      },
    });

    if (!statusRes.ok) {
      console.warn(`  Warning: Poll request returned ${statusRes.status}, retrying...`);
      continue;
    }

    const statusData = await statusRes.json();
    const status = statusData.status;

    console.log(`  Current signing status: ${status}`);

    if (status === "Completed") {
      console.log(`⬇️ Downloading signed binary for ${fileName}...`);
      const downloadRes = await fetch(
        `${SIGNPATH_BASE_URL}/${ORG_ID}/signing-requests/${requestId}/signed-artifact`,
        {
          headers: {
            Authorization: `Bearer ${API_TOKEN}`,
          },
        }
      );

      if (!downloadRes.ok) {
        throw new Error(`Failed to download signed artifact (${downloadRes.status})`);
      }

      const signedBytes = await downloadRes.arrayBuffer();
      fs.writeFileSync(filePath, Buffer.from(signedBytes));
      console.log(`✅ Successfully replaced ${fileName} with trusted signed version!`);
      return true;
    }

    if (status === "Failed" || status === "Denied" || status === "Canceled") {
      throw new Error(`SignPath signing failed with status: ${status}`);
    }
  }

  throw new Error(`SignPath signing timed out after 10 minutes for ${fileName}`);
}

async function main() {
  const filesToSign = bundleDirs.flatMap((d) => findSignableFiles(d));

  if (filesToSign.length === 0) {
    console.log("ℹ️ No Windows .exe / .msi installer files found in bundle directory to sign.");
    return;
  }

  console.log(`Found ${filesToSign.length} Windows installer binary to sign:`, filesToSign);

  for (const file of filesToSign) {
    await signFile(file);
  }

  console.log("\n🎉 All Windows release binaries successfully signed with Authenticode certificate!");
}

main().catch((err) => {
  console.error("❌ Code signing step encountered an error:", err.message);
  process.exit(1);
});
