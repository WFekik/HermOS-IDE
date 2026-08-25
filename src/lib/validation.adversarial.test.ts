import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import {
  providerIdSchema,
  agentModeSchema,
  mcpTransportSchema,
  shellSchema,
  createConversationSchema,
  patchConversationSchema,
  chatRequestSchema,
  saveKeySchema,
  createMcpServerSchema,
  terminalSchema,
  createPluginSchema,
  togglePluginSchema,
  idParamSchema,
  createPresetSchema,
  testProviderSchema,
  isAllowedAttachmentType,
} from "./validation";

describe("validation.ts — adversarial property tests", () => {
  describe("providerIdSchema: arbitrary string fuzzing", () => {
    it("never throws — always returns a safe Zod result", () => {
      fc.assert(
        fc.property(fc.string(), (input) => {
          const result = providerIdSchema.safeParse(input);
          // Must always return a result object (never throw)
          expect(result).toHaveProperty("success");
          if (result.success) {
            // If it somehow succeeds, the value must be one of the enum members
            expect([
              "puter", "nvidia", "openrouter", "openai", "anthropic",
              "groq", "mistral", "together", "gemini", "custom",
            ]).toContain(result.data);
          } else {
            // Error must be structured
            expect(result.error).toHaveProperty("issues");
            expect(Array.isArray(result.error.issues)).toBe(true);
          }
        }),
        { numRuns: 500, seed: 42 },
      );
    });

    it("rejects empty strings and whitespace-only", () => {
      for (const s of ["", " ", "  ", "\t", "\n", "\r\n"]) {
        const r = providerIdSchema.safeParse(s);
        expect(r.success).toBe(false);
      }
    });

    it("rejects very long strings", () => {
      const r = providerIdSchema.safeParse("x".repeat(10000));
      expect(r.success).toBe(false);
    });
  });

  describe("chatRequestSchema: fuzz every field", () => {
    it("accepts valid minimal input", () => {
      const r = chatRequestSchema.safeParse({
        conversationId: "abc123",
        message: "hello",
        provider: "openai",
        model: "gpt-4",
      });
      expect(r.success).toBe(true);
    });

    it("never throws on arbitrary objects", () => {
      fc.assert(
        fc.property(
          fc.dictionary(fc.string(), fc.anything()),
          fc.anything(),
          (obj) => {
            expect(() => chatRequestSchema.safeParse(obj)).not.toThrow();
          },
        ),
        { numRuns: 200, seed: 42 },
      );
    });

    it("rejects message exceeding max length", () => {
      const r = chatRequestSchema.safeParse({
        conversationId: "abc",
        message: "x".repeat(200001),
        provider: "openai",
        model: "gpt-4",
      });
      expect(r.success).toBe(false);
    });

    it("rejects mcpServerIds exceeding max items", () => {
      const r = chatRequestSchema.safeParse({
        conversationId: "abc",
        message: "hi",
        provider: "openai",
        model: "gpt-4",
        mcpServerIds: Array.from({ length: 21 }, (_, i) => `srv${i}`),
      });
      expect(r.success).toBe(false);
    });

    it("rejects enabledTools exceeding max items", () => {
      const r = chatRequestSchema.safeParse({
        conversationId: "abc",
        message: "hi",
        provider: "openai",
        model: "gpt-4",
        enabledTools: Array.from({ length: 41 }, (_, i) => `tool${i}`),
      });
      expect(r.success).toBe(false);
    });

    it("rejects temperature out of range", () => {
      const base = {
        conversationId: "abc",
        message: "hi",
        provider: "openai",
        model: "gpt-4",
      };
      expect(chatRequestSchema.safeParse({ ...base, temperature: -0.01 }).success).toBe(false);
      expect(chatRequestSchema.safeParse({ ...base, temperature: 2.01 }).success).toBe(false);
      expect(chatRequestSchema.safeParse({ ...base, temperature: 0 }).success).toBe(true);
      expect(chatRequestSchema.safeParse({ ...base, temperature: 2 }).success).toBe(true);
    });
  });

  describe("terminalSchema: command injection edge cases", () => {
    it("accepts normal commands", () => {
      const r = terminalSchema.safeParse({ command: "ls -la", shell: "bash" });
      expect(r.success).toBe(true);
    });

    it("rejects empty command", () => {
      const r = terminalSchema.safeParse({ command: "", shell: "bash" });
      expect(r.success).toBe(false);
    });

    it("rejects command exceeding max length", () => {
      const r = terminalSchema.safeParse({ command: "x".repeat(1001), shell: "bash" });
      expect(r.success).toBe(false);
    });

    it("accepts command with shell metacharacters", () => {
      // Shell metacharacters should be allowed — the schema validates trim+min+max, not content
      const r = terminalSchema.safeParse({
        command: "cat file | grep foo > /dev/null; echo $HOME",
        shell: "bash",
      });
      expect(r.success).toBe(true);
    });

    it("rejects invalid shell values", () => {
      for (const invalid of ["", "fish", "ksh", " ", "powershell"]) {
        const r = terminalSchema.safeParse({ command: "ls", shell: invalid });
        expect(r.success).toBe(false);
      }
    });
  });

  describe("saveKeySchema: API key edge cases", () => {
    it("rejects empty apiKey", () => {
      const r = saveKeySchema.safeParse({ provider: "openai", apiKey: "" });
      expect(r.success).toBe(false);
    });

    it("accepts valid apiKey", () => {
      const r = saveKeySchema.safeParse({ provider: "openai", apiKey: "sk-1234567890abcdef" });
      expect(r.success).toBe(true);
    });

    it("rejects apiKey exceeding max length", () => {
      const r = saveKeySchema.safeParse({ provider: "openai", apiKey: "x".repeat(4097) });
      expect(r.success).toBe(false);
    });

    it("rejects baseUrl that is not a URL", () => {
      const r = saveKeySchema.safeParse({
        provider: "openai",
        apiKey: "sk-xxx",
        baseUrl: "not a url",
      });
      expect(r.success).toBe(false);
    });

    it("accepts baseUrl with trailing whitespace (trimmed)", () => {
      const r = saveKeySchema.safeParse({
        provider: "openai",
        apiKey: "sk-xxx",
        baseUrl: "https://api.openai.com ",
      });
      expect(r.success).toBe(true);
    });
  });

  describe("createMcpServerSchema: fuzz records", () => {
    it("accepts valid MCP server config", () => {
      const r = createMcpServerSchema.safeParse({
        name: "my-server",
        transport: "stdio",
        command: "node",
        args: ["server.js"],
        env: { FOO: "bar" },
      });
      expect(r.success).toBe(true);
    });

    it("rejects empty name", () => {
      const r = createMcpServerSchema.safeParse({
        name: "",
        transport: "stdio",
      });
      expect(r.success).toBe(false);
    });

    it("rejects env value exceeding max length", () => {
      const r = createMcpServerSchema.safeParse({
        name: "srv",
        transport: "stdio",
        env: { FOO: "x".repeat(501) },
      });
      expect(r.success).toBe(false);
    });

    it("never throws on arbitrary env objects", () => {
      fc.assert(
        fc.property(
          fc.dictionary(fc.string(), fc.string().filter(s => s.length <= 500)),
          (env) => {
            const r = createMcpServerSchema.safeParse({
              name: "srv",
              transport: "sse",
              url: "https://example.com/mcp",
              env,
            });
            expect(() => r).not.toThrow();
          },
        ),
        { numRuns: 100, seed: 42 },
      );
    });
  });

  describe("createPresetSchema: temperature clamping", () => {
    it("rejects temperature out of range", () => {
      const base = {
        name: "preset",
        systemPrompt: "You are a helpful assistant.",
      };
      expect(createPresetSchema.safeParse({ ...base, temperature: -0.1 }).success).toBe(false);
      expect(createPresetSchema.safeParse({ ...base, temperature: 2.1 }).success).toBe(false);
    });
  });

  describe("isAllowedAttachmentType: edge cases", () => {
    it("never throws on arbitrary MIME strings", () => {
      fc.assert(
        fc.property(fc.string(), (mime) => {
          expect(() => isAllowedAttachmentType(mime)).not.toThrow();
        }),
        { numRuns: 500, seed: 42 },
      );
    });

    it("rejects empty string", () => {
      expect(isAllowedAttachmentType("")).toBe(false);
    });

    it("rejects null-like inputs", () => {
      // @ts-expect-error — testing runtime resilience
      expect(isAllowedAttachmentType(undefined)).toBe(false);
      // @ts-expect-error
      expect(isAllowedAttachmentType(null)).toBe(false);
    });

    it("allows image/* and text/* families", () => {
      expect(isAllowedAttachmentType("image/anyformat")).toBe(true);
      expect(isAllowedAttachmentType("text/anyformat")).toBe(true);
      expect(isAllowedAttachmentType("IMAGE/PNG")).toBe(true);
      expect(isAllowedAttachmentType("TEXT/PLAIN")).toBe(true);
    });
  });
});
