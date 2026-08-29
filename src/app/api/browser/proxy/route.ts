import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/session";
import { withRateLimit } from "@/lib/rate-limit";
import { withErrorHandler, apiError } from "@/app/api/_lib/helpers";
import { checkUrlHost, getSsrfDispatcher } from "@/lib/ssrf";

export const dynamic = "force-dynamic";

const MAX_REDIRECTS = 5;
const PROXY_TIMEOUT_MS = 15_000;

/** Escape a URL for safe interpolation inside an HTML attribute value. */
function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/'/g, "&#39;");
}

/** Convert a relative or protocol-relative URL to a secure absolute URL */
function toAbsoluteUrl(raw: string, base: string): string {
  if (!raw || typeof raw !== "string") return "";
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();
  // Strip dangerous executable script schemes completely
  if (lower.startsWith("javascript:") || lower.startsWith("vbscript:")) {
    return "#";
  }
  if (
    lower.startsWith("data:") ||
    lower.startsWith("blob:") ||
    lower.startsWith("#")
  ) {
    return raw;
  }
  if (trimmed.startsWith("//")) {
    return "https:" + trimmed;
  }
  try {
    return new URL(trimmed, base).toString();
  } catch {
    return raw;
  }
}

export const GET = withErrorHandler(async (req: NextRequest) => {
  const user = await requireUser();
  const limited = await withRateLimit(req, `browser-proxy:${user.id}`, { capacity: 30, refillPerSec: 2 });
  if (limited) return limited;
  const { searchParams } = new URL(req.url);
  const targetUrl = searchParams.get("url");

  if (!targetUrl || !/^https?:\/\//i.test(targetUrl)) {
    return apiError("Invalid or missing target URL.", 400);
  }

  // SSRF guard on the initial target AND every redirect hop — mirrors the
  // agent-side realHttpFetch policy (checkUrlHost from lib/ssrf.ts).
  const initialBlocked = await checkUrlHost(targetUrl);
  if (initialBlocked) {
    return apiError(`Target refused: ${initialBlocked}`, 403);
  }

  try {
    let current = targetUrl;
    let hops = 0;
    let res: Response;
    for (;;) {
      const hopBlocked = await checkUrlHost(current);
      if (hopBlocked) {
        return apiError(`Redirect refused: ${hopBlocked}`, 403);
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);
      try {
        res = await fetch(current, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            // No explicit Accept-Encoding: let undici negotiate gzip/br — the
            // wire transfer is compressed and res.text() transparently
            // decodes, so <base> injection below still sees plain HTML.
          },
          redirect: "manual",
          signal: controller.signal,
          dispatcher: getSsrfDispatcher(),
        } as RequestInit);
      } finally {
        clearTimeout(timer);
      }

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        try {
          await res.body?.cancel();
        } catch {
          /* ignore */
        }
        if (!location) return apiError("Redirect without a Location header.", 502);
        if (++hops > MAX_REDIRECTS) return apiError("Too many redirects.", 502);
        try {
          current = new URL(location, current).toString();
        } catch {
          return apiError("Invalid redirect location.", 502);
        }
        continue;
      }
      break;
    }

    const contentType = res.headers.get("content-type") || "text/html; charset=utf-8";
    let body = await res.text();

    // If HTML, resolve relative subresources and inject base tag and referrer policy
    if (contentType.includes("text/html")) {
      // 1. Rewrite relative and protocol-relative stylesheet links
      body = body.replace(/<link\b([^>]*?)href=(["'])(.*?)\2([^>]*?)>/gi, (match, prefix, quote, href, suffix) => {
        const abs = toAbsoluteUrl(href, current);
        return `<link ${prefix}href=${quote}${escapeHtmlAttr(abs)}${quote}${suffix}>`;
      });

      // 2. Rewrite relative and protocol-relative script sources
      body = body.replace(/<script\b([^>]*?)src=(["'])(.*?)\2([^>]*?)>/gi, (match, prefix, quote, src, suffix) => {
        const abs = toAbsoluteUrl(src, current);
        return `<script ${prefix}src=${quote}${escapeHtmlAttr(abs)}${quote}${suffix}>`;
      });

      // 3. Rewrite relative and protocol-relative image sources
      body = body.replace(/<img\b([^>]*?)src=(["'])(.*?)\2([^>]*?)>/gi, (match, prefix, quote, src, suffix) => {
        const abs = toAbsoluteUrl(src, current);
        return `<img ${prefix}src=${quote}${escapeHtmlAttr(abs)}${quote}${suffix}>`;
      });

      // 4. Inject <base> and <meta name="referrer" content="no-referrer"> tag
      const baseTag = `<base href="${escapeHtmlAttr(current)}"><meta name="referrer" content="no-referrer">`;
      const headPattern = /(<head\b[^>]*>)/i;
      if (headPattern.test(body)) {
        body = body.replace(headPattern, `$1${baseTag}`);
      } else {
        body = `${baseTag}${body}`;
      }
    }

    const headers = new Headers();
    headers.set("Content-Type", contentType);
    // Sandbox the proxied document: scripts/forms/popups still run so pages
    // render, but the document gets an opaque origin (no allow-same-origin),
    // so attacker-controlled HTML cannot read app cookies or call app APIs
    // same-origin. Permissive subresource CSP allows external CSS, fonts, and images.
    headers.set(
      "Content-Security-Policy",
      "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads; default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; style-src * 'unsafe-inline' data: blob:; font-src * data: blob:; img-src * data: blob: https: http:; media-src * data: blob:; script-src * 'unsafe-inline' 'unsafe-eval' data: blob:; connect-src *;",
    );
    headers.set("X-Content-Type-Options", "nosniff");
    // Prevent the browser from caching stale proxied pages.
    headers.set("Cache-Control", "no-store");

    return new NextResponse(body, {
      status: res.status,
      headers,
    });
  } catch (err) {
    const reason =
      err instanceof Error && err.name === "AbortError"
        ? "Target timed out."
        : err instanceof Error
          ? "Failed to proxy target URL."
          : "Failed to proxy target URL.";
    return apiError(reason, 502);
  }
});