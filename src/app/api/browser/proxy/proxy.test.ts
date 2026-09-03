import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET, toAbsoluteUrl, rewriteHtmlUrls, injectBaseTag, rewriteSrcset } from "./route";
import { PROXY_CSP } from "@/lib/csp";
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

describe("toAbsoluteUrl (company-grade scheme hardening)", () => {
  const base = "https://example.com/docs/page";
  it("blocks case-variant executable schemes", () => {
    expect(toAbsoluteUrl("JaVaScRiPt:alert(1)", base)).toBe("#");
    expect(toAbsoluteUrl("VBScripT:msgbox(1)", base)).toBe("#");
    expect(toAbsoluteUrl("FILE:///etc/passwd", base)).toBe("#");
    expect(toAbsoluteUrl("  javascript:evil()  ", base)).toBe("#");
  });
  it("preserves data/blob/fragment passthrough", () => {
    expect(toAbsoluteUrl("data:image/png;base64,AAA", base)).toBe("data:image/png;base64,AAA");
    expect(toAbsoluteUrl("blob:https://x/y", base)).toBe("blob:https://x/y");
    expect(toAbsoluteUrl("#section", base)).toBe("#section");
  });
  it("resolves protocol-relative with base scheme", () => {
    expect(toAbsoluteUrl("//cdn.example.com/a.js", base)).toBe("https://cdn.example.com/a.js");
    expect(toAbsoluteUrl("//cdn.example.com/a.js", "http://example.com/")).toBe(
      "http://cdn.example.com/a.js",
    );
  });
});

describe("rewriteHtmlUrls (comprehensive coverage)", () => {
  const base = "https://example.com/docs/page";
  it("rewrites unquoted attrs, srcset, poster, form action, object data", () => {
    const html = [
      "<script src=/x.js></script>",
      '<img srcset="/a.png 1x, /b.png 2x">',
      '<video poster="thumb.jpg" src="/v.mp4"></video>',
      '<form action="/submit"></form>',
      '<object data="/o.swf"></object>',
      '<a href="/docs">x</a>',
    ].join("");
    const out = rewriteHtmlUrls(html, base);
    expect(out).toContain('src="https://example.com/x.js"');
    expect(out).toContain("https://example.com/a.png 1x, https://example.com/b.png 2x");
    expect(out).toContain('poster="https://example.com/docs/thumb.jpg"');
    expect(out).toContain('action="https://example.com/submit"');
    expect(out).toContain('data="https://example.com/o.swf"');
    expect(out).toContain('href="https://example.com/docs"');
  });
  it("neutralizes javascript: hrefs instead of re-emitting", () => {
    const out = rewriteHtmlUrls('<a href="JaVaScRiPt:alert(1)">x</a>', base);
    expect(out).not.toContain("javascript:");
    expect(out).toContain('href="#"');
  });
  it("rewriteSrcset preserves descriptors", () => {
    expect(rewriteSrcset("/a.png 400w, /b.png 800w", base)).toBe(
      "https://example.com/a.png 400w, https://example.com/b.png 800w",
    );
  });
});

describe("injectBaseTag (no quirks mode)", () => {
  const url = "https://example.com/docs/page";
  it("inserts after <html> when <head> missing", () => {
    const out = injectBaseTag("<!DOCTYPE html><html><body>hi</body></html>", url);
    expect(out.indexOf("<!DOCTYPE html>")).toBe(0);
    expect(out).toContain("<html><base href=");
  });
  it("inserts after doctype when html/head missing", () => {
    const out = injectBaseTag("<!DOCTYPE html><body>hi</body>", url);
    expect(out.indexOf("<!DOCTYPE html><base")).toBe(0);
  });
});

describe("PROXY_CSP single source of truth", () => {
  it("route CSP equals shared constant", async () => {
    const mockHtml = "<html><head></head><body>hi</body></html>";
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({ "content-type": "text/html" }),
      text: vi.fn().mockResolvedValue(mockHtml),
      body: { cancel: vi.fn() },
    });
    vi.stubGlobal("fetch", mockFetch);
    const req = new NextRequest("http://127.0.0.1:3000/api/browser/proxy?url=https://example.com/");
    const res = await GET(req);
    expect(res.headers.get("content-security-policy")).toBe(PROXY_CSP);
    vi.unstubAllGlobals();
  });
});
