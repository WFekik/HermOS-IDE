import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET } from "./route";
import { NextRequest } from "next/server";

vi.mock("@/lib/session", () => ({
  requireUser: vi.fn().mockResolvedValue({ id: "test-user", role: "user" }),
}));

vi.mock("@/lib/rate-limit", () => ({
  withRateLimit: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/ssrf", () => ({
  checkUrlHost: vi.fn().mockResolvedValue(null),
  getSsrfDispatcher: vi.fn().mockReturnValue(undefined),
}));

describe("GET /api/browser/proxy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("proxies HTML target and rewrites relative stylesheets and scripts", async () => {
    const mockHtml = `<!DOCTYPE html><html><head><link rel="stylesheet" href="/styles.css"><script src="//cdn.example.com/app.js"></script></head><body><h1>Hello</h1><img src="banner.png"></body></html>`;

    // Mock global fetch
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
      text: vi.fn().mockResolvedValue(mockHtml),
      body: { cancel: vi.fn() },
    });
    vi.stubGlobal("fetch", mockFetch);

    const req = new NextRequest("http://127.0.0.1:3000/api/browser/proxy?url=https://example.com/docs/page");
    const res = await GET(req);

    expect(res.status).toBe(200);
    const body = await res.text();

    // 1. Checks base tag injection
    expect(body).toContain('<base href="https://example.com/docs/page">');
    expect(body).toContain('<meta name="referrer" content="no-referrer">');

    // 2. Checks stylesheet absolute URL conversion
    expect(body).toContain('href="https://example.com/styles.css"');

    // 3. Checks protocol-relative conversion
    expect(body).toContain('src="https://cdn.example.com/app.js"');

    // 4. Checks image conversion
    expect(body).toContain('src="https://example.com/docs/banner.png"');

    // 5. Checks sandboxed CSP header includes permissive subresource directives
    const csp = res.headers.get("content-security-policy");
    expect(csp).toContain("sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads");
    expect(csp).toContain("style-src * 'unsafe-inline' data: blob:");
    expect(csp).toContain("font-src * data: blob:");

    vi.unstubAllGlobals();
  });

  it("rejects non-http/https URLs", async () => {
    const req = new NextRequest("http://127.0.0.1:3000/api/browser/proxy?url=javascript:alert(1)");
    const res = await GET(req);
    expect(res.status).toBe(400);
  });
});
