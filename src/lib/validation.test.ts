import { describe, it, expect } from "vitest";
import {
  createConversationSchema,
  patchConversationSchema,
  chatRequestSchema,
  saveKeySchema,
  createMcpServerSchema,
  terminalSchema,
  createPluginSchema,
  togglePluginSchema,
  createPresetSchema,
  testProviderSchema,
  isAllowedAttachmentType,
  noNulBytes,
  providerIdSchema,
  agentModeSchema,
  mcpTransportSchema,
  shellSchema,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
} from "./validation";

describe("Validation Schemas — all schemas", () => {
  describe("chatRequestSchema", () => {
    it("should accept valid chat requests", () => {
      const r = chatRequestSchema.safeParse({
        conversationId: "conv-123",
        message: "Hello world",
        provider: "openai",
        model: "gpt-4",
      });
      expect(r.success).toBe(true);
    });

    it("should reject missing required fields", () => {
      expect(chatRequestSchema.safeParse({}).success).toBe(false);
    });

    it("should accept optional fields", () => {
      const r = chatRequestSchema.safeParse({
        conversationId: "conv-123",
        message: "Hello",
        provider: "anthropic",
        model: "claude-3",
        mode: "agent",
        temperature: 0.7,
        thinkingLevel: "medium",
        mcpServerIds: ["server-1"],
        enabledTools: ["read_file", "write_file"],
        attachmentIds: ["att-1"],
      });
      expect(r.success).toBe(true);
    });

    it("should reject temperature out of range", () => {
      const r = chatRequestSchema.safeParse({
        conversationId: "conv-123",
        message: "Hello",
        provider: "openai",
        model: "gpt-4",
        temperature: 3,
      });
      expect(r.success).toBe(false);
    });

    it("should reject invalid provider", () => {
      const r = chatRequestSchema.safeParse({
        conversationId: "conv-123",
        message: "Hello",
        provider: "unknown",
        model: "gpt-4",
      });
      expect(r.success).toBe(false);
    });

    it("should accept legacy thinking levels and normalize them to canonical", () => {
      const base = {
        conversationId: "conv-123",
        message: "Hello",
        provider: "openai",
        model: "gpt-4",
      };
      const disabled = chatRequestSchema.safeParse({ ...base, thinkingLevel: "disabled" });
      expect(disabled.success).toBe(true);
      if (disabled.success) expect(disabled.data.thinkingLevel).toBe("off");

      const def = chatRequestSchema.safeParse({ ...base, thinkingLevel: "default" });
      expect(def.success).toBe(true);
      if (def.success) expect(def.data.thinkingLevel).toBe("default");

      const enabled = chatRequestSchema.safeParse({ ...base, thinkingLevel: "enabled" });
      expect(enabled.success).toBe(true);
      if (enabled.success) expect(enabled.data.thinkingLevel).toBe("default");
    });

    it("should accept canonical thinking levels and keep them as-is", () => {
      const base = {
        conversationId: "conv-123",
        message: "Hello",
        provider: "openai",
        model: "gpt-4",
      };
      const high = chatRequestSchema.safeParse({ ...base, thinkingLevel: "high" });
      expect(high.success).toBe(true);
      if (high.success) expect(high.data.thinkingLevel).toBe("high");
    });

    it("should reject invalid thinking levels", () => {
      const r = chatRequestSchema.safeParse({
        conversationId: "conv-123",
        message: "Hello",
        provider: "openai",
        model: "gpt-4",
        thinkingLevel: "turbo",
      });
      expect(r.success).toBe(false);
    });
  });

  describe("saveKeySchema", () => {
    it("should accept valid key data", () => {
      const r = saveKeySchema.safeParse({
        provider: "openai",
        apiKey: "sk-abc123",
      });
      expect(r.success).toBe(true);
    });

    it("should accept optional baseUrl and models", () => {
      const r = saveKeySchema.safeParse({
        provider: "custom",
        apiKey: "key-123",
        baseUrl: "https://custom-api.example.com/v1",
        models: ["model-a", "model-b"],
      });
      expect(r.success).toBe(true);
    });

    it("should reject empty apiKey", () => {
      const r = saveKeySchema.safeParse({
        provider: "openai",
        apiKey: "",
      });
      expect(r.success).toBe(false);
    });
  });

  describe("createMcpServerSchema", () => {
    it("should accept stdio transport", () => {
      const r = createMcpServerSchema.safeParse({
        name: "filesystem",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem"],
      });
      expect(r.success).toBe(true);
    });

    it("should accept SSE transport with URL", () => {
      const r = createMcpServerSchema.safeParse({
        name: "remote-server",
        transport: "sse",
        url: "https://example.com/sse",
      });
      expect(r.success).toBe(true);
    });

    it("should reject streamable-http transport (not supported yet)", () => {
      const r = createMcpServerSchema.safeParse({
        name: "http-server",
        transport: "streamable-http",
        url: "https://example.com/mcp",
      });
      expect(r.success).toBe(false);
      if (!r.success) {
        expect(r.error.issues[0]?.message).toMatch(/not supported yet/);
      }
    });

    it("should reject invalid transport", () => {
      const r = createMcpServerSchema.safeParse({
        name: "test",
        transport: "invalid",
      });
      expect(r.success).toBe(false);
    });

    it("should validate name length", () => {
      const r = createMcpServerSchema.safeParse({ name: "", transport: "stdio" });
      expect(r.success).toBe(false);
    });
  });

  describe("terminalSchema", () => {
    it("should accept valid terminal commands", () => {
      const r = terminalSchema.safeParse({
        command: "npm run build",
        shell: "bash",
      });
      expect(r.success).toBe(true);
    });

    it("should accept all shell types", () => {
      for (const shell of ["bash", "pwsh", "cmd", "zsh"] as const) {
        expect(terminalSchema.safeParse({ command: "ls", shell }).success).toBe(true);
      }
    });

    it("should reject invalid shell", () => {
      const r = terminalSchema.safeParse({ command: "ls", shell: "fish" });
      expect(r.success).toBe(false);
    });
  });

  describe("createPluginSchema", () => {
    it("should accept valid plugin data", () => {
      const r = createPluginSchema.safeParse({
        name: "my-plugin",
        description: "A test plugin",
        type: "plugin",
      });
      expect(r.success).toBe(true);
    });

    it("should accept skill type", () => {
      const r = createPluginSchema.safeParse({
        name: "my-skill",
        type: "skill",
      });
      expect(r.success).toBe(true);
    });

    it("should reject empty name", () => {
      const r = createPluginSchema.safeParse({ name: "" });
      expect(r.success).toBe(false);
    });
  });

  describe("togglePluginSchema", () => {
    it("should accept boolean enabled", () => {
      expect(togglePluginSchema.safeParse({ enabled: true }).success).toBe(true);
      expect(togglePluginSchema.safeParse({ enabled: false }).success).toBe(true);
    });
  });

  describe("createPresetSchema", () => {
    it("should accept valid preset data", () => {
      const r = createPresetSchema.safeParse({
        name: "Code Reviewer",
        systemPrompt: "You are a code reviewer.",
        provider: "anthropic",
        model: "claude-3-opus",
        temperature: 0.3,
      });
      expect(r.success).toBe(true);
    });

    it("should reject missing systemPrompt", () => {
      const r = createPresetSchema.safeParse({ name: "test" });
      expect(r.success).toBe(false);
    });

    it("should reject empty name", () => {
      const r = createPresetSchema.safeParse({ name: "", systemPrompt: "be helpful" });
      expect(r.success).toBe(false);
    });
  });

  describe("testProviderSchema", () => {
    it("should accept valid test data", () => {
      const r = testProviderSchema.safeParse({
        provider: "openai",
        apiKey: "sk-test",
      });
      expect(r.success).toBe(true);
    });
  });

  describe("enum schemas", () => {
    it("should validate provider IDs", () => {
      const valid = ["puter", "openrouter", "openai", "anthropic", "groq", "mistral", "together", "gemini", "custom"];
      for (const id of valid) {
        expect(providerIdSchema.safeParse(id).success).toBe(true);
      }
      expect(providerIdSchema.safeParse("invalid").success).toBe(false);
    });

    it("should validate agent modes", () => {
      expect(agentModeSchema.safeParse("agent").success).toBe(true);
      expect(agentModeSchema.safeParse("chat").success).toBe(true);
      expect(agentModeSchema.safeParse("architect").success).toBe(true);
      expect(agentModeSchema.safeParse("invalid").success).toBe(false);
    });

    it("should validate MCP transports", () => {
      expect(mcpTransportSchema.safeParse("stdio").success).toBe(true);
      expect(mcpTransportSchema.safeParse("sse").success).toBe(true);
      // Advertised by the schema/DB but unimplemented by the MCP manager —
      // rejected early with an explicit "not supported yet" message.
      expect(mcpTransportSchema.safeParse("streamable-http").success).toBe(false);
      expect(
        mcpTransportSchema.safeParse("streamable-http").error?.issues[0]?.message,
      ).toMatch(/not supported yet/);
      expect(mcpTransportSchema.safeParse("invalid").success).toBe(false);
    });

    it("should validate shell types", () => {
      expect(shellSchema.safeParse("bash").success).toBe(true);
      expect(shellSchema.safeParse("pwsh").success).toBe(true);
      expect(shellSchema.safeParse("cmd").success).toBe(true);
      expect(shellSchema.safeParse("zsh").success).toBe(true);
      expect(shellSchema.safeParse("fish").success).toBe(false);
    });
  });

  describe("isAllowedAttachmentType", () => {
    it("should allow image/* types", () => {
      expect(isAllowedAttachmentType("image/png")).toBe(true);
      expect(isAllowedAttachmentType("image/jpeg")).toBe(true);
      expect(isAllowedAttachmentType("image/svg+xml")).toBe(true);
    });

    it("should allow text/* types", () => {
      expect(isAllowedAttachmentType("text/plain")).toBe(true);
      expect(isAllowedAttachmentType("text/markdown")).toBe(true);
      expect(isAllowedAttachmentType("text/typescript")).toBe(true);
    });

    it("should allow known document types", () => {
      expect(isAllowedAttachmentType("application/pdf")).toBe(true);
      expect(isAllowedAttachmentType("application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe(true);
    });

    it("should reject unknown types", () => {
      expect(isAllowedAttachmentType("application/x-msdownload")).toBe(false);
      expect(isAllowedAttachmentType("")).toBe(false);
    });

    it("should be case-insensitive", () => {
      expect(isAllowedAttachmentType("IMAGE/PNG")).toBe(true);
      expect(isAllowedAttachmentType("TEXT/PLAIN")).toBe(true);
    });
  });

  describe("constants", () => {
    it("should have correct attachment limits", () => {
      expect(MAX_ATTACHMENT_BYTES).toBe(50 * 1000 * 1000);
      expect(MAX_ATTACHMENTS_PER_MESSAGE).toBe(20);
    });
  });

  describe("chatRequestSchema — content structural guards", () => {
    const base = {
      conversationId: "conv-1",
      message: "hi",
      provider: "openai",
      model: "gpt-4",
    };

    it("accepts large normal content within the size limit", () => {
      const message = "x".repeat(199_000);
      expect(chatRequestSchema.safeParse({ ...base, message }).success).toBe(true);
    });

    it("rejects content containing NUL bytes", () => {
      expect(chatRequestSchema.safeParse({ ...base, message: "a\u0000b" }).success).toBe(false);
      expect(chatRequestSchema.safeParse({ ...base, message: "ok\u0000" }).success).toBe(false);
      expect(chatRequestSchema.safeParse({ ...base, message: "\u0000".repeat(10) }).success).toBe(false);
    });

    it("rejects messages that are only NUL bytes", () => {
      expect(chatRequestSchema.safeParse({ ...base, message: "\u0000" }).success).toBe(false);
    });

    it("accepts other control characters and whitespace (only NUL is blocked)", () => {
      expect(chatRequestSchema.safeParse({ ...base, message: "line1\nline2\ttab\r\n" }).success).toBe(true);
    });
  });

  describe("noNulBytes", () => {
    it("returns true for clean content and false when NUL present", () => {
      expect(noNulBytes("hello world")).toBe(true);
      expect(noNulBytes("")).toBe(true);
      expect(noNulBytes("a\u0000b")).toBe(false);
    });
  });
});
