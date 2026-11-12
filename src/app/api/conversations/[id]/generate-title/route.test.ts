import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { fetchWithSsrf } from "@/lib/ai/ssrf-fetch";

vi.mock("@/lib/session", () => ({
  requireUser: vi.fn(),
}));

vi.mock("@/lib/rate-limit", () => ({
  withRateLimit: vi.fn().mockResolvedValue(null),
  getClientIp: vi.fn().mockReturnValue("127.0.0.1"),
}));

vi.mock("@/lib/ai/ssrf-fetch", () => ({
  fetchWithSsrf: vi.fn(),
}));

vi.mock("@/lib/encryption", () => ({
  decrypt: vi.fn((val: string) => `decrypted-${val}`),
}));

describe("POST /api/conversations/[id]/generate-title", () => {
  const mockUser = { id: "user-123", email: "test@hermos.io" };
  const mockConversation = {
    id: "conv-abc",
    userId: "user-123",
    title: "New conversation",
    provider: "ollama",
    model: "llama3.2",
  };
  let updateSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireUser).mockResolvedValue(mockUser as any);
    updateSpy = vi.spyOn(db.conversation, "update").mockResolvedValue({} as any);
  });

  it("returns current title when conversation already has a custom title", async () => {
    vi.spyOn(db.conversation, "findUnique").mockResolvedValue({
      ...mockConversation,
      title: "Existing Custom Title",
    } as any);

    const req = new NextRequest("http://localhost/api/conversations/conv-abc/generate-title", {
      method: "POST",
    });
    const res = await POST(req, { params: Promise.resolve({ id: "conv-abc" }) });
    const json = await res.json();

    expect(json.title).toBe("Existing Custom Title");
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("regenerates title when body has { force: true } even if conversation has an existing title", async () => {
    vi.spyOn(db.conversation, "findUnique").mockResolvedValue({
      ...mockConversation,
      title: "Old Custom Title",
    } as any);
    vi.spyOn(db.message, "findMany").mockResolvedValue([
      { role: "user", content: "Let's build a new authentication system with passkeys." },
    ] as any);
    vi.spyOn(db.message, "findFirst").mockResolvedValue(null);
    vi.spyOn(db.providerKey, "findUnique").mockResolvedValue(null);

    vi.mocked(fetchWithSsrf).mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({
        choices: [{ message: { content: "Passkey Authentication Setup" } }],
      }),
    } as any);

    const req = new NextRequest("http://localhost/api/conversations/conv-abc/generate-title", {
      method: "POST",
      body: JSON.stringify({ force: true }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: "conv-abc" }) });
    const json = await res.json();

    expect(json.title).toBe("Passkey Authentication Setup");
    expect(updateSpy).toHaveBeenCalledWith({
      where: { id: "conv-abc" },
      data: expect.objectContaining({ title: "Passkey Authentication Setup" }),
    });
  });

  it("returns 'New conversation' without calling LLM when message history is empty", async () => {
    vi.spyOn(db.conversation, "findUnique").mockResolvedValue(mockConversation as any);
    vi.spyOn(db.message, "findMany").mockResolvedValue([]);

    const req = new NextRequest("http://localhost/api/conversations/conv-abc/generate-title", {
      method: "POST",
    });
    const res = await POST(req, { params: Promise.resolve({ id: "conv-abc" }) });
    const json = await res.json();

    expect(json.title).toBe("New conversation");
    expect(fetchWithSsrf).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("generates title for keyless local models (Ollama) even when providerKey row has no encryptedKey", async () => {
    vi.spyOn(db.conversation, "findUnique").mockResolvedValue(mockConversation as any);
    vi.spyOn(db.message, "findMany").mockResolvedValue([
      { role: "user", content: "Can you fix the local models compaction bug in ollama?" },
      { role: "assistant", content: "I will look into it." },
    ] as any);
    vi.spyOn(db.message, "findFirst").mockResolvedValue({
      provider: "ollama",
      model: "llama3.2",
    } as any);
    vi.spyOn(db.providerKey, "findUnique").mockResolvedValue(null);

    vi.mocked(fetchWithSsrf).mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({
        choices: [{ message: { content: "Fix Ollama Compaction Bug" } }],
      }),
    } as any);

    const req = new NextRequest("http://localhost/api/conversations/conv-abc/generate-title", {
      method: "POST",
    });
    const res = await POST(req, { params: Promise.resolve({ id: "conv-abc" }) });
    const json = await res.json();

    expect(json.title).toBe("Fix Ollama Compaction Bug");
    expect(updateSpy).toHaveBeenCalledWith({
      where: { id: "conv-abc" },
      data: expect.objectContaining({ title: "Fix Ollama Compaction Bug" }),
    });
  });

  it("cleans reasoning model think tags <think>...</think> from title response", async () => {
    vi.spyOn(db.conversation, "findUnique").mockResolvedValue(mockConversation as any);
    vi.spyOn(db.message, "findMany").mockResolvedValue([
      { role: "user", content: "How do I optimize database queries in postgres?" },
    ] as any);
    vi.spyOn(db.message, "findFirst").mockResolvedValue(null);
    vi.spyOn(db.providerKey, "findUnique").mockResolvedValue(null);

    vi.mocked(fetchWithSsrf).mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({
        choices: [{
          message: {
            content: "<think>The user wants to optimize postgres queries.</think>Optimize Postgres Queries",
          },
        }],
      }),
    } as any);

    const req = new NextRequest("http://localhost/api/conversations/conv-abc/generate-title", {
      method: "POST",
    });
    const res = await POST(req, { params: Promise.resolve({ id: "conv-abc" }) });
    const json = await res.json();

    expect(json.title).toBe("Optimize Postgres Queries");
  });

  it("uses Anthropic /messages format when provider is anthropic", async () => {
    vi.spyOn(db.conversation, "findUnique").mockResolvedValue({
      ...mockConversation,
      provider: "anthropic",
      model: "claude-3-5-sonnet",
    } as any);
    vi.spyOn(db.message, "findMany").mockResolvedValue([
      { role: "user", content: "Implement OAuth2 login with Github" },
    ] as any);
    vi.spyOn(db.message, "findFirst").mockResolvedValue(null);
    vi.spyOn(db.providerKey, "findUnique").mockResolvedValue({
      isActive: true,
      encryptedKey: "secret-key",
      baseUrl: "https://api.anthropic.com/v1",
    } as any);

    vi.mocked(fetchWithSsrf).mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ type: "text", text: "GitHub OAuth2 Implementation" }],
      }),
    } as any);

    const req = new NextRequest("http://localhost/api/conversations/conv-abc/generate-title", {
      method: "POST",
    });
    const res = await POST(req, { params: Promise.resolve({ id: "conv-abc" }) });
    const json = await res.json();

    expect(fetchWithSsrf).toHaveBeenCalledWith(
      "https://api.anthropic.com/v1/messages",
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-api-key": "decrypted-secret-key",
          "anthropic-version": "2023-06-01",
        }),
      }),
    );
    expect(json.title).toBe("GitHub OAuth2 Implementation");
  });

  it("falls back gracefully to cleanHeuristicTitle and persists it when LLM call fails", async () => {
    vi.spyOn(db.conversation, "findUnique").mockResolvedValue(mockConversation as any);
    vi.spyOn(db.message, "findMany").mockResolvedValue([
      { role: "user", content: "Can you help me design a landing page for my SaaS?" },
    ] as any);
    vi.spyOn(db.message, "findFirst").mockResolvedValue(null);
    vi.spyOn(db.providerKey, "findUnique").mockResolvedValue(null);

    vi.mocked(fetchWithSsrf).mockRejectedValue(new Error("Connection refused: 127.0.0.1:11434"));

    const req = new NextRequest("http://localhost/api/conversations/conv-abc/generate-title", {
      method: "POST",
    });
    const res = await POST(req, { params: Promise.resolve({ id: "conv-abc" }) });
    const json = await res.json();

    expect(json.title).toBe("Design A Landing Page");
    expect(updateSpy).toHaveBeenCalledWith({
      where: { id: "conv-abc" },
      data: expect.objectContaining({ title: "Design A Landing Page" }),
    });
  });
});
