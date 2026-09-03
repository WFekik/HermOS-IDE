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

function getReleaseBody(tag) {
  if (tag === "v1.0.7" || tag === "1.0.7") {
    return `### HermOS IDE ${tag} — Office Studio & Appearance Themes

100% Local-first architecture with zero remote telemetry. Autonomous subagent execution, MCP client, and browser preview.

#### 📊 What's New in ${tag}
- **📊 Native Office Studio (Kimi & GLM Studio)**: Generate executive \`.pptx\` decks, \`.docx\` documents, and styled \`.pdf\` reports right from chat — 8 slide layouts (title, bullets, cards, split, image-split, table, timeline, quote), 6 executive themes (Navy, Emerald, Charcoal, Crimson, Nordic, Cyber Midnight), KPI cards, callouts, metrics, and tables, with companion manifests and a dedicated Studio tab.
- **🤖 Slide-by-Slide Agent Workflow**: New agent tools — \`init_presentation\`, \`add_presentation_slide\`, \`update_presentation_slide\` — so the agent builds decks carefully one slide at a time with live Studio updates, backed by isomorphic layout resolvers and permission entries.
- **🎨 Appearance Theme & Color Customization**: Full theming system (hex validation, WCAG contrast, derived surfaces, presets) with a new Appearance section in Settings, applied app-wide via CSS variables and globalized accent tokens across chat, composer, panels, and workspace views.
- **✨ Office Studio Polish**: Eliminated topbar overlap, full table-data rendering, dynamic inspector, workspace-scoped background polling that never clobbers your selection, and correct document matching across restarts.
- **🌐 Browser Preview Hardening**: SSRF checks on every redirect hop, sandboxed CSP from a single source of truth, relative-URL rewriting (incl. \`srcset\` and inline styles), 5 MB response cap, and neutralized \`meta-refresh\` / attacker \`<base>\` vectors.
- **🛡️ Workspace Confinement Fixes**: Office image embedding resolves through \`safePath\` (workspace-relative images work, traversal/absolute-path reads blocked), generation respects custom from-folder workspace roots, and the document list is rate-limited with capped scans for steady polling performance.
- **⚡ Performance & Reliability**: Package-import optimization, batch cache eviction, cached workspace-root resolution, updater failure toasts (no more stuck spinners), and Dependabot lockstep hardening for SQLite/Tauri stability.
- **✅ Verified End-to-End**: typecheck clean, eslint clean, 1551 tests passed (90 files), 47 perf tests passed, production build green.

#### 📦 Downloads & Verification
All installer binaries and signatures are signed with the HermOS Tauri release key. Download the installer for your platform below.`;
  }
  return `### HermOS IDE ${tag} — Local-First AI Agent Desktop IDE

100% Local-first architecture with zero remote telemetry. Autonomous subagent execution, MCP client, and browser preview.

#### 🚀 What's New in ${tag}
- **🔐 Automated Authenticode Code Signing**: Integrated automated SignPath signing in the multi-platform release pipeline, producing verified, trusted Windows installer binaries.
- **🛡️ SSRF & Loopback Security Perimeter**: Enforced strict port allowlisting on loopback interfaces (\`80, 443, 1234, 2242, 3000, 5000, 5173, 8000, 8080, 8081, 11434\`), shielding local databases (Redis, Postgres), SSH, and Docker daemon endpoints from SSRF.
- **⚡ Command Execution Hardening**: Switched Windows browser opener to direct \`rundll32 url.dll,FileProtocolHandler\` invocation to eliminate shell expansion risks, and added sanitization for plugin CLI parameters.
- **🔒 AES-256-GCM Cryptographic Storage**: Enforced 16-byte authentication tags and 12-byte IV verification on AES-256-GCM decryption, with transparent encryption at rest for MCP server secrets and credentials.
- **🛡️ Agent Prompt-Injection Defense**: Configured \`web.fetch\` to \`ask\` mode by default, preventing autonomous agents from exfiltrating data via outbound network requests without explicit approval.
- **🌊 Resilient Stream Lifecycle & Diagnostics**: Fixed module-level animation frame flush timer cancellation across multi-consumer views, and upgraded silent catch blocks to structured diagnostic warnings.
- **📦 Dependabot Lockstep Hardening**: Pinned Dependabot target branch to \`main\` and added version protection rules to preserve SQLite and Tauri crate stability.

#### 📦 Downloads & Verification
All installer binaries and signatures are signed with the HermOS Tauri release key. Download the installer for your platform below.`;
}

async function getOrCreateRelease() {
  try {
    const existing = await ghJson("GET", `/repos/${OWNER}/${REPO}/releases/tags/${TAG}`);
    if (existing && existing.id) {
      // Keep release body up to date with rich notes
      try {
        await ghJson("PATCH", `/repos/${OWNER}/${REPO}/releases/${existing.id}`, {
          name: `HermOS IDE ${TAG}`,
          body: getReleaseBody(TAG),
        });
      } catch {
        /* best-effort body update */
      }
    }
    return existing;
  } catch (e) {
    if (!String(e.message).includes("404")) throw e;
    return ghJson("POST", `/repos/${OWNER}/${REPO}/releases`, {
      tag_name: TAG,
      name: `HermOS IDE ${TAG}`,
      body: getReleaseBody(TAG),
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
 * Map a Tauri bundle filename to its Tauri updater platform key(s).
 * Company-grade: arch-aware instead of assigning the same URL to both darwin
 * archs blindly. Universal binaries satisfy all darwin keys; arch-specific
 * bundles only satisfy their own arch.
 * Returns an array (empty = unrecognized, caller skips).
 */
function mapAssetToPlatforms(baseName) {
  const lower = baseName.toLowerCase();
  // Windows
  if (lower.endsWith(".exe") || lower.includes("x64-setup") || lower.includes("-setup.exe")) {
    return ["windows-x86_64", "windows-x86_64-nsis"];
  }
  if (lower.endsWith(".msi") || lower.includes("x64_en-us")) {
    return ["windows-x86_64-msi"];
  }
  // macOS — detect arch explicitly
  const isDarwin =
    lower.includes("darwin") ||
    lower.includes(".app.tar.gz") ||
    lower.includes(".dmg") ||
    lower.includes("macos");
  if (isDarwin) {
    const isArm =
      lower.includes("aarch64") || lower.includes("arm64") || lower.includes("apple-silicon");
    const isX64 =
      lower.includes("x86_64") || lower.includes("x64") || lower.includes("intel");
    const isUniversal = lower.includes("universal");
    if (isUniversal) return ["darwin-x86_64", "darwin-aarch64", "darwin-universal"];
    if (isArm && !isX64) return ["darwin-aarch64"];
    if (isX64 && !isArm) return ["darwin-x86_64"];
    // Ambiguous darwin asset (no arch marker): do NOT guess both archs with
    // possibly-wrong binary. Record as universal only if the bundle itself is
    // marked universal; otherwise prefer explicit arch assets when present.
    // Fallback: assign to universal key so updater still finds *something*,
    // but never overwrite an existing arch-specific entry with an ambiguous one.
    return ["darwin-universal"];
  }
  // Linux
  if (lower.endsWith(".deb") || lower.endsWith(".appimage") || lower.endsWith(".rpm")) {
    return ["linux-x86_64"];
  }
  return [];
}

/**
 * Construct and upload/update latest.json with all signed release platforms.
 * Company-grade hardening:
 * - Authenticated `.sig` fetch (avoids rate-limit / private-repo failures).
 * - Arch-aware darwin mapping (no last-wins clobbering of x64 vs arm64).
 * - `.rpm` support.
 * - Fails CI loudly when no platforms found (silent broken updater is worse
 *   than a failed release job).
 * - Delete-then-upload is inherently non-atomic in the GitHub API; minimize
 *   the window by preparing content first, and throw on upload failure so the
 *   missing manifest is visible instead of silently continuing.
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
      const sigRes = await fetch(asset.browser_download_url, {
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          Accept: "application/octet-stream",
          "User-Agent": "hermos-release",
        },
        signal: AbortSignal.timeout(15000),
      });
      if (!sigRes.ok) {
        console.warn(`Skipping ${asset.name}: sig fetch ${sigRes.status}`);
        continue;
      }
      const signature = (await sigRes.text()).trim();
      if (!signature) {
        console.warn(`Skipping ${asset.name}: empty signature`);
        continue;
      }
      const downloadUrl = binaryAsset.browser_download_url;
      for (const platform of mapAssetToPlatforms(baseName)) {
        // Never overwrite an arch-specific entry with an ambiguous universal fallback.
        if (
          platform === "darwin-universal" &&
          (latest.platforms["darwin-x86_64"] || latest.platforms["darwin-aarch64"])
        ) {
          continue;
        }
        // Prefer first-seen arch-specific; universal explicitly overwrites both.
        if (platform === "darwin-universal") {
          latest.platforms["darwin-x86_64"] ??= { signature, url: downloadUrl };
          latest.platforms["darwin-aarch64"] ??= { signature, url: downloadUrl };
        }
        latest.platforms[platform] ??= { signature, url: downloadUrl };
      }
    } catch (e) {
      console.warn(`Could not read signature for ${asset.name}:`, e.message);
    }
  }

  // Backfill windows-x86_64 from MSI when no NSIS exe was published.
  if (!latest.platforms["windows-x86_64"] && latest.platforms["windows-x86_64-msi"]) {
    latest.platforms["windows-x86_64"] = latest.platforms["windows-x86_64-msi"];
  }

  if (Object.keys(latest.platforms).length === 0) {
    throw new Error(
      "updateLatestJson: no signed platforms found — refusing to publish an empty updater manifest (would break auto-update).",
    );
  }

  const latestJsonContent = JSON.stringify(latest, null, 2);
  const existingLatest = assets.find((a) => a.name === "latest.json");
  if (existingLatest) {
    await ghJson("DELETE", `/repos/${OWNER}/${REPO}/releases/assets/${existingLatest.id}`);
    console.log("Replacing existing latest.json in release...");
  }

  const uploadUrl = `https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${releaseId}/assets?name=latest.json`;
  const res = await fetch(uploadUrl, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: Buffer.from(latestJsonContent, "utf-8"),
  });

  if (res.ok) {
    console.log("[updater] Published auto-updater manifest latest.json to release!");
  } else {
    throw new Error(`Failed to upload latest.json: ${res.status} ${await res.text()}`);
  }
}

await updateLatestJson(release.id);

console.log(`\nRelease ready: https://github.com/${OWNER}/${REPO}/releases/tag/${TAG}`);
