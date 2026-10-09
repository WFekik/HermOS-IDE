import { describe, it, expect } from "vitest";
import {
  classifyBrowserTrust,
  sandboxForTier,
  isTrustedLoopbackBrowserOpen,
} from "./browser-trust";

describe("classifyBrowserTrust", () => {
  it("trusts canonical loopback literals", () => {
    for (const url of [
      "http://localhost:3000",
      "http://localhost/",
      "https://localhost:11434/x",
      "http://127.0.0.1:5173",
      "http://127.12.34.56/",
      "http://[::1]:3000/",
      "http://app.localhost:3000/",
      "http://LOCALHOST:3000",
      "http://localhost./",
    ]) {
      expect(classifyBrowserTrust(url).tier, url).toBe("trusted-loopback");
    }
  });

  it("treats unspecified addresses and invalid octets as public", () => {
    for (const url of [
      "http://0.0.0.0:8080/",
      "http://[::]/",
      "http://127.999.1.1/",
      "http://10.999.1.1/",
    ]) {
      expect(classifyBrowserTrust(url).tier, url).toBe("public");
    }
  });

  it("trusts hex/decimal/octal loopback spellings (URL-normalized to 127.0.0.1)", () => {
    // WHATWG URL parsing canonicalizes these to 127.0.0.1, so the
    // destination genuinely IS the user's machine — consistent with the
    // server-side SSRF normalizer. Trust follows the normalized host.
    for (const url of [
      "http://0x7f.0.0.1/",
      "http://2130706433/",
      "http://0177.0.0.1/",
    ]) {
      expect(classifyBrowserTrust(url).tier, url).toBe("trusted-loopback");
    }
  });

  it("stays conservative on mapped IPv6 loopback (permission prompt, still SSRF-gated)", () => {
    expect(classifyBrowserTrust("http://[::ffff:127.0.0.1]/").tier).not.toBe(
      "trusted-loopback",
    );
  });

  it("classifies LAN/private/mDNS/single-label hosts as local-network", () => {
    for (const url of [
      "http://192.168.1.10:8080",
      "http://10.0.0.5:3000",
      "http://172.20.0.2:3000",
      "http://printer.local/",
      "http://nas.lan:5000",
      "http://api.internal/",
      "http://vite-app:5173/page",
      "http://my-dev-box:3000",
    ]) {
      expect(classifyBrowserTrust(url).tier, url).toBe("local-network");
    }
  });

  it("classifies public targets as public", () => {
    for (const url of [
      "https://example.com",
      "https://github.com/WFekik/HermOS-IDE",
      "http://93.184.216.34/",
      "http://8.8.8.8/",
      "http://169.254.169.254/latest/meta-data",
      "https://duckduckgo.com/?q=hello",
      "ftp://example.com/x",
      "not a url",
      "",
    ]) {
      expect(classifyBrowserTrust(url).tier, url).toBe("public");
    }
  });

  it("extracts host and effective port", () => {
    expect(classifyBrowserTrust("http://localhost:3000/x")).toMatchObject({
      host: "localhost",
      port: 3000,
    });
    expect(classifyBrowserTrust("https://example.com/x")).toMatchObject({
      host: "example.com",
      port: 443,
    });
    expect(classifyBrowserTrust("http://example.com/x")).toMatchObject({
      port: 80,
    });
  });
});

describe("sandboxForTier", () => {
  it("never allows top-navigation or downloads in any tier", () => {
    for (const tier of ["trusted-loopback", "local-network", "public"] as const) {
      const sb = sandboxForTier(tier);
      expect(sb).not.toContain("allow-top-navigation");
      expect(sb).not.toContain("allow-downloads");
      expect(sb).toContain("allow-scripts");
    }
  });

  it("keeps same-origin for local tiers (dev apps work) and drops it for public (opaque origin)", () => {
    expect(sandboxForTier("trusted-loopback")).toContain("allow-same-origin");
    expect(sandboxForTier("local-network")).toContain("allow-same-origin");
    expect(sandboxForTier("public")).not.toContain("allow-same-origin");
  });
});

describe("isTrustedLoopbackBrowserOpen", () => {
  it("exempts only browser_open on loopback", () => {
    expect(
      isTrustedLoopbackBrowserOpen("browser_open", { url: "http://localhost:3000" }),
    ).toBe(true);
    expect(
      isTrustedLoopbackBrowserOpen("browser_open", { url: "http://127.0.0.1:5173/x" }),
    ).toBe(true);
    expect(
      isTrustedLoopbackBrowserOpen("browser_open", { url: "https://example.com" }),
    ).toBe(false);
    expect(
      isTrustedLoopbackBrowserOpen("browser_open", { url: "http://192.168.1.1/" }),
    ).toBe(false);
    expect(
      isTrustedLoopbackBrowserOpen("browser_click", { ref: "@e1" }),
    ).toBe(false);
    expect(isTrustedLoopbackBrowserOpen("browser_open", {})).toBe(false);
    expect(isTrustedLoopbackBrowserOpen("browser_open", null)).toBe(false);
  });
});
