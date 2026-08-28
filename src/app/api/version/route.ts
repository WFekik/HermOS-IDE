import { NextRequest } from "next/server";
import { getAppInfo, isNewerVersion } from "@/lib/version";
import { ok, enforceLoopbackRequest, withErrorHandler } from "@/app/api/_lib/helpers";
import { withRateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

interface GitHubReleaseDTO {
  tag_name?: string;
  name?: string;
  body?: string;
  published_at?: string;
  html_url?: string;
}

/**
 * GET /api/version
 * Returns comprehensive HermOS version, channel, build metadata, and update status.
 * Rate-limited at 30 req/min/IP.
 */
export const GET = withErrorHandler(async (req: NextRequest) => {
  const blocked = enforceLoopbackRequest(req);
  if (blocked) return blocked;

  const limited = await withRateLimit(req, "version-check", {
    capacity: 30,
    refillPerSec: 30 / 60,
  });
  if (limited) return limited;

  const appInfo = getAppInfo();
  const checkRemote = req.nextUrl.searchParams.get("checkRemote") === "true";

  let updateInfo = null;

  if (checkRemote) {
    try {
      const res = await fetch(`${appInfo.releasesApiUrl}/latest`, {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "hermos-ide",
        },
        signal: AbortSignal.timeout(6000),
      });

      if (res.ok) {
        const release = (await res.json()) as GitHubReleaseDTO;
        const latestTag = release.tag_name || "";
        const cleanLatest = latestTag.replace(/^v/i, "");
        const hasUpdate = isNewerVersion(appInfo.version, cleanLatest);

        updateInfo = {
          latestVersion: cleanLatest,
          hasUpdate,
          releaseName: release.name || latestTag,
          releaseNotes: release.body || "",
          publishedAt: release.published_at,
          releaseUrl: release.html_url || `${appInfo.releasesUrl}/latest`,
        };
      }
    } catch {
      // Offline or release feed unreachable — return standard appInfo without blocking
    }
  }

  return ok({
    ...appInfo,
    update: updateInfo,
  });
});
