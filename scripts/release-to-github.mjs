// Uploads all Tauri build artifacts (installers + updater latest.json + sigs)
// to a GitHub release for the given tag. Designed to run in CI (Azure Pipelines).
//
// Env:
//   GITHUB_TOKEN  - PAT with repo scope (set as a secret pipeline variable)
//   RELEASE_TAG   - e.g. v1.0.0 (Azure provides Build.SourceBranchName)
import fs from "node:fs";
import path from "node:path";

const TOKEN = process.env.GITHUB_TOKEN;
const TAG = process.env.RELEASE_TAG;
const fullRepo = process.env.HERMOS_REPO || process.env.GITHUB_REPOSITORY || "WFekik/HermOS-IDE";
const [OWNER, REPO] = fullRepo.split("/");
const API = process.env.GITHUB_API_URL || "https://api.github.com";

if (!TOKEN) {
  console.error("GITHUB_TOKEN is required");
  process.exit(1);
}
if (!TAG) {
  console.error("RELEASE_TAG is required");
  process.exit(1);
}

const headers = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "hermos-release",
};

async function ghJson(method, urlPath, body) {
  const res = await fetch(API + urlPath, {
    method,
    headers: { ...headers, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${urlPath} -> ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function getOrCreateRelease() {
  try {
    return await ghJson("GET", `/repos/${OWNER}/${REPO}/releases/tags/${TAG}`);
  } catch (e) {
    if (!String(e.message).includes("404")) throw e;
    return ghJson("POST", `/repos/${OWNER}/${REPO}/releases`, {
      tag_name: TAG,
      name: `HermOS IDE ${TAG}`,
      body: "### HermOS IDE — Local-First AI Agent Desktop IDE\n100% local, zero telemetry. Model Context Protocol (MCP) & subagent execution.",
      draft: false,
      prerelease: false,
    });
  }
}

function collectBundleFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectBundleFiles(full, out);
    else out.push(full);
  }
  return out;
}

const bundleDirs = [
  path.resolve("src-tauri/target/release/bundle"),
  path.resolve("src-tauri/target/universal-apple-darwin/release/bundle"),
];
const files = bundleDirs.flatMap((d) => collectBundleFiles(d));
if (files.length === 0) {
  console.error(`No build artifacts found in ${bundleDirs.join(" or ")}`);
  process.exit(1);
}

const release = await getOrCreateRelease();
const existing = new Map((release.assets || []).map((a) => [a.name, a.id]));

for (const file of files) {
  const name = path.basename(file);
  if (name.startsWith(".")) {
    console.log(`Skipping dotfile ${name}`);
    continue;
  }
  // Only upload final installers + updater artifacts, skip intermediate resources
  if (name === "HermOS.IDE.desktop" || name.endsWith(".desktop")) {
    console.log(`Skipping desktop file ${name}`);
    continue;
  }
  const isRelevant =
    name.startsWith("HermOS") ||
    name === "latest.json" ||
    name.endsWith(".sig");
  if (!isRelevant) {
    console.log(`Skipping non-artifact ${name}`);
    continue;
  }
  // Handle GitHub normalizing spaces to dots (HermOS IDE -> HermOS.IDE)
  const normalizedDot = name.replace(/ /g, ".");
  const normalizedSpace = name.replace(/\./g, " ");
  const existingId =
    existing.get(name) ?? existing.get(normalizedDot) ?? existing.get(normalizedSpace);
  if (existingId) {
    await ghJson("DELETE", `/repos/${OWNER}/${REPO}/releases/assets/${existingId}`);
    console.log(`Removed stale asset ${name} (was ${existing.has(name) ? name : normalizedDot})`);
  }
  const data = fs.readFileSync(file);
  const url = `https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/octet-stream" },
    body: data,
  });
  if (!res.ok) {
    console.error(`Failed to upload ${name}: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  console.log(`Uploaded ${name} (${(data.length / 1024 / 1024).toFixed(2)} MB)`);
}

/**
 * Construct and upload/update latest.json with all signed release platforms.
 */
async function updateLatestJson(releaseId) {
  const cleanVersion = TAG.replace(/^v/i, "");
  const latest = {
    version: cleanVersion,
    notes: `HermOS IDE ${TAG} release`,
    pub_date: new Date().toISOString(),
    platforms: {},
  };

  const refreshed = await ghJson("GET", `/repos/${OWNER}/${REPO}/releases/${releaseId}`);
  const assets = refreshed.assets || [];

  for (const asset of assets) {
    if (!asset.name.endsWith(".sig")) continue;

    const baseName = asset.name.slice(0, -4);
    const binaryAsset = assets.find((a) => a.name === baseName);
    if (!binaryAsset) continue;

    try {
      const sigRes = await fetch(asset.browser_download_url);
      if (!sigRes.ok) continue;
      const signature = (await sigRes.text()).trim();
      const downloadUrl = binaryAsset.browser_download_url;
      const lower = baseName.toLowerCase();

      if (lower.endsWith(".exe") || lower.includes("x64-setup")) {
        latest.platforms["windows-x86_64"] = { signature, url: downloadUrl };
        latest.platforms["windows-x86_64-nsis"] = { signature, url: downloadUrl };
      } else if (lower.endsWith(".msi") || lower.includes("x64_en-us")) {
        latest.platforms["windows-x86_64-msi"] = { signature, url: downloadUrl };
        if (!latest.platforms["windows-x86_64"]) {
          latest.platforms["windows-x86_64"] = { signature, url: downloadUrl };
        }
      }
      if (lower.includes("darwin") || lower.includes(".app.tar.gz") || lower.includes("universal.dmg")) {
        latest.platforms["darwin-x86_64"] = { signature, url: downloadUrl };
        latest.platforms["darwin-aarch64"] = { signature, url: downloadUrl };
      }
      if (lower.endsWith(".deb") || lower.endsWith(".appimage")) {
        latest.platforms["linux-x86_64"] = { signature, url: downloadUrl };
      }
    } catch (e) {
      console.warn(`Could not read signature for ${asset.name}:`, e.message);
    }
  }

  if (Object.keys(latest.platforms).length > 0) {
    const existingLatest = assets.find((a) => a.name === "latest.json");
    if (existingLatest) {
      await ghJson("DELETE", `/repos/${OWNER}/${REPO}/releases/assets/${existingLatest.id}`);
      console.log("Replacing existing latest.json in release...");
    }

    const latestJsonContent = JSON.stringify(latest, null, 2);
    const uploadUrl = `https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${releaseId}/assets?name=latest.json`;
    const res = await fetch(uploadUrl, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: Buffer.from(latestJsonContent, "utf-8"),
    });

    if (res.ok) {
      console.log("[updater] Published auto-updater manifest latest.json to release!");
    } else {
      console.error("Failed to upload latest.json:", res.status, await res.text());
    }
  }
}

await updateLatestJson(release.id);

console.log(`\nRelease ready: https://github.com/${OWNER}/${REPO}/releases/tag/${TAG}`);
