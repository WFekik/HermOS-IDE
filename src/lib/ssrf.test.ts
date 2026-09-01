import { describe, it, expect, vi, afterEach } from "vitest";
import type * as SsrfModule from "./ssrf";

vi.mock("dns/promises", () => ({
  lookup: vi.fn(async (host: string) => {
    if (host === "example.com") {
      return [{ address: "93.184.216.34", family: 4 }];
    }
    if (host === "internal.local") {
      return [{ address: "127.0.0.1", family: 4 }];
    }
    if (host === "mixed.local") {
      return [
        { address: "93.184.216.34", family: 4 },
        { address: "10.0.0.5", family: 4 },
      ];
    }
    const err = new Error("ENOTFOUND") as NodeJS.ErrnoException;
    err.code = "ENOTFOUND";
    throw err;
  }),
}));

async function loadSsrf(mode: "strict" | "default" | "lenient"): Promise<typeof SsrfModule> {
  vi.resetModules();
  const env = mode === "strict" ? "true" : mode === "lenient" ? "false" : "";
  vi.stubEnv("SSRF_BLOCK_PRIVATE", env);
  return import("./ssrf");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("parseIpv4Literal", () => {
  it("normalizes plain dotted quads", async () => {
    const m = await loadSsrf("lenient");
    expect(m.parseIpv4Literal("127.0.0.1")).toBe("127.0.0.1");
    expect(m.parseIpv4Literal("169.254.169.254")).toBe("169.254.169.254");
    expect(m.parseIpv4Literal("255.255.255.255")).toBe("255.255.255.255");
  });

  it("normalizes decimal / hex / octal single-number encodings", async () => {
    const m = await loadSsrf("lenient");
    expect(m.parseIpv4Literal("2130706433")).toBe("127.0.0.1");
    expect(m.parseIpv4Literal("0x7f000001")).toBe("127.0.0.1");
    expect(m.parseIpv4Literal("017700000001")).toBe("127.0.0.1");
  });

  it("normalizes short-dotted and per-part encoded forms", async () => {
    const m = await loadSsrf("lenient");
    expect(m.parseIpv4Literal("127.1")).toBe("127.0.0.1");
    expect(m.parseIpv4Literal("0177.0.0.1")).toBe("127.0.0.1");
    expect(m.parseIpv4Literal("0xa9fea9fe")).toBe("169.254.169.254");
    expect(m.parseIpv4Literal("127.0.0.1.")).toBe("127.0.0.1");
  });

  it("rejects non-IP hosts and malformed literals", async () => {
    const m = await loadSsrf("lenient");
    expect(m.parseIpv4Literal("example.com")).toBeNull();
    expect(m.parseIpv4Literal("999.1.1.1")).toBeNull();
    expect(m.parseIpv4Literal("1.2.3.4.5")).toBeNull();
    expect(m.parseIpv4Literal("1.2.3")).toBe("1.2.0.3");
  });
});

describe("classifyIpv6", () => {
  it("classifies loopback, unspecified, and mapped forms", async () => {
    const m = await loadSsrf("lenient");
    expect(m.classifyIpv6("::1")).toBe("loopback");
    expect(m.classifyIpv6("[0:0:0:0:0:0:0:1]")).toBe("loopback");
    expect(m.classifyIpv6("::")).toBe("unspecified");
    expect(m.classifyIpv6("::ffff:127.0.0.1")).toBe("loopback");
    expect(m.classifyIpv6("::ffff:7f00:1")).toBe("loopback");
    expect(m.classifyIpv6("0:0:0:0:0:ffff:169.254.169.254")).toBe("linklocal");
  });

  it("classifies link-local, ULA, and site-local prefixes", async () => {
    const m = await loadSsrf("lenient");
    expect(m.classifyIpv6("fe80::1")).toBe("linklocal");
    expect(m.classifyIpv6("fc00::1")).toBe("private");
    expect(m.classifyIpv6("fd12:3456::1")).toBe("private");
    expect(m.classifyIpv6("fec0::1")).toBe("private");
    expect(m.classifyIpv6("2606:4700::1")).toBe("public");
  });
});

describe("checkUrlHost — default mode (fail-closed, local-AI allowlist)", () => {
  it("always blocks link-local / cloud metadata targets", async () => {
    const m = await loadSsrf("default");
    expect(await m.checkUrlHost("http://169.254.169.254/latest/meta-data/iam/")).toMatch(/link-local|metadata/);
    expect(await m.checkUrlHost("http://169.254.169.253/")).toMatch(/link-local|metadata/);
    expect(await m.checkUrlHost("http://[fe80::1]/")).toMatch(/link-local|metadata/);
    expect(await m.checkUrlHost("http://[::ffff:169.254.169.254]/")).toMatch(/link-local|metadata/);
    expect(await m.checkUrlHost("http://169.254.169.254./")).toMatch(/link-local|metadata/);
    expect(await m.checkUrlHost("http://0xa9fea9fe/")).toMatch(/link-local|metadata/);
  });

  it("always blocks non-http(s) schemes", async () => {
    const m = await loadSsrf("default");
    expect(await m.checkUrlHost("file:///etc/passwd")).toMatch(/Only http\(s\)/);
    expect(await m.checkUrlHost("gopher://127.0.0.1:70/")).toMatch(/Only http\(s\)/);
    expect(await m.checkUrlHost("javascript://alert(1)")).toMatch(/Only http\(s\)/);
    expect(await m.checkUrlHost("ftp://169.254.169.254/")).toMatch(/Only http\(s\)/);
    expect(await m.checkUrlHost("data:text/html,x")).toMatch(/Only http\(s\)/);
    expect(await m.checkUrlHost("//169.254.169.254/")).toMatch(/Invalid URL/);
  });

  it("allows the local-AI allowlist (localhost / 127.0.0.1 / ::1 / 0.0.0.0 + mapped forms)", async () => {
    const m = await loadSsrf("default");
    expect(await m.checkUrlHost("http://127.0.0.1:3000/")).toBeNull();
    expect(await m.checkUrlHost("http://localhost/")).toBeNull();
    expect(await m.checkUrlHost("http://localhost:11434/")).toBeNull();
    expect(await m.checkUrlHost("http://[::1]/")).toBeNull();
    expect(await m.checkUrlHost("http://[::1]:11434/")).toBeNull();
    expect(await m.checkUrlHost("http://0.0.0.0/")).toBeNull();
    expect(await m.checkUrlHost("http://[::ffff:127.0.0.1]/")).toBeNull();
    expect(await m.checkUrlHost("http://[::ffff:7f00:1]/")).toBeNull();
  });

  it("blocks unapproved loopback ports (e.g. redis, postgres, ssh)", async () => {
    const m = await loadSsrf("default");
    expect(await m.checkUrlHost("http://127.0.0.1:6379/")).toMatch(/blocked/);
    expect(await m.checkUrlHost("http://localhost:22/")).toMatch(/blocked/);
    expect(await m.checkUrlHost("http://127.0.0.1:5432/")).toMatch(/blocked/);
  });

  it("blocks RFC1918 and other loopback-adjacent ranges by default", async () => {
    const m = await loadSsrf("default");
    expect(await m.checkUrlHost("http://10.0.0.5/")).toMatch(/private\/internal/);
    expect(await m.checkUrlHost("http://192.168.1.1/")).toMatch(/private\/internal/);
    expect(await m.checkUrlHost("http://172.16.0.1/")).toMatch(/private\/internal/);
    expect(await m.checkUrlHost("http://[fc00::1]/")).toMatch(/private\/internal/);
    expect(await m.checkUrlHost("http://[::ffff:10.0.0.5]/")).toMatch(/private\/internal/);
  });

  it("catches encoded loopback literals and grants them allowlist access", async () => {
    const m = await loadSsrf("default");
    expect(await m.checkUrlHost("http://2130706433/")).toBeNull();
    expect(await m.checkUrlHost("http://0x7f000001/")).toBeNull();
    expect(await m.checkUrlHost("http://0177.0.0.1/")).toBeNull();
    expect(await m.checkUrlHost("http://127.1/")).toBeNull();
  });

  it("resolves hostnames via DNS; arbitrary names resolving to loopback stay blocked", async () => {
    const m = await loadSsrf("default");
    expect(await m.checkUrlHost("http://example.com/")).toBeNull();
    // `internal.local` resolves to 127.0.0.1 but is NOT an allowlisted name —
    // DNS-rebinding protection keeps it refused under the default policy.
    expect(await m.checkUrlHost("http://internal.local/")).toMatch(/private\/internal/);
  });
});

describe("checkUrlHost — lenient mode (SSRF_BLOCK_PRIVATE=false)", () => {
  it("allows loopback and RFC1918", async () => {
    const m = await loadSsrf("lenient");
    expect(await m.checkUrlHost("http://127.0.0.1:3000/")).toBeNull();
    expect(await m.checkUrlHost("http://localhost/")).toBeNull();
    expect(await m.checkUrlHost("http://[::1]/")).toBeNull();
    expect(await m.checkUrlHost("http://10.0.0.5/")).toBeNull();
    expect(await m.checkUrlHost("http://192.168.1.1/")).toBeNull();
    expect(await m.checkUrlHost("http://172.16.0.1/")).toBeNull();
    expect(await m.checkUrlHost("http://internal.local/")).toBeNull();
  });

  it("catches encoded loopback literals", async () => {
    const m = await loadSsrf("lenient");
    expect(await m.checkUrlHost("http://2130706433/")).toBeNull();
    expect(await m.checkUrlHost("http://0x7f000001/")).toBeNull();
    expect(await m.checkUrlHost("http://0177.0.0.1/")).toBeNull();
    expect(await m.checkUrlHost("http://127.1/")).toBeNull();
    expect(await m.checkUrlHost("http://[::ffff:7f00:1]/")).toBeNull();
  });

  it("resolves hostnames via DNS", async () => {
    const m = await loadSsrf("lenient");
    expect(await m.checkUrlHost("http://example.com/")).toBeNull();
    expect(await m.checkUrlHost("http://internal.local/")).toBeNull();
  });
});

describe("checkUrlHost — strict mode (SSRF_BLOCK_PRIVATE=true)", () => {
  it("blocks RFC1918 but keeps the local-AI allowlist reachable", async () => {
    const m = await loadSsrf("strict");
    expect(await m.checkUrlHost("http://127.0.0.1:3000/")).toBeNull();
    expect(await m.checkUrlHost("http://localhost/")).toBeNull();
    expect(await m.checkUrlHost("http://[::1]/")).toBeNull();
    expect(await m.checkUrlHost("http://2130706433/")).toBeNull();
    expect(await m.checkUrlHost("http://10.0.0.5/")).toMatch(/private\/internal/);
    expect(await m.checkUrlHost("http://192.168.1.1/")).toMatch(/private\/internal/);
    expect(await m.checkUrlHost("http://172.31.0.1/")).toMatch(/private\/internal/);
    expect(await m.checkUrlHost("http://[fc00::1]/")).toMatch(/private\/internal/);
    expect(await m.checkUrlHost("http://internal.local/")).toMatch(/private\/internal/);
  });

  it("still blocks metadata and still allows public hosts", async () => {
    const m = await loadSsrf("strict");
    expect(await m.checkUrlHost("http://169.254.169.254/")).toMatch(/link-local|metadata/);
    expect(await m.checkUrlHost("http://[fe80::1]/")).toMatch(/link-local|metadata/);
    expect(await m.checkUrlHost("http://example.com/")).toBeNull();
    expect(await m.checkUrlHost("http://93.184.216.34/")).toBeNull();
  });

  it("blocks hostnames that resolve to any private address", async () => {
    const m = await loadSsrf("strict");
    expect(await m.checkUrlHost("http://mixed.local/")).toMatch(/private\/internal/);
  });
});
