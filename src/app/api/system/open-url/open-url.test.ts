import { describe, it, expect, vi, beforeEach } from "vitest";
import { POST } from "./route";
import { NextRequest } from "next/server";

vi.mock("@/lib/session", () => ({
  requireUser: vi.fn().mockResolvedValue({ id: "test-user", role: "user" }),
}));

vi.mock("@/lib/rate-limit", () => ({
  withRateLimit: vi.fn().mockResolvedValue(null),
}));

vi.mock("child_process", () => ({
  spawn: vi.fn().mockReturnValue({ unref: vi.fn() }),
}));

describe("POST /api/system/open-url", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("successfully validates and allows valid https URLs", async () => {
    const req = new NextRequest("http://127.0.0.1:3000/api/system/open-url", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://github.com/WFekik/HermOS-IDE" }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("rejects non-http/https schemes like javascript: and file:", async () => {
    const req = new NextRequest("http://127.0.0.1:3000/api/system/open-url", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "javascript:alert(1)" }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Disallowed URL scheme");
  });

  it("rejects URLs containing control characters or newlines", async () => {
    const req = new NextRequest("http://127.0.0.1:3000/api/system/open-url", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com\r\nmalicious" }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("rejects missing or empty url body", async () => {
    const req = new NextRequest("http://127.0.0.1:3000/api/system/open-url", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});
