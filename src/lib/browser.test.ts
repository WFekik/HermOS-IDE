import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  browserOpen,
  getBrowserSession,
  browserClose,
  browserSnapshot,
} from "./browser";
import { normalizeBrowserUrl, isLocalOrPrivateUrl } from "@/components/browser/types";

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
    const seen = getBrowserSession("user_A");
    expect(seen).not.toBeNull();
    expect(seen!.url).toBe("https://example.com");
    expect(seen!.title).toBe("Mock Page Title");

    // Snapshot reads hit the same shared session too.
    const snap = await browserSnapshot("user_A");
    expect(snap.ok).toBe(true);

    await browserClose("user_A");
    expect(getBrowserSession("user_A")).toBeNull();
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

  it("identifies localhost, loopback, and private LAN addresses as local", () => {
    expect(isLocalOrPrivateUrl("http://localhost:3000")).toBe(true);
    expect(isLocalOrPrivateUrl("http://127.0.0.1:5173")).toBe(true);
    expect(isLocalOrPrivateUrl("http://0.0.0.0:8080")).toBe(true);
    expect(isLocalOrPrivateUrl("http://[::1]:3000")).toBe(true);
    expect(isLocalOrPrivateUrl("http://192.168.1.50:3000")).toBe(true);
    expect(isLocalOrPrivateUrl("http://10.0.0.1:8000")).toBe(true);
    expect(isLocalOrPrivateUrl("http://172.16.0.5:3000")).toBe(true);
    expect(isLocalOrPrivateUrl("http://app.local:3000")).toBe(true);
    expect(isLocalOrPrivateUrl("http://site.localhost:3000")).toBe(true);
  });

  it("identifies public internet domains as non-local", () => {
    expect(isLocalOrPrivateUrl("https://example.com")).toBe(false);
    expect(isLocalOrPrivateUrl("http://plain-http.org")).toBe(false);
    expect(isLocalOrPrivateUrl("https://github.com/WFekik/HermOS-IDE")).toBe(false);
    expect(isLocalOrPrivateUrl("https://duckduckgo.com")).toBe(false);
  });
});
