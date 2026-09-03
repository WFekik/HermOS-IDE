import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/session";
import { withRateLimit } from "@/lib/rate-limit";
import { withErrorHandler, apiError } from "@/app/api/_lib/helpers";
import { checkUrlHost, getSsrfDispatcher } from "@/lib/ssrf";
import { PROXY_CSP } from "@/lib/csp";

export const dynamic = "force-dynamic";

const MAX_REDIRECTS = 5;
const PROXY_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024; // 5 MB size limit to prevent memory DoS

async function readResponseTextWithLimit(res: Response, maxBytes = MAX_RESPONSE_BYTES): Promise<string> {
  const cl = res.headers.get("content-length");
  if (cl && Number(cl) > maxBytes) {
    try { await res.body?.cancel(); } catch {}
    throw new Error(`Response size exceeds limit of ${maxBytes / (1024 * 1024)}MB.`);
  }
  if (res.body && typeof res.body.getReader === "function") {
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          try { await reader.cancel(); } catch {}
          throw new Error(`Response size exceeds limit of ${maxBytes / (1024 * 1024)}MB.`);
        }
        chunks.push(value);
      }
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.byteLength;
    }
    return new TextDecoder().decode(merged);
  }
  const txt = await res.text();
  if (txt.length > maxBytes) {
    throw new Error(`Response size exceeds limit of ${maxBytes / (1024 * 1024)}MB.`);
  }
  return txt;
}

/** Escape a URL for safe interpolation inside an HTML attribute value. */
function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/'/g, "&#39;");
}

/**
 * Convert a relative or protocol-relative URL to a secure absolute URL.
 * Company-grade: case-insensitive scheme check (blocks `JaVaScRiPt:`,
 * `DATA:` bypasses), blocks executable schemes (`javascript:`, `vbscript:`,
 * `file:`) by returning a safe fragment instead of re-emitting them, and
 * preserves `data:`/`blob:`/`#` passthrough for images/media.
 */
export function toAbsoluteUrl(raw: string, base: string): string {
  if (!raw || typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const lower = trimmed.toLowerCase();
  // Block executable / local-file schemes completely (case-insensitive).
  if (
    lower.startsWith("javascript:") ||
    lower.startsWith("vbscript:") ||
    lower.startsWith("file:")
  ) {
    return "#";
  }
  if (
    lower.startsWith("data:") ||
    lower.startsWith("blob:") ||
    trimmed.startsWith("#")
  ) {
    return raw;
  }
  if (trimmed.startsWith("//")) {
    const proto = base.toLowerCase().startsWith("http:") ? "http:" : "https:";
    return proto + trimmed;
  }
  try {
    return new URL(trimmed, base).toString();
  } catch {
    return raw;
  }
}

/**
 * Rewrite a `srcset` attribute value (comma-separated `url [descriptor]` list)
 * to absolute URLs. Leaves descriptors (`1x`, `400w`) untouched.
 */
export function rewriteSrcset(srcset: string, base: string): string {
  return srcset
    .split(",")
    .map((part) => {
      const trimmed = part.trim();
      if (!trimmed) return part;
      const spaceIdx = trimmed.search(/\s/);
      if (spaceIdx === -1) return toAbsoluteUrl(trimmed, base);
      const url = trimmed.slice(0, spaceIdx);
      const descriptor = trimmed.slice(spaceIdx);
      return `${toAbsoluteUrl(url, base)}${descriptor}`;
    })
    .join(", ");
}

/**
 * Rewrite CSS `url(...)` references inside inline `style="..."` attributes.
 * Handles quoted and unquoted forms; leaves `data:`/`blob:` untouched via
 * `toAbsoluteUrl`.
 */
export function rewriteStyleUrls(style: string, base: string): string {
  return style.replace(
    /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s]+))\s*\)/gi,
    (match, dq: string | undefined, sq: string | undefined, uq: string | undefined) => {
      const original = dq ?? sq ?? uq ?? "";
      const abs = toAbsoluteUrl(original, base);
      // Preserve original quoting style; escape double quotes for attr safety.
      const quote = dq !== undefined ? '"' : sq !== undefined ? "'" : "";
      const safe = abs.replace(/"/g, "&quot;");
      return `url(${quote}${safe}${quote})`;
    },
  );
}

/**
 * Rewrite all URL-bearing attributes to absolute URLs so proxied pages keep
 * working even if the injected `<base>` tag is stripped downstream.
 * Covers: a/link[href], script/img/source/video/audio/embed/iframe/input/
 * track[src+srcset], video[poster], object[data], form[action],
 * button/input[formaction], plus inline style url(...).
 * - Handles single-, double-quoted AND unquoted attribute values.
 * - `<base href>` is still injected as the primary mechanism; this rewrite is
 *   defense-in-depth, so any exotic markup missed here still resolves via base.
 */
export function rewriteHtmlUrls(html: string, base: string): string {
  // 1. url-bearing attributes (quoted or unquoted)
  const attrPattern =
    /<(a|link|script|img|source|video|audio|embed|iframe|object|form|input|track|button)\b([^>]*?)\b(href|src|srcset|poster|data|action|formaction)\s*=\s*("[^"]*"|'[^']*'|[^\s"'`>]+)([^>]*?)>/gi;
  let out = html.replace(
    attrPattern,
    (
      match: string,
      tag: string,
      before: string,
      attrName: string,
      rawValue: string,
      after: string,
    ) => {
      const first = rawValue[0];
      const quoted = first === '"' || first === "'";
      const quote = quoted ? first : '"';
      const inner = quoted ? rawValue.slice(1, -1) : rawValue;
      const lowerAttr = attrName.toLowerCase();
      let rewritten: string;
      if (lowerAttr === "srcset") {
        rewritten = rewriteSrcset(inner, base);
      } else if (
        lowerAttr === "style" ||
        // style handled separately below; keep here for completeness
        false
      ) {
        rewritten = inner;
      } else {
        rewritten = toAbsoluteUrl(inner, base);
      }
      const safe = escapeHtmlAttr(rewritten);
      return `<${tag}${before}${attrName}=${quote}${safe}${quote}${after}>`;
    },
  );

  // 2. inline style="...url(...)..." attributes (quoted only — unquoted style
  // values cannot contain url() with spaces reliably; base tag covers rest)
  out = out.replace(
    /\bstyle\s*=\s*("[^"]*"|'[^']*')/gi,
    (match: string, quotedValue: string) => {
      const quote = quotedValue[0];
      const inner = quotedValue.slice(1, -1);
      if (!/url\(/i.test(inner)) return match;
      const rewritten = rewriteStyleUrls(inner, base);
      // style content is CSS, not a URL — escape only the attr delimiters
      const safe =
        quote === '"'
          ? rewritten.replace(/"/g, "&quot;")
          : rewritten.replace(/'/g, "&#39;");
      return `style=${quote}${safe}${quote}`;
    },
  );

  return out;
}

/**
 * Inject `<base>` + referrer meta without breaking doctype (quirks mode).
 * Order: after `<head>` if present, else after `<html>` if present, else
 * after `<!doctype>` if present, else prepend.
 */
export function injectBaseTag(html: string, current: string): string {
  const baseTag = `<base href="${escapeHtmlAttr(current)}"><meta name="referrer" content="no-referrer">`;
  const headPattern = /(<head\b[^>]*>)/i;
  if (headPattern.test(html)) return html.replace(headPattern, `$1${baseTag}`);
  const htmlPattern = /(<html\b[^>]*>)/i;
  if (htmlPattern.test(html)) return html.replace(htmlPattern, `$1${baseTag}`);
  const doctypePattern = /(<!doctype\b[^>]*>)/i;
  if (doctypePattern.test(html)) return html.replace(doctypePattern, `$1${baseTag}`);
  return `${baseTag}${html}`;
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
    let body = await readResponseTextWithLimit(res);

    // If HTML, resolve relative subresources and inject base tag and referrer policy.
    // `<base>` is the primary mechanism; `rewriteHtmlUrls` is defense-in-depth
    // so pages keep working even if base is stripped downstream.
    if (contentType.includes("text/html")) {
      body = rewriteHtmlUrls(body, current);
      body = injectBaseTag(body, current);
    }

    const headers = new Headers();
    headers.set("Content-Type", contentType);
    // Sandbox the proxied document: scripts/forms/popups still run so pages
    // render, but the document gets an opaque origin (no allow-same-origin),
    // so attacker-controlled HTML cannot read app cookies or call app APIs
    // same-origin. Permissive subresource CSP allows external CSS, fonts, and images.
    // Single source of truth — see src/lib/csp.ts (also used by next.config.ts).
    headers.set("Content-Security-Policy", PROXY_CSP);
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