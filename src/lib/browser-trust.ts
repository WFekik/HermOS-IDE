/**
 * Browser trust classification — dependency-free and safe for client bundles.
 *
 * Single source of truth for answering "is this browser target the user's own
 * app or a stranger's page?" Used by:
 * - the agent permission gate (trusted-loopback `browser_open` is auto-allowed,
 *   everything else keeps asking),
 * - the Browser panel (iframe `sandbox` strength + direct-vs-proxy rendering),
 * - audit logging.
 *
 * SECURITY CONTRACT:
 * - This module is PURE and SYNCHRONOUS — no DNS, no I/O. Trust follows the
 *   URL-*normalized* host (WHATWG parsing canonicalizes hex/decimal/octal
 *   IPv4 spellings to dotted quads, so the destination genuinely is
 *   loopback). A hostile *hostname* that DNS-resolves to 127.0.0.1
 *   (rebinding) is NOT trusted here — only literal loopback names/IPs are;
 *   the server-side SSRF policy (`src/lib/ssrf.ts`) remains the authoritative
 *   network gate and still runs inside every browser action.
 * - `trusted-loopback` means "the user's own machine". `local-network` covers
 *   LAN/mDNS/single-label dev hosts: still the user's local environment for
 *   *preview* purposes (sandboxed direct iframe so HMR/WS/localStorage work),
 *   but NEVER permission-exempt. `public` goes through the stripping proxy
 *   with an opaque origin.
 */

/** Where the framed/fetched page stands relative to the user. */
export type BrowserTrustTier =
  | "trusted-loopback"
  | "local-network"
  | "public";

export interface BrowserTrust {
  tier: BrowserTrustTier;
  /** Lowercased hostname as configured (brackets stripped for IPv6). */
  host: string;
  /** Effective port (explicit or scheme default), null when unparseable. */
  port: number | null;
  /** Human-readable reason for UI badges and audit trails. */
  reason: string;
}

/** Canonical dotted-quad loopback (digits only — hex/octal tricks don't qualify). */
const LOOPBACK_V4_RE = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
/** Canonical dotted-quad private ranges. */
const PRIVATE_V4_RE = /^(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})$/;

/** Every octet 0–255 (rejects 127.999.x.x-style literals outright). */
function hasValidOctets(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

function defaultPort(protocol: string): number | null {
  if (protocol === "http:") return 80;
  if (protocol === "https:") return 443;
  return null;
}

/**
 * Classify a raw target URL into a trust tier. Pure: safe to call from the
 * permission gate, API routes, and client components alike.
 */
export function classifyBrowserTrust(rawUrl: string): BrowserTrust {
  const fallback = (reason: string): BrowserTrust => ({
    tier: "public",
    host: "",
    port: null,
    reason,
  });
  if (typeof rawUrl !== "string" || !rawUrl.trim()) {
    return fallback("Empty URL — treated as public.");
  }
  let u: URL;
  try {
    u = new URL(rawUrl.trim());
  } catch {
    return fallback("Unparseable URL — treated as public.");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return fallback(`Non-http(s) scheme (${u.protocol}) — treated as public.`);
  }
  let host = u.hostname.toLowerCase();
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  const port = u.port ? Number(u.port) : defaultPort(u.protocol);
  if (!host) return fallback("Missing host — treated as public.");

  // --- Tier 1: the user's own machine (canonical literals only) ---
  // Unspecified addresses (`0.0.0.0`, `::`) are NOT trusted: they are not a
  // real destination, and the server-side SSRF policy fail-closes them. The
  // exemption path therefore degrades to a clear SSRF error instead of a
  // silent sandbox upgrade.
  if (
    host === "::" ||
    host === "0.0.0.0"
  ) {
    return {
      tier: "public",
      host,
      port,
      reason: `Unspecified address (${host}) — proxied and sandboxed.`,
    };
  }
  if (
    host === "localhost" ||
    host === "localhost.localdomain" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    (LOOPBACK_V4_RE.test(host) && hasValidOctets(host))
  ) {
    return {
      tier: "trusted-loopback",
      host,
      port,
      reason: `Loopback host (${host}) — the user's own machine.`,
    };
  }

  // --- Tier 2: local network / dev environment ---
  // IPv6 literals: only loopback (tier 1, above) is trusted. Link-local and
  // unique-local addresses are LAN-scoped; everything else is public.
  if (host.includes(":")) {
    if (
      /^fe[89ab][0-9a-f]:/.test(host) ||
      /^f[cd][0-9a-f]{2}:/.test(host) ||
      /^fec[0-9a-f]:/.test(host)
    ) {
      return {
        tier: "local-network",
        host,
        port,
        reason: `Local-network IPv6 host (${host}) — sandboxed direct view, permission still required.`,
      };
    }
    return {
      tier: "public",
      host,
      port,
      reason: `Public IPv6 host (${host}) — proxied and sandboxed.`,
    };
  }

  // Canonical dotted quads: loopback handled in tier 1; RFC1918 is local;
  // link-local, multicast, invalid octets, and anything else is public
  // (SSRF still gates).
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
    if (PRIVATE_V4_RE.test(host) && hasValidOctets(host)) {
      return {
        tier: "local-network",
        host,
        port,
        reason: `Private-network address (${host}) — sandboxed direct view, permission still required.`,
      };
    }
    return {
      tier: "public",
      host,
      port,
      reason: `Non-private IP literal (${host}) — proxied and sandboxed.`,
    };
  }

  // Hostnames: mDNS / internal suffixes and single-label dev names
  // (compose service names, dev boxes) resolve via the local environment.
  // Sandboxed direct framing still applies; never permission-exempt.
  if (
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".lan") ||
    host.endsWith(".home") ||
    !host.includes(".")
  ) {
    return {
      tier: "local-network",
      host,
      port,
      reason: `Local-network host (${host}) — sandboxed direct view, permission still required.`,
    };
  }

  return {
    tier: "public",
    host,
    port,
    reason: `Public host (${host}) — proxied and sandboxed.`,
  };
}

/**
 * iframe `sandbox` token set per tier. Deliberately NEVER includes
 * `allow-top-navigation` (framed app cannot navigate the IDE window) nor
 * `allow-downloads` (drive-by downloads stay blocked; the user can still use
 * "Open in new tab"). Local tiers add `allow-same-origin` so dev apps keep
 * working (localStorage, HMR, same-origin fetch); the public tier renders
 * with an opaque origin (double-enforced with PROXY_CSP server-side).
 */
export function sandboxForTier(tier: BrowserTrustTier): string {
  switch (tier) {
    case "trusted-loopback":
    case "local-network":
      return "allow-scripts allow-forms allow-modals allow-popups allow-same-origin";
    case "public":
      return "allow-scripts allow-forms allow-popups";
  }
}

/**
 * Permission-gate helper: true only for `browser_open` whose configured URL
 * is a canonical loopback literal. Pure/sync so the gate never performs DNS
 * (no rebinding oracle). The SSRF policy inside `browserOpen` still applies.
 */
export function isTrustedLoopbackBrowserOpen(
  toolName: string,
  args: unknown,
): boolean {
  if (toolName !== "browser_open") return false;
  if (!args || typeof args !== "object") return false;
  const url = (args as Record<string, unknown>).url;
  if (typeof url !== "string" || !url.trim()) return false;
  try {
    return classifyBrowserTrust(url).tier === "trusted-loopback";
  } catch {
    return false;
  }
}
