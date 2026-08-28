import { NextRequest, NextResponse } from "next/server";
import { existsSync, statSync, readdirSync } from "fs";
import { readFile } from "fs/promises";
import path from "path";
import { enforceLoopbackRequest } from "@/app/api/_lib/helpers";
import { getAppVersion, getAppRepo } from "@/lib/version";

export const dynamic = "force-dynamic";

const PLATFORM_EXTS: Record<string, string[]> = {
  windows: [".msi", ".exe"],
  macos: [".dmg"],
  linux: [".deb", ".AppImage", ".appimage", ".rpm"],
};

const EXT_CONTENT_TYPES: Record<string, string> = {
  ".msi": "application/x-msi",
  ".exe": "application/octet-stream",
  ".dmg": "application/x-apple-diskimage",
  ".deb": "application/vnd.debian.binary-package",
  ".AppImage": "application/octet-stream",
  ".appimage": "application/octet-stream",
  ".rpm": "application/x-rpm",
};

function contentTypeFor(fileName: string): string {
  const lower = fileName.toLowerCase();
  for (const [ext, ct] of Object.entries(EXT_CONTENT_TYPES)) {
    if (lower.endsWith(ext.toLowerCase())) return ct;
  }
  return "application/octet-stream";
}

function getGithubAssets(): Record<string, string> {
  const repo = getAppRepo();
  const version = getAppVersion();
  return {
    windows: `https://github.com/${repo}/releases/latest/download/HermOS%20IDE_${version}_x64_en-US.msi`,
    macos: `https://github.com/${repo}/releases/latest/download/HermOS%20IDE_${version}_universal.dmg`,
    linux: `https://github.com/${repo}/releases/latest/download/HermOS%20IDE_${version}_amd64.deb`,
  };
}

function getGithubReleasesPage(): string {
  return `https://github.com/${getAppRepo()}/releases/latest`;
}

// Tauri names release assets after `productName` ("HermOS IDE_1.0.0_x64_en-US.msi"),
// which the hardcoded URLs above can't know reliably — resolve the real asset
// names from the GitHub latest-release API (public, no auth) with a short TTL.
const ASSET_CACHE_TTL_MS = 10 * 60 * 1000;
let cachedAssets: { byPlatform: Record<string, string>; at: number } | null = null;

async function githubAssetUrl(platform: string): Promise<string | null> {
  const now = Date.now();
  if (!cachedAssets || now - cachedAssets.at > ASSET_CACHE_TTL_MS) {
    const byPlatform: Record<string, string> = {};
    const repo = getAppRepo();
    try {
      const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": "hermos-ide" },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        const json = (await res.json()) as { assets?: Array<{ browser_download_url?: unknown }> };
        const urls = (json.assets ?? [])
          .map((a) => (typeof a.browser_download_url === "string" ? a.browser_download_url : ""))
          .filter(Boolean);
        for (const p of Object.keys(PLATFORM_EXTS)) {
          byPlatform[p] =
            urls.find((u) => PLATFORM_EXTS[p].some((e) => u.toLowerCase().endsWith(e.toLowerCase()))) ??
            "";
        }
      }
    } catch {
      // API unreachable — fall back to the dynamic fallback URLs below.
    }
    cachedAssets = { byPlatform, at: now };
  }
  return cachedAssets.byPlatform[platform] || null;
}

/**
 * Scan public/installers/ for a locally-bundled installer. Tolerant matching:
 *   1. `hermos-ide-setup.<ext>` (legacy name)
 *   2. `hermos-ide_<version>_*.<ext>` (Tauri release naming, exact version)
 *   3. `hermos-ide_*.<ext>` (any Tauri-style build — version may drift from
 *      the bundled package.json for nightly bundles)
 * Returns the matched file name or null.
 */
function findLocalInstaller(platform: string): { fileName: string; contentType: string } | null {
  const exts = PLATFORM_EXTS[platform];
  if (!exts) return null;
  const dir = path.join(process.cwd(), "public", "installers");
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return null; // directory absent — no local installers
  }
  const byExt = (ext: string): string[] =>
    entries.filter((e) => e.toLowerCase().endsWith(ext.toLowerCase()));
  for (const ext of exts) {
    const setup = byExt(ext).find((e) => e.toLowerCase() === `hermos-ide-setup${ext.toLowerCase()}`);
    if (setup) return { fileName: setup, contentType: contentTypeFor(setup) };
  }
  // Tauri v2 names bundles after productName: "HermOS IDE_1.0.0_x64_en-US.msi"
  // (spaces preserved). Match both canonical and lowercase forms.
  const ver = getAppVersion();
  const prefixes = [`hermos-ide_${ver}_`.toLowerCase(), `hermos ide_${ver}_`.toLowerCase()];
  for (const ext of exts) {
    const exact = byExt(ext).find((e) => {
      const lower = e.toLowerCase();
      return prefixes.some((p) => lower.startsWith(p));
    });
    if (exact) return { fileName: exact, contentType: contentTypeFor(exact) };
  }
  for (const ext of exts) {
    const any = byExt(ext).find((e) => {
      const lower = e.toLowerCase();
      return lower.startsWith("hermos-ide_") || lower.startsWith("hermos ide_");
    });
    if (any) return { fileName: any, contentType: contentTypeFor(any) };
  }
  return null;
}

/**
 * GET /api/download/[platform]
 * Handles direct download for the native installers.
 * If the installer is placed in the local server public folder, it serves it directly.
 * Otherwise, it redirects to the GitHub release binary asset.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ platform: string }> }
): Promise<Response> {
  const blocked = enforceLoopbackRequest(req);
  if (blocked) return blocked;

  const { platform } = await params;

  if (!PLATFORM_EXTS[platform]) {
    return NextResponse.json({ error: "Unsupported platform" }, { status: 400 });
  }

  // Check if the file is pre-bundled locally inside public/installers/
  const local = findLocalInstaller(platform);
  if (local) {
    const localFilePath = path.join(process.cwd(), "public", "installers", local.fileName);
    if (existsSync(localFilePath)) {
      try {
        const stat = statSync(localFilePath);
        const fileBuffer = await readFile(localFilePath);
        return new Response(fileBuffer, {
          status: 200,
          headers: {
            "Content-Type": local.contentType,
            "Content-Disposition": `attachment; filename="${local.fileName}"`,
            "Content-Length": stat.size.toString(),
          },
        });
      } catch (e) {
        console.error("Local file download error:", e);
      }
    }
  }

  // Fallback: try the GitHub API for real asset names; on failure use
  // dot-normalized fallback URLs, finally degrade to the Releases page.
  const assetUrl = await githubAssetUrl(platform);
  const target = assetUrl || getGithubAssets()[platform] || getGithubReleasesPage();
  return NextResponse.redirect(target, 307);
}