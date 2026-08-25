import { describe, it, expect } from "vitest";
import { scrubSensitiveSecrets } from "./sanitize-content";

describe("scrubSensitiveSecrets", () => {
  it("scrubs OpenAI and Anthropic API keys", () => {
    const raw = "Here is my key: sk-proj-123456789012345678901234 and anthropic sk-ant-12345678901234567890";
    const cleaned = scrubSensitiveSecrets(raw);
    expect(cleaned).toContain("[REDACTED_API_KEY]");
    expect(cleaned).not.toContain("sk-proj-123456789012345678901234");
  });

  it("scrubs GitHub tokens", () => {
    const raw = "Access token ghp_123456789012345678901234567890123456";
    const cleaned = scrubSensitiveSecrets(raw);
    expect(cleaned).toContain("[REDACTED_API_KEY]");
    expect(cleaned).not.toContain("ghp_123456789012345678901234567890123456");
  });

  it("scrubs database connection URIs", () => {
    const raw = "Connecting to postgres://admin:supersecretpassword@db.example.com:5432/mydb";
    const cleaned = scrubSensitiveSecrets(raw);
    expect(cleaned).toContain("postgres://[REDACTED_DB_CREDENTIALS]@host/db");
    expect(cleaned).not.toContain("supersecretpassword");
  });

  it("scrubs RSA private keys", () => {
    const raw = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----";
    const cleaned = scrubSensitiveSecrets(raw);
    expect(cleaned).toContain("[REDACTED_PRIVATE_KEY]");
    expect(cleaned).not.toContain("MIIEowIBAAKCAQEA");
  });

  it("scrubs custom user regex pattern", () => {
    const raw = "Internal token CORP_TOKEN_9988776655 in request";
    const cleaned = scrubSensitiveSecrets(raw, "CORP_TOKEN_[0-9]+");
    expect(cleaned).toContain("[REDACTED_CUSTOM_SECRET]");
    expect(cleaned).not.toContain("CORP_TOKEN_9988776655");
  });
});
