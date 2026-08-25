import { lookup as dnsLookup } from "dns/promises";
import { isIP } from "net";
import { Agent } from "undici";

/**
 * Shared SSRF policy for outbound HTTP/browser requests. Blocks link-local metadata ranges,
 * non-http schemes, and private RFC1918/loopback ranges via IP literal and DNS resolution checks.
 *
 * POLICY (fail-closed by default):
 *   - `SSRF_BLOCK_PRIVATE` unset or "true"  → strict: RFC1918/loopback/link-local/unspecified
 *     ranges are BLOCKED, EXCEPT a small allowlist of well-known local-AI hosts used by the
 *     app (Ollama / LM Studio / llama.cpp on http://localhost:11434, http://127.0.0.1:1234,
 *     etc.): `localhost`, `127.0.0.1`, `::1`, `0.0.0.0`, and `[::ffff:127.0.0.1]` mapped forms,
 *     on any port. Other local hostnames (e.g. a LAN Ollama box) require
 *     `SSRF_BLOCK_PRIVATE=false`.
 *   - `SSRF_BLOCK_PRIVATE=false` → lenient: private/loopback allowed (local-first IDE default
 *     behavior), metadata/link-local/unspecified still blocked.
 *   - Cloud metadata addresses (169.254.169.254 etc.) are ALWAYS rejected, including
 *     encoded/octal/hex/mapped-IPv6 tricks of the same ranges.
 *   - The allowlist matches the *configured* host string, never DNS resolution results, so a
 *     hostile domain resolving to 127.0.0.1 cannot inherit localhost privileges (DNS rebinding).
 */

const STRICT = process.env.SSRF_BLOCK_PRIVATE !== "false";

type HostClass = "public" | "loopback" | "private" | "linklocal" | "unspecified";

const LINKLOCAL_V4_RE = /^169\.254\./;
const LOOPBACK_V4_RE = /^127\./;
const UNSPECIFIED_V4_RE = /^0\./;
const PRIVATE_V4_RE = /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/;

/**
 * Normalize an IPv4 literal — including single-number (decimal, 0x hex,
 * leading-zero octal) and short-dotted forms that OS resolvers and Chromium
 * accept — to a dotted quad, or null when the host is not a numeric IPv4
 * literal.
 */
export function parseIpv4Literal(host: string): string | null {
  let h = host.toLowerCase();
  if (h.endsWith(".")) h = h.slice(0, -1);
  if (!h || h.length > 64) return null;
  const parts = h.split(".");
  if (parts.length > 4) return null;
  const nums: number[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!/^(?:0x)?[0-9a-f]+$/.test(p) || p.length > 12) return null;
    let v: number;
    if (/^0x/.test(p)) v = Number.parseInt(p.slice(2), 16);
    else if (p.length > 1 && p.startsWith("0")) v = Number.parseInt(p, 8);
    else v = Number.parseInt(p, 10);
    if (!Number.isFinite(v) || v < 0) return null;
    const max = i === parts.length - 1 ? 2 ** (8 * (5 - parts.length)) - 1 : 255;
    if (v > max) return null;
    nums.push(v);
  }
  const octets = nums.slice(0, -1);
  let last = nums[nums.length - 1];
  const lastOctets: number[] = [];
  for (let i = 4 - octets.length; i > 0; i--) {
    lastOctets.unshift(last & 255);
    last = Math.floor(last / 256);
  }
  return [...octets, ...lastOctets].join(".");
}

function hexGroupsToIpv4(s: string): string | null {
  const groups = s.split(":");
  if (groups.length < 1 || groups.length > 2) return null;
  let v = 0;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    v = v * 0x10000 + Number.parseInt(g, 16);
  }
  if (v > 0xffffffff) return null;
  return `${(v >>> 24) & 255}.${(v >>> 16) & 255}.${(v >>> 8) & 255}.${v & 255}`;
}

export function classifyIpv4(ip: string): HostClass {
  if (LINKLOCAL_V4_RE.test(ip)) return "linklocal";
  if (LOOPBACK_V4_RE.test(ip)) return "loopback";
  if (UNSPECIFIED_V4_RE.test(ip)) return "unspecified";
  if (PRIVATE_V4_RE.test(ip)) return "private";
  return "public";
}

export function classifyIpv6(host: string): HostClass {
  let h = host.toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (h === "::" || h === "0:0:0:0:0:0:0:0") return "unspecified";
  if (h === "::1" || h === "0:0:0:0:0:0:0:1") return "loopback";
  const lastColon = h.lastIndexOf(":");
  const tail = lastColon >= 0 ? h.slice(lastColon + 1) : h;
  if (tail.includes(".")) {
    const v4 = parseIpv4Literal(tail);
    if (v4) return classifyIpv4(v4);
    return "public";
  }
  const mapped = /^(?:::ffff|0:0:0:0:0:ffff):(.+)$/.exec(h);
  if (mapped) {
    const v4 = hexGroupsToIpv4(mapped[1]);
    if (v4) return classifyIpv4(v4);
    return "public";
  }
  if (/^fe[89ab][0-9a-f]:/.test(h)) return "linklocal";
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return "private";
  if (/^fe[c-f][0-9a-f]:/.test(h)) return "private";
  return "public";
}

/** Error message for a host class under the active policy, or null when allowed. */
export function hostClassError(cls: HostClass): string | null {
  if (cls === "linklocal" || cls === "unspecified") {
    return "Requests to link-local, metadata, or unspecified addresses are not allowed.";
  }
  if (STRICT && (cls === "loopback" || cls === "private")) {
    return "Requests to private/internal networks are not allowed (set SSRF_BLOCK_PRIVATE=false to allow).";
  }
  return null;
}

/**
 * Well-known local-AI hosts the app legitimately talks to (Ollama, LM Studio,
 * llama.cpp, vLLM …) — allowed on any port even under the strict policy.
 * Matched against the CONFIGURED host string, not DNS-resolved addresses.
 */
const LOCAL_AI_ALLOWLIST = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

function isLocalAiHost(host: string): boolean {
  const h = host.toLowerCase();
  if (LOCAL_AI_ALLOWLIST.has(h)) return true;
  // IPv4-mapped loopback forms: [::ffff:127.0.0.1], 0:0:0:0:0:ffff:127.0.0.1,
  // ::ffff:7f00:1 (hex-group form).
  const mapped = /^(?:::ffff|0:0:0:0:0:ffff):(.+)$/.exec(h);
  if (!mapped) return false;
  const inner = mapped[1];
  const hexForm = hexGroupsToIpv4(inner);
  if (hexForm === "127.0.0.1") return true;
  const dotted = parseIpv4Literal(inner);
  return dotted === "127.0.0.1";
}

/** Combined policy: allowlist first, then class-based policy. */
function policyErrorFor(host: string, cls: HostClass): string | null {
  if (isLocalAiHost(host)) return null;
  return hostClassError(cls);
}

/**
 * Validate a URL against the SSRF policy: scheme (http/https only), host
 * literals (incl. encoded IP forms), and DNS resolution of every record.
 * Returns an error message when the target is refused, null when allowed.
 */
export async function checkUrlHost(urlStr: string): Promise<string | null> {
  let u: URL;
  try {
    u = new URL(urlStr);
  } catch {
    return "Invalid URL.";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return "Only http(s) URLs are allowed.";
  }
  let host = u.hostname.toLowerCase();
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (!host) return "Invalid URL host.";
  if (host === "localhost" || host === "localhost.localdomain") {
    return policyErrorFor(host, "loopback");
  }
  const literal = parseIpv4Literal(host);
  if (literal) return policyErrorFor(literal, classifyIpv4(literal));
  if (isIP(host) === 6) return policyErrorFor(host, classifyIpv6(host));
  if (isIP(host) === 4) return policyErrorFor(host, classifyIpv4(host));
  try {
    const addrs = await dnsLookup(host, { all: true, verbatim: true });
    for (const a of addrs) {
      const cls = a.family === 6 ? classifyIpv6(a.address) : classifyIpv4(a.address);
      // Deliberately pass the ORIGINAL hostname, not the resolved address:
      // the local-AI allowlist must only match what the user configured, so
      // an attacker-controlled domain resolving to 127.0.0.1 is still refused
      // under the strict policy (DNS-rebinding protection).
      const err = policyErrorFor(host, cls);
      if (err) return err;
    }
  } catch {
    // Fail-closed on DNS failure: an unresolvable host cannot be verified as
    // public. Allowing it would let an attacker probe internal DNS or exploit
    // TOCTOU where check-time NXDOMAIN / timeout becomes a private IP at
    // fetch-time (DNS rebinding). The fetch would fail anyway, but failing closed
    // here prevents the outbound attempt and closes the rebinding window.
    // Post-fetch IP re-verification is also performed in provider-fetch.ts
    // (redirect re-check) and should be added to any http_fetch / browser
    // tool paths that can be guided by untrusted page content.
    return "DNS resolution failed — host is unresolvable or blocked; refusing request.";
  }
  return null;
}

/** Throw when `urlStr` violates the SSRF policy; resolve when allowed. */
export async function assertUrlAllowed(urlStr: string): Promise<void> {
  const reason = await checkUrlHost(urlStr);
  if (reason) {
    throw new Error(`URL blocked by SSRF policy: ${reason}`);
  }
}

let _ssrfDispatcher: Agent | null = null;

/**
 * Returns an undici Agent configured with a custom DNS lookup callback.
 * When undici connects to any hostname, it validates all resolved IP addresses
 * against the SSRF policy before opening the socket.
 *
 * This closes the DNS-rebinding TOCTOU window on connection establishment while
 * preserving the original URL, SNI for TLS certificate validation, and Host header.
 */
export function getSsrfDispatcher(): Agent {
  if (!_ssrfDispatcher) {
    _ssrfDispatcher = new Agent({
      connect: {
        lookup: (hostname, opts, cb) => {
          const callback = (typeof opts === "function" ? opts : cb) as (
            err: Error | null,
            addresses?: Array<{ address: string; family: number }>,
            family?: number,
          ) => void;
          dnsLookup(hostname, { all: true, verbatim: true })
            .then((addrs) => {
              const safeAddrs = addrs.filter((a) => {
                const cls = a.family === 6 ? classifyIpv6(a.address) : classifyIpv4(a.address);
                return policyErrorFor(hostname, cls) === null;
              });
              if (safeAddrs.length === 0) {
                return callback(new Error(`SSRF policy blocked all resolved addresses for host: ${hostname}`), []);
              }
              callback(null, safeAddrs);
            })
            .catch((err) => {
              callback(err as Error, []);
            });
        },
      },
    });
  }
  return _ssrfDispatcher;
}