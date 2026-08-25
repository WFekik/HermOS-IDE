import { describe, it, expect } from "vitest";
import { securitySettingsSchema, chatRequestSchema } from "./validation";

describe("securitySettingsSchema", () => {
  it("accepts an empty payload", () => {
    const r = securitySettingsSchema.safeParse({});
    expect(r.success).toBe(true);
  });

  it("accepts a valid partial update", () => {
    const r = securitySettingsSchema.safeParse({
      autoScrubSecrets: false,
      customRedactionRegex: "COMPANY_TOKEN_[A-Z0-9]+",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.autoScrubSecrets).toBe(false);
      expect(r.data.customRedactionRegex).toBe("COMPANY_TOKEN_[A-Z0-9]+");
    }
  });

  it("rejects a malformed custom redaction regex", () => {
    const r = securitySettingsSchema.safeParse({ customRedactionRegex: "([unclosed" });
    expect(r.success).toBe(false);
  });

  it("rejects unknown fields (strict)", () => {
    const r = securitySettingsSchema.safeParse({ privacyMode: true });
    expect(r.success).toBe(false);
  });
});

describe("chatRequestSchema capabilities", () => {
  const base = {
    conversationId: "c1",
    message: "hello",
    provider: "openai",
    model: "gpt-4o",
  };

  it("accepts a capabilities array (previously stripped as unknown)", () => {
    const r = chatRequestSchema.safeParse({
      ...base,
      capabilities: ["os:windows", "clipboard:true"],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.capabilities).toEqual(["os:windows", "clipboard:true"]);
    }
  });

  it("is still optional", () => {
    const r = chatRequestSchema.safeParse(base);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.capabilities).toBeUndefined();
  });
});