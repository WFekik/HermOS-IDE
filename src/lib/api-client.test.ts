import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// We test through the public API using mocked fetch
const originalFetch = globalThis.fetch;

describe("API Client", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    globalThis.fetch = mockFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe("apiGet", () => {
    it("should make a GET request with correct headers", async () => {
      mockFetch.mockResolvedValue(new Response(JSON.stringify({ data: "ok" }), { status: 200 }));
      const { apiGet } = await import("./api-client");
      const result = await apiGet("/api/test");
      expect(result).toEqual({ data: "ok" });
      expect(mockFetch).toHaveBeenCalledWith(
        "/api/test",
        expect.objectContaining({
          method: "GET",
          headers: { Accept: "application/json" },
          credentials: "include",
        }),
      );
    });

    it("should append query parameters", async () => {
      mockFetch.mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));
      const { apiGet } = await import("./api-client");
      await apiGet("/api/search", { query: { q: "test", page: 1 } });
      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain("q=test");
      expect(url).toContain("page=1");
    });

    it("should skip undefined query values", async () => {
      mockFetch.mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));
      const { apiGet } = await import("./api-client");
      await apiGet("/api/search", { query: { q: "test", skip: undefined } });
      const url = mockFetch.mock.calls[0][0];
      expect(url).not.toContain("skip=");
    });

    it("should handle array query parameters", async () => {
      mockFetch.mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));
      const { apiGet } = await import("./api-client");
      await apiGet("/api/filter", { query: { ids: ["1", "2", "3"] } });
      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain("ids=1&ids=2&ids=3");
    });
  });

  describe("apiPost", () => {
    it("should make a POST request with JSON body", async () => {
      mockFetch.mockResolvedValue(new Response(JSON.stringify({ id: "new" }), { status: 200 }));
      const { apiPost } = await import("./api-client");
      const body = { name: "test" };
      const result = await apiPost("/api/create", body);
      expect(result).toEqual({ id: "new" });
      expect(mockFetch).toHaveBeenCalledWith(
        "/api/create",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "Content-Type": "application/json",
          }),
          body: JSON.stringify(body),
        }),
      );
    });

    it("should make POST request without body", async () => {
      mockFetch.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      const { apiPost } = await import("./api-client");
      await apiPost("/api/action");
      expect(mockFetch).toHaveBeenCalledWith(
        "/api/action",
        expect.objectContaining({
          method: "POST",
          body: undefined,
        }),
      );
    });
  });

  describe("apiPatch", () => {
    it("should make a PATCH request with JSON body", async () => {
      mockFetch.mockResolvedValue(new Response(JSON.stringify({ updated: true }), { status: 200 }));
      const { apiPatch } = await import("./api-client");
      await apiPatch("/api/item/1", { title: "new" });
      expect(mockFetch).toHaveBeenCalledWith(
        "/api/item/1",
        expect.objectContaining({ method: "PATCH" }),
      );
    });
  });

  describe("apiDelete", () => {
    it("should make a DELETE request", async () => {
      mockFetch.mockResolvedValue(new Response(JSON.stringify({ deleted: true }), { status: 200 }));
      const { apiDelete } = await import("./api-client");
      await apiDelete("/api/item/1");
      expect(mockFetch).toHaveBeenCalledWith(
        "/api/item/1",
        expect.objectContaining({ method: "DELETE" }),
      );
    });
  });

  describe("apiStream", () => {
    it("should return the response for SSE streaming", async () => {
      const body = new ReadableStream();
      mockFetch.mockResolvedValue(new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } }));
      const { apiStream } = await import("./api-client");
      const res = await apiStream("/api/stream", { prompt: "hello" });
      expect(res.ok).toBe(true);
      expect(res.body).toBeDefined();
    });

    it("should throw on non-ok response", async () => {
      mockFetch.mockResolvedValue(new Response(null, { status: 500 }));
      const { apiStream, ApiRequestError } = await import("./api-client");
      await expect(apiStream("/api/stream", {})).rejects.toThrow(ApiRequestError);
    });
  });

  describe("error handling", () => {
    it("should throw ApiRequestError on error envelope in response", async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ error: "Not found", code: "NOT_FOUND" }), { status: 404 }),
      );
      const { apiGet, ApiRequestError } = await import("./api-client");
      try {
        await apiGet("/api/missing");
        expect.fail("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(ApiRequestError);
        expect((e as ApiRequestError).message).toBe("Not found");
        expect((e as ApiRequestError).code).toBe("NOT_FOUND");
        expect((e as ApiRequestError).status).toBe(404);
      }
    });

    it("should throw on invalid JSON response", async () => {
      mockFetch.mockResolvedValue(new Response("not json", { status: 200 }));
      const { apiGet, ApiRequestError } = await import("./api-client");
      try {
        await apiGet("/api/test");
        expect.fail("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(ApiRequestError);
        expect((e as ApiRequestError).message).toContain("Invalid JSON");
      }
    });

    it("should return undefined for empty response body", async () => {
      mockFetch.mockResolvedValue(new Response(null, { status: 204 }));
      const { apiGet } = await import("./api-client");
      const result = await apiGet("/api/no-content");
      expect(result).toBeUndefined();
    });
  });

  describe("withQuery helper", () => {
    it("should build correct query strings", async () => {
      // Test withQuery indirectly through apiGet
      mockFetch.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
      const { apiGet } = await import("./api-client");
      await apiGet("/api/items", { query: { limit: "10", offset: "0" } });
      const url = mockFetch.mock.calls[0][0];
      expect(url).toBe("/api/items?limit=10&offset=0");
    });
  });
});
