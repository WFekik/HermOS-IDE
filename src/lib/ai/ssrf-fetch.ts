/**
 * Shared SSRF-gated fetch utility for provider HTTP calls.
 *
 * Validates the request URL (and every redirect target) against the shared
 * SSRF policy before sending. Strips credential headers when crossing
 * origins. Converts non-GET/HEAD to GET on 301/302/303 redirects per
 * RFC 7231 §6.4 (and drops the body + entity headers so PUT/DELETE payloads
 * are never forwarded cross-origin).
 *
 * Scope: provider-only. Callers pass provider API keys via
 * `authorization` / `x-api-key`; `cookie` / `proxy-authorization` are also
 * stripped on cross-origin hops as defense-in-depth. Not a general-purpose
 * browser fetch — redirect bodies are drained to avoid undici socket leaks.
 *
 * Extracted from executor.ts and subagent-executor.ts to eliminate the
 * duplicated security logic that was drifting between the two files.
 */
import { assertUrlAllowed, getSsrfDispatcher } from "@/lib/ssrf";

/**
 * Redirect cap for server-to-provider API calls. Provider endpoints should
 * never redirect deeply; 3 hops bounds SSRF exposure while tolerating
 * normal gateway/CDN redirects. Distinct from AGENT_WEB_MAX_REDIRECTS:
 * agent web browsing follows real-world site chains (trackers, consent,
 * shorteners) that legitimately run deeper. Keep both caps imported from
 * their single sources — do not reintroduce a third literal.
 */
export const PROVIDER_MAX_REDIRECTS = 3;

/**
 * Perform an SSRF-safe fetch, following up to PROVIDER_MAX_REDIRECTS redirects.
 * Each hop is validated by assertUrlAllowed before the request is sent.
 * Credential headers are stripped when crossing origins.
 * 301/302/303 responses convert non-GET/HEAD requests to GET (RFC 7231 §6.4).
 */
export async function fetchWithSsrf(url: string, init: RequestInit = {}): Promise<Response> {
  let currentUrl = url;
  let currentInit: RequestInit = { ...init };

  for (let hop = 0; hop <= PROVIDER_MAX_REDIRECTS; hop++) {
    await assertUrlAllowed(currentUrl);

    const fetchInit: RequestInit & { dispatcher?: unknown } = {
      ...currentInit,
      redirect: "manual",
      dispatcher: getSsrfDispatcher(),
    };
    const resp = await fetch(currentUrl, fetchInit as RequestInit);

    const isRedirect = [301, 302, 303, 307, 308].includes(resp.status);
    const location = resp.headers.get("location");

    if (isRedirect && location) {
      // Drain/cancel the redirect body so the undici socket can be reused
      // instead of leaking.
      try {
        await resp.body?.cancel();
      } catch {
        /* ignore — best-effort socket release */
      }
      if (hop === PROVIDER_MAX_REDIRECTS) {
        throw new Error(`SSRF: Exceeded maximum allowed redirects (${PROVIDER_MAX_REDIRECTS})`);
      }
      let nextUrl: string;
      try {
        nextUrl = new URL(location, currentUrl).toString();
      } catch {
        throw new Error("SSRF: Invalid redirect location.");
      }
      await assertUrlAllowed(nextUrl);

      let currentOrigin: string;
      let nextOrigin: string;
      try {
        currentOrigin = new URL(currentUrl).origin;
        nextOrigin = new URL(nextUrl).origin;
      } catch {
        throw new Error("SSRF: Invalid redirect URL.");
      }

      // Strip credential headers when crossing origins to prevent leakage.
      let nextInit: RequestInit = currentInit;
      if (currentOrigin !== nextOrigin && currentInit.headers) {
        const headers = new Headers(currentInit.headers);
        headers.delete("authorization");
        headers.delete("proxy-authorization");
        headers.delete("cookie");
        headers.delete("x-api-key");
        nextInit = { ...currentInit, headers };
      }

      // RFC 7231 §6.4: 301, 302, 303 MAY change POST to GET and discard the
      // body. Extend to any non-GET/HEAD method so PUT/DELETE bodies are never
      // forwarded (including cross-origin). 307 and 308 preserve method+body.
      const method = nextInit.method?.toUpperCase() ?? "GET";
      if ([301, 302, 303].includes(resp.status) && method !== "GET" && method !== "HEAD") {
        const headers = new Headers(nextInit.headers ?? {});
        headers.delete("content-length");
        headers.delete("content-type");
        nextInit = { ...nextInit, method: "GET", body: undefined, headers };
      }

      currentUrl = nextUrl;
      currentInit = nextInit;
      continue;
    }

    return resp;
  }
  throw new Error("SSRF: Redirect loop detected");
}
