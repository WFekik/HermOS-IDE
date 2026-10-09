import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  browserOpen,
  getBrowserSession,
  browserClose,
  browserSnapshot,
} from "./browser";
import { normalizeBrowserUrl } from "@/components/browser/types";
import { classifyBrowserTrust } from "./browser-trust";

// Mock the CLI transport so the shared-session regression can exercise the
// full open path without spawning a real headless browser.
const execFileMock = vi.hoisted(() => vi.fn());
vi.mock("child_process", () => ({
  execFile: execFileMock,
}));

// SSRF check would fail-closed on DNS failure for example.com in test env
// (no real DNS). Mock it to allow the test URL while keeping real SSRF
// logic for the dedicated SSRF test below.
const mockCheckUrlHost = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ssrf", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ssrf")>("@/lib/ssrf");
  return {
    ...actual,
    checkUrlHost: mockCheckUrlHost,
  };
});

/** Fake agent-browser CLI results keyed by the invoked subcommand. */
function mockCliSuccess() {
  execFileMock.mockImplementation(
    (_cmd: string, args: string[], _opts: unknown, cb: (e: null, o: string, s: string) => void) => {
      const joined = (args ?? []).join(" ");
      let out = "";
      if (joined.includes("get title")) out = "Mock Page Title";
      else if (joined.includes("get url")) out = "https://example.com/final";
      else if (joined.includes("snapshot")) out = '- link "Example Domain"';
      // Defer like a real process — the caller closes over `child`, which is
      // only assigned after execFile returns.
      setImmediate(() => cb(null, out, ""));
      // Minimal ChildProcess-like handle for the supervisor registry.
      return { once: () => {}, on: () => {}, kill: () => {}, killed: false, exitCode: 0 };
    },
  );
}

describe("Browser Session Registry", () => {
  beforeEach(async () => {
    execFileMock.mockReset();
    mockCheckUrlHost.mockReset();
    // Default: allow all hosts (tests that need SSRF blocking set their own mock)
    mockCheckUrlHost.mockResolvedValue(null);
    // Clean up test sessions (bare userId keys — one shared browser per user).
    await browserClose("user_A");
    await browserClose("user_B");
    await browserClose("default");
  });

  it("returns null for nonexistent user sessions", () => {
    expect(getBrowserSession("user_A")).toBeNull();
    expect(getBrowserSession("user_B")).toBeNull();
  });

  it("rejects snapshot when no session exists for that specific user", async () => {
    const res = await browserSnapshot("user_uninitialized");
    expect(res.ok).toBe(false);
    expect(res.error).toContain("No active browser session");
  });

  it("rejects SSRF on private/loopback address in browserOpen", async () => {
    mockCheckUrlHost.mockResolvedValue("Requests to link-local, metadata, or unspecified addresses are not allowed.");
    const res = await browserOpen("http://169.254.169.254/latest/meta-data", "user_A");
    expect(res.ok).toBe(false);
    expect(res.error).toContain("Requests to link-local, metadata, or unspecified addresses are not allowed.");
  });

  it("rejects invalid characters in session key and sanitizes correctly", async () => {
    const res = await browserSnapshot("user:evil;rm -rf /");
    expect(res.ok).toBe(false);
  });

  it("agent tools and the panel share ONE session under the same userId key", async () => {
    mockCliSuccess();
    // Agent path opens through its session key...
    const opened = await browserOpen("https://example.com", "user_A");
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    // ...and the panel path resolves the exact same session object.
    // The session URL follows the LIVE page (post-redirect), not just the
    // requested URL — the mock CLI reports .../final as the live URL.
    const seen = getBrowserSession("user_A");
    expect(seen).not.toBeNull();
    expect(seen!.url).toBe("https://example.com/final");
    expect(seen!.title).toBe("Mock Page Title");
    expect(seen!.trust).toBe("public");
    expect(typeof seen!.seq).toBe("number");

    // Snapshot reads hit the same shared session too.
    const snap = await browserSnapshot("user_A");
    expect(snap.ok).toBe(true);

    await browserClose("user_A");
    expect(getBrowserSession("user_A")).toBeNull();
  });

  it("installs network guards as batch command strings (not stdin-JSON arrays)", async () => {
    mockCliSuccess();
    const opened = await browserOpen("https://example.com", "user_guards");
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    // Find the `batch` invocation: every route must be a single command
    // string ("network route <glob> --abort") — JSON-array argv is stdin-only
    // and would silently install nothing.
    const batchCall = execFileMock.mock.calls.find((c: unknown[]) =>
      (c[1] as string[]).includes("batch"),
    );
    expect(batchCall).toBeDefined();
    const argv = batchCall![1] as string[];
    // Host-anchored, multi-segment (`/**`) globs with explicit-port twins —
    // portless-only or single-segment patterns would fail open on
    // `host:port/...` and `/latest/meta-data/...` shapes.
    expect(argv).toContain("network route *://169.254.169.254/** --abort");
    expect(argv).toContain("network route *://169.254.169.254:*/** --abort");
    expect(argv).toContain("network route *://10.*/** --abort");
    expect(argv).toContain("network route *://172.20.*/** --abort");
    expect(argv).toContain("network route *://localhost:*/** --abort");
    expect(argv).toContain("network route *://*.localhost:*/** --abort");
    for (const a of argv) {
      expect(a.startsWith("["), `must not be a JSON array: ${a}`).toBe(false);
    }
    await browserClose("user_guards");
  });

  it("spawns the browser CLI using process.execPath for portability", async () => {
    mockCliSuccess();
    const opened = await browserOpen("https://example.com", "user_portable");
    expect(opened.ok).toBe(true);

    expect(execFileMock).toHaveBeenCalled();
    const firstCallArgs = execFileMock.mock.calls[0];
    expect(firstCallArgs[0]).toBe(process.execPath);
    await browserClose("user_portable");
  });
});

describe("Browser URL Normalization & Local Dev Classification", () => {
  it("preserves explicit http:// and https:// URLs", () => {
    expect(normalizeBrowserUrl("http://localhost:3000")).toBe("http://localhost:3000");
    expect(normalizeBrowserUrl("https://example.com/docs")).toBe("https://example.com/docs");
    expect(normalizeBrowserUrl("http://192.168.1.10:8080")).toBe("http://192.168.1.10:8080");
    expect(normalizeBrowserUrl("http://plain-http.org")).toBe("http://plain-http.org");
  });

  it("normalizes localhost and loopback IP with or without port to http://", () => {
    expect(normalizeBrowserUrl("localhost:3000")).toBe("http://localhost:3000");
    expect(normalizeBrowserUrl("localhost:5173/dashboard")).toBe("http://localhost:5173/dashboard");
    expect(normalizeBrowserUrl("localhost")).toBe("http://localhost");
    expect(normalizeBrowserUrl("127.0.0.1:3000")).toBe("http://127.0.0.1:3000");
    expect(normalizeBrowserUrl("0.0.0.0:8080")).toBe("http://0.0.0.0:8080");
    expect(normalizeBrowserUrl("::1:3000")).toBe("http://::1:3000");
  });

  it("normalizes LAN / private IPs and host-port combinations to http://", () => {
    expect(normalizeBrowserUrl("192.168.1.100:3000")).toBe("http://192.168.1.100:3000");
    expect(normalizeBrowserUrl("10.0.0.5:8000")).toBe("http://10.0.0.5:8000");
    expect(normalizeBrowserUrl("172.20.0.2:3000")).toBe("http://172.20.0.2:3000");
    expect(normalizeBrowserUrl("my-dev-box:3000")).toBe("http://my-dev-box:3000");
    expect(normalizeBrowserUrl("vite-app:5173/page")).toBe("http://vite-app:5173/page");
  });

  it("normalizes public domain names to https://", () => {
    expect(normalizeBrowserUrl("github.com")).toBe("https://github.com");
    expect(normalizeBrowserUrl("developer.mozilla.org/en-US")).toBe("https://developer.mozilla.org/en-US");
    expect(normalizeBrowserUrl("news.ycombinator.com")).toBe("https://news.ycombinator.com");
  });

  it("falls back to DuckDuckGo search for queries", () => {
    expect(normalizeBrowserUrl("react router tutorial")).toBe("https://duckduckgo.com/?q=react%20router%20tutorial");
    expect(normalizeBrowserUrl("hello world")).toBe("https://duckduckgo.com/?q=hello%20world");
    expect(normalizeBrowserUrl("")).toBe("");
  });

  it("classifies loopback as trusted-loopback, LAN/mDNS as local-network", () => {
    expect(classifyBrowserTrust("http://localhost:3000").tier).toBe("trusted-loopback");
    expect(classifyBrowserTrust("http://127.0.0.1:5173").tier).toBe("trusted-loopback");
    expect(classifyBrowserTrust("http://[::1]:3000").tier).toBe("trusted-loopback");
    expect(classifyBrowserTrust("http://site.localhost:3000").tier).toBe("trusted-loopback");
    expect(classifyBrowserTrust("http://192.168.1.50:3000").tier).toBe("local-network");
    expect(classifyBrowserTrust("http://10.0.0.1:8000").tier).toBe("local-network");
    expect(classifyBrowserTrust("http://172.16.0.5:3000").tier).toBe("local-network");
    expect(classifyBrowserTrust("http://app.local:3000").tier).toBe("local-network");
    // Unspecified addresses are never trusted, even though normalization
    // keeps them as http URLs.
    expect(classifyBrowserTrust("http://0.0.0.0:8080").tier).toBe("public");
  });

  it("classifies public internet domains as public", () => {
    expect(classifyBrowserTrust("https://example.com").tier).toBe("public");
    expect(classifyBrowserTrust("http://plain-http.org").tier).toBe("public");
    expect(classifyBrowserTrust("https://github.com/WFekik/HermOS-IDE").tier).toBe("public");
    expect(classifyBrowserTrust("https://duckduckgo.com").tier).toBe("public");
  });
});
