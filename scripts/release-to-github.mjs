// Uploads all Tauri build artifacts (installers + updater latest.json + sigs)
// to a GitHub release for the given tag. Designed to run in CI (Azure Pipelines).
//
// Env:
//   GITHUB_TOKEN  - PAT with repo scope (set as a secret pipeline variable)
//   RELEASE_TAG   - e.g. v1.0.0 (Azure provides Build.SourceBranchName)
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

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
if (!/^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.test(TAG)) {
  console.error(`Refusing to publish: RELEASE_TAG must look like vX.Y.Z (got ${JSON.stringify(TAG)}). Branch builds must not create releases.`);
  process.exit(1);
}
if (!OWNER || !REPO) {
  console.error(`Invalid repo ${JSON.stringify(fullRepo)} — expected OWNER/REPO.`);
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
  if (!res.ok) throw new Error(`${method} ${urlPath} -> ${res.status}: ${text.slice(0, 500)}`);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${method} ${urlPath} -> ${res.status}: non-JSON response: ${text.slice(0, 500)}`);
  }
}

function getReleaseBody(tag) {
  if (tag === "v1.1.3" || tag === "1.1.3") {
    return `### HermOS IDE ${tag}

Local-first desktop IDE with autonomous subagent execution and MCP support.

#### Highlights
- **Subagent Permissions**: Real-time permission event streaming, non-blocking prompts, and server-authoritative review windows for background workers.
- **Transcript Undo & Rollback**: Safe synchronization between transcript undo and background workers, pausing file operations during restore and rolling back orphaned subagents.
- **Background Command Wake-Up**: Long-running agent commands keep executing in the background while the agent answers; when a command finishes, its output is posted to the conversation and the idle agent is woken automatically, with the running tool card stamped to its final state by command exec id.
- **Honest Tool-Call Labels**: Background-running commands read as "Running…" with a live spinner, and failed commands can never be mislabeled as executed.
- **Lean Directory Listing & Search**: \`list_directory\` returns a flat, 300-entry-capped listing with truncation metadata; heavy build/cache directories (\`.next-build\`, \`coverage\`, \`node_modules\`, \`target\`, …) are capped in workspace trees and skipped by workspace grep and the file watcher, keeping large workspaces responsive.
- **Worker Execution Limits**: Scaled iteration ceiling to 300 cycles for long-running refactoring and autonomous loops.
- **Permission Write Serialization**: Concurrency-safe permission updates via per-user write queues and version validation.
- **Prompt Defense**: Tool-call parsing isolates model reasoning blocks from executable tool invocations.
- **Modernized About Tab**: Cleaned version metadata, removed hardcoded channel indicators, and streamlined external links.

#### Downloads & Verification
Verify installers against SHA256SUMS. Auto-update integrity is covered by minisign signatures.`;
  }
  if (tag === "v1.1.2" || tag === "1.1.2") {
    return `### HermOS IDE ${tag} — Updates That Actually Apply & Fluid Panel Resizing

100% Local-first architecture with zero remote telemetry. Autonomous subagent execution, MCP client, and browser preview.

#### ⚡ What's New in ${tag}
- **⚡ Jank-Free Panel Resizing**: Completely eliminated divider drag lag by removing root state re-renders, suppressing all CSS transitions and animations during active drag, isolating layout with CSS containment, and memoizing sidebar, chat, and panel components.
- **🛡️ WebView2 Cache Immunity**: Navigates the application window to version-tagged document URLs (\`/?v=X.Y.Z\`) and enforces \`Cache-Control: no-store\` so updates apply instantly without Chromium serving stale cached HTML or JavaScript bundles.
- **🧹 Clean Install & Uninstall**: NSIS pre-install purges obsolete static chunks from prior versions, and post-uninstall completely wipes the \`_up_\` bundle directory.
- **🔧 No More "Error Opening File for Writing"**: The installer refused to replace files while the app was running. Auto-update now verifies every locked file is free BEFORE the installer spawns — and the installer itself asks you to close the app (Retry/Cancel) instead of failing mid-copy.
- **🚪 Quit-First Guidance, No Reinstall Needed**: If files are still in use, you get the exact locked filenames plus a one-click Quit button. Close fully (all windows), retry — an uninstall was never required.
- **🔍 Lock Detection That Holds Up**: Pre-install probe covers the triple-suffixed sidecar binary, retries past transient antivirus/indexer holds, and tells apart real locks from disk-full errors. Orphaned sidecars are cleaned up; a second open window vetoes the kill so nothing dies silently.
- **🌍 Fully Translated**: Every new string in all 9 languages (English, Spanish, French, German, Chinese, Japanese, Arabic RTL, Russian, Portuguese).
- **✅ Verified End-to-End**: 1748 tests passed (102 files), typecheck clean, cargo check clean, production build green (Azure test gate).

#### 📦 Downloads & Verification
Verify installers against SHA256SUMS. Auto-update integrity is covered by minisign signatures. Download the installer for your platform below.`;
  }
  if (tag === "v1.1.1" || tag === "1.1.1") {
    return `### HermOS IDE ${tag} — Smarter Chat, Honest Agent & Full Arabic UX

100% Local-first architecture with zero remote telemetry. Autonomous subagent execution, MCP client, and browser preview.

#### ⚡ What's New in ${tag}
- **💬 Agent Turns That Collapse**: Completed runs fold into a "Worked for 3m 52s · 9 steps" row — the final answer stays visible, scrolling stays cheap (collapsed turns unmount).
- **🗺️ Message Navigator**: A dot rail on the chat edge jumps between your messages with hover previews.
- **🌳 Trees That Stay Vertical**: The agent is instructed to emit fenced tree blocks; the renderer rescues smeared blobs, unwraps misplaced fences, and preserves indentation end to end.
- **🌍 Agent Speaks Your Language**: Replies follow your prompt's language (Arabic, Russian, Chinese, Japanese, French, German, Spanish, Portuguese) with UI-language fallback — no more English-by-default.
- **🛡️ Reliability Fixes**: Parallel runs get titled (no more "New conversation" everywhere), Stop actually kills the server process, renames validate + offer Replace, deletes close their tabs, binary files can't be clobbered.
- **🌍 Fully Translated**: Every new string in all 9 languages (English, Spanish, French, German, Chinese, Japanese, Arabic RTL, Russian, Portuguese) — including the new Problems tab, turn headers, and navigator.
- **🔒 Release Integrity**: Every release now ships SHA256SUMS + sbom.json alongside the minisign signatures.
- **✅ Verified End-to-End**: typecheck clean, eslint clean, full test suite green, production build green (Azure test gate).

#### 📦 Downloads & Verification
Verify installers against SHA256SUMS. Auto-update integrity is covered by minisign signatures. Download the installer for your platform below.`;
  }
  if (tag === "v1.1.0" || tag === "1.1.0") {
    return `### HermOS IDE ${tag} — Instant Startup, Reliable Undo & BYOK Providers

100% Local-first architecture with zero remote telemetry. Autonomous subagent execution, MCP client, and browser preview.

#### ⚡ What's New in ${tag}
- **🚀 Instant Startup**: Window paints immediately with a splash while the backend boots in the background (cached port, no slow system sweeps, warmup after first paint).
- **🛠️ Cold-Boot Fix**: Stripped Windows verbatim-path prefixes from the spawned server path (Node's loader fatals on them), excluded CI droppings from the bundle, and the launcher now logs the exact bundle path on failure.
- **🔄 Update Reliability**: Fixed Windows \`_up\` folder-lock failures (sidecar runs outside the install dir, verified shutdown, retried installs) plus a persistent titlebar update button with progress — no more vanishing toasts.
- **↩️ Undo You Can Trust**: Undo failures, duplicates and silent partial restores fixed (truth-propagating restore, per-conversation lock, transcript tombstones); new Confirm Undo dialog lists every file with inverted +/− stats and the server re-verifies before applying.
- **🔌 Custom Providers (BYOK) End-to-End**: Add any OpenAI-compatible endpoint and it saves, lists models, and appears in the chat model picker; transient fetch failures can no longer wipe stored models.
- **🎨 Theme & Diff Polish**: Jank-free live color/font dragging (rAF preview + debounced persist), pro editor-style diffs with syntax colors, vertical tree rendering for agent output.
- **🌍 Fully Translated**: Every new string in all 9 languages (English, Spanish, French, German, Chinese, Japanese, Arabic RTL, Russian, Portuguese).
- **✅ Verified End-to-End**: typecheck clean, eslint clean, full test suite green, cargo check clean, production build green (Azure test gate).

#### 📦 Downloads & Verification
All installer binaries and signatures are signed with the HermOS Tauri release key. Download the installer for your platform below.`;
  }
  if (tag === "v1.0.9" || tag === "1.0.9") {
    return `### HermOS IDE ${tag} — Hardening, Performance Caps & Visual Polish

100% Local-first architecture with zero remote telemetry. Autonomous subagent execution, MCP client, and browser preview.

#### 🔒 What's New in ${tag}
- **🛡️ Workspace Confinement**: Strict workspace-name validation at creation, traversal-safe resolution for existing workspaces, safeUserId-scoped storage roots, and absolute-path rootDir checks.
- **🔐 API & SSRF Hardening**: Fail-closed loopback binding in production, anon-keyed rate limiting, dynamic SSRF policy evaluation, TTL-bounded reasoning memory, and UUID todo IDs with server-side caps.
- **⚡ Performance Caps**: Bounded transcripts with pagination, capped command output with backpressure-safe progress, 32-wide tree stat limiting, grep time/byte budgets, cached provider data, and visibility-aware background polling.
- **🎨 Visual & Accessibility**: Phone layout support, theme-token consistency, logical-property RTL, tree/minimap keyboard support, themed toasts, and light/dark crash screens with bounded retry.
- **🔌 Skills & Agent Freedom**: Fixed Skills panel data feed, script file creation unblocked, and unfiltered directory listings across tree, grep, glob, and list_directory.
- **✅ Verified End-to-End**: typecheck clean, eslint clean, 1617 tests passed (91 files), cargo check clean, production build green (Azure test gate).

#### 📦 Downloads & Verification
All installer binaries and signatures are signed with the HermOS Tauri release key. Download the installer for your platform below.`;
  }
  if (tag === "v1.0.8" || tag === "1.0.8") {
    return `### HermOS IDE ${tag} — Security Hardening & Agent Reliability

100% Local-first architecture with zero remote telemetry. Autonomous subagent execution, MCP client, and browser preview.

#### 🔒 What's New in ${tag}
- **🛡️ Provider Fetch SSRF Hardening**: Per-hop URL validation with redirect cap, cross-origin credential stripping, and safe method handling on redirects — applied to provider chat, model listing, title generation, inline edit, background refresh, and plugin API fetch paths.
- **🔐 Outside-Workspace Command Gate**: Explicit one-shot user approval with full audit trail; interactive terminal stays workspace-confined.
- **🤖 Agent Reliability**: Sequential tool execution, loop detection with bounded cost, symlink-aware path sandbox, and newest-first image budget with text-only fallback.
- **🌍 9-Language UI**: English, Spanish, French, German, Chinese, Japanese, Arabic (RTL), Russian, and Portuguese with lazy loading and translated settings.
- **🔌 Provider Updates**: OpenCode Zen Responses bridge, capability-driven vision detection, and honest connectivity checks.
- **✅ Verified End-to-End**: typecheck clean, eslint clean, 1623 tests passed (91 files), cargo check clean, production build green (Azure test gate).

#### 📦 Downloads & Verification
All installer binaries and signatures are signed with the HermOS Tauri release key. Download the installer for your platform below.`;
  }
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
- **💻 Windows Update Reliability**: Test code-signing is paused until the official open-source certificate lands (it was invalidating updater signatures), so Windows installers ship with pristine build signatures and in-app updates verify cleanly again.
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
 * First-download integrity: minisign .sig files cover auto-update, but a
 * fresh download needs hash verification against a tamper-evident manifest.
 * SHA256SUMS lists every uploaded bundle file (BSD-style `SHA256 (name) =
 * hex`); sbom.json is a direct-dependency manifest (npm + cargo, versions
 * pinned from lockfiles — not a full transitive SBOM, documented as such).
 */
async function uploadTextAsset(releaseId, existingByName, name, content, contentType) {
  const stale = existingByName.get(name);
  if (stale) {
    await ghJson("DELETE", `/repos/${OWNER}/${REPO}/releases/assets/${stale}`);
    console.log(`Removed stale asset ${name}`);
  }
  const url = `https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { ...headers, "Content-Type": contentType },
    body: Buffer.from(content, "utf-8"),
  });
  if (!res.ok) throw new Error(`Failed to upload ${name}: ${res.status} ${await res.text()}`);
  console.log(`Uploaded ${name}`);
}

{
  // Streamed hashing: bundle installers can exceed available RAM, so hash
  // chunk-by-chunk instead of readFileSync.
  const lines = [];
  for (const file of files) {
    const name = path.basename(file);
    if (name.startsWith(".")) continue;
    const hash = await new Promise((resolve, reject) => {
      const h = crypto.createHash("sha256");
      const stream = fs.createReadStream(file);
      stream.on("data", (chunk) => h.update(chunk));
      stream.on("end", () => resolve(h.digest("hex")));
      stream.on("error", reject);
    });
    lines.push(`SHA256 (${name}) = ${hash}`);
  }
  lines.sort();
  await uploadTextAsset(release.id, existing, "SHA256SUMS", lines.join("\n") + "\n", "text/plain");
}

{
  const sbom = { version: TAG, generatedAt: new Date().toISOString(), npm: {}, cargo: {} };
  try {
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf-8"));
    for (const scope of ["dependencies", "devDependencies"]) {
      for (const [dep, ver] of Object.entries(pkg[scope] ?? {})) {
        sbom.npm[`${scope}:${dep}`] = String(ver);
      }
    }
  } catch { /* manifest is best-effort */ }
  try {
    const lock = fs.readFileSync("src-tauri/Cargo.lock", "utf-8");
    for (const m of lock.matchAll(/\[\[package\]\]\r?\nname = "([^"]+)"\r?\nversion = "([^"]+)"/g)) {
      sbom.cargo[m[1]] = m[2];
    }
  } catch { /* manifest is best-effort */ }
  sbom.note = "Direct-dependency manifest (npm ranges from package.json, cargo pins from Cargo.lock). Not a full transitive CycloneDX SBOM — see THIRD-PARTY-NOTICE.md.";
  await uploadTextAsset(release.id, existing, "sbom.json", JSON.stringify(sbom, null, 2) + "\n", "application/json");
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
