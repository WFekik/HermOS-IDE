/**
 * Single source of truth for Content-Security-Policy strings.
 *
 * Company-grade rationale:
 * - The strict IDE CSP and the permissive sandboxed-proxy CSP were previously
 *   duplicated as long literals in `next.config.ts` and
 *   `src/app/api/browser/proxy/route.ts`. Duplication drifts (one file gets
 *   `media-src https:` while the other doesn't) and causes subtle iframe
 *   breakage. Import this module from both places.
 *
 * Merge order note (Next.js):
 * - `headers()` in `next.config.ts` applies to all responses for a route.
 * - Headers set directly on the `NextResponse` in the route handler WIN over
 *   `headers()` config for the same header name.
 * - So the proxy route handler's `Content-Security-Policy` is authoritative;
 *   the config entry for `/api/browser/proxy` is defense-in-depth for
 *   non-GET / error paths that never reach the handler's `headers.set`.
 */

/**
 * Permissive CSP for the sandboxed browser-proxy iframe.
 * - `sandbox ...` without `allow-same-origin` gives the proxied document an
 *   opaque origin: attacker HTML cannot read app cookies or call same-origin APIs.
 * - `default-src * 'unsafe-inline' 'unsafe-eval'` + explicit `img/media/script`
 *   allowances let real-world pages load cross-origin CSS/fonts/images/scripts.
 * - Keep in sync: any change here must be reflected in both `next.config.ts`
 *   and the proxy route handler (both import this constant, so it is automatic).
 */
export const PROXY_CSP =
  "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads; " +
  "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; " +
  "style-src * 'unsafe-inline' data: blob:; " +
  "font-src * data: blob:; " +
  "img-src * data: blob: https: http:; " +
  "media-src * data: blob: https: http:; " +
  "script-src * 'unsafe-inline' 'unsafe-eval' data: blob:; " +
  "connect-src *;";
