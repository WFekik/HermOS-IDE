import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  browserOpen,
  getBrowserSession,
  browserClose,
  browserSnapshot,
} from "./browser";

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
});
