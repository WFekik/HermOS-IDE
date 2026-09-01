import { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { withRateLimit } from "@/lib/rate-limit";
import { withErrorHandler, parseJson, ok, apiError, unauthorized } from "@/app/api/_lib/helpers";
import { spawn } from "child_process";
import os from "os";

export const dynamic = "force-dynamic";

// Allow up to 20 opens per minute with burst of 10
const OPEN_RATE = { capacity: 10, refillPerSec: 0.5 };

export const POST = withErrorHandler(async (req: NextRequest) => {
  let user;
  try {
    user = await requireUser();
  } catch {
    return unauthorized();
  }

  const limited = await withRateLimit(req, `open-url:${user.id}`, OPEN_RATE);
  if (limited) return limited;

  const body = await parseJson<{ url?: unknown }>(req);
  if (!body || typeof body.url !== "string") {
    return apiError("Missing or invalid 'url' parameter.", 400);
  }

  const rawUrl = body.url.trim();

  // Validate URL scheme and format strictly
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    return apiError("Invalid URL format.", 400);
  }

  const protocol = parsedUrl.protocol.toLowerCase();
  if (protocol !== "http:" && protocol !== "https:" && protocol !== "mailto:") {
    return apiError("Disallowed URL scheme. Only http, https, and mailto are supported.", 400);
  }

  // Ensure no newline or null bytes
  if (/[\r\n\0]/.test(rawUrl)) {
    return apiError("Malformed URL containing control characters.", 400);
  }

  const platform = os.platform();
  const safeTarget = parsedUrl.toString();

  try {
    if (platform === "win32") {
      // Windows: use rundll32 FileProtocolHandler to launch default browser securely
      // without invoking cmd.exe shell or interpreting command separators (&, |, etc.)
      spawn("rundll32.exe", ["url.dll,FileProtocolHandler", safeTarget], {
        windowsHide: true,
        detached: true,
        stdio: "ignore",
      }).unref();
    } else if (platform === "darwin") {
      // macOS: open URL in default browser
      spawn("open", [safeTarget], {
        detached: true,
        stdio: "ignore",
      }).unref();
    } else {
      // Linux/BSD: xdg-open in default browser
      spawn("xdg-open", [safeTarget], {
        detached: true,
        stdio: "ignore",
      }).unref();
    }

    return ok({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[open-url] Failed to spawn default browser:", msg);
    return apiError("Failed to open URL in system browser.", 500);
  }
});
