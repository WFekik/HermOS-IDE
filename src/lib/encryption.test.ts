import { beforeEach, describe, it, expect, vi } from "vitest";
import os from "os";
import path from "path";
import fs from "fs";
import { encrypt, decrypt, maskKey, safeEqual, randomToken } from "./encryption";

describe("Encryption Module", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("should encrypt and decrypt plaintext accurately", () => {
    const original = "sk-proj-test1234567890secretkey";
    const encrypted = encrypt(original);
    expect(encrypted).not.toBe(original);
    expect(encrypted).toContain('"ct":');
    expect(encrypted).toContain('"iv":');
    expect(encrypted).toContain('"tag":');

    const decrypted = decrypt(encrypted);
    expect(decrypted).toBe(original);
  });

  it("should preserve the audit example plaintext on roundtrip", () => {
    const secret = "sk-proj-test123456789";
    expect(decrypt(encrypt(secret))).toBe(secret);
  });

  it("should produce different ciphertexts for the same plaintext (random IV)", () => {
    const secret = "sk-proj-test123456789";
    const a = encrypt(secret);
    const b = encrypt(secret);
    expect(a).not.toBe(b);
    expect(decrypt(a)).toBe(secret);
    expect(decrypt(b)).toBe(secret);
  });

  it("should mask key keeping last 4 characters", () => {
    expect(maskKey("sk-1234567890abcdef")).toBe("••••cdef");
    expect(maskKey("abc")).toBe("••••");
  });

  it("should perform timing-safe equality comparison", () => {
    expect(safeEqual("token-abc-123", "token-abc-123")).toBe(true);
    expect(safeEqual("token-abc-123", "token-abc-124")).toBe(false);
    expect(safeEqual("short", "longer-string")).toBe(false);
  });

  it("should generate random tokens", () => {
    const token1 = randomToken();
    const token2 = randomToken();
    expect(token1).toBeDefined();
    expect(token2).toBeDefined();
    expect(token1).not.toBe(token2);
  });

  it("should throw a descriptive error when the persistent key file cannot be written", async () => {
    vi.resetModules();
    vi.stubEnv("ENCRYPTION_KEY", "");
    const testDir = path.join(os.tmpdir(), `hermos-enc-test-${Date.now()}`);
    vi.stubEnv("HERMOS_APP_DATA_DIR", testDir);
    try {
      const fsDefault = (await import("fs")).default;
      const { encrypt: freshEncrypt } = await import("./encryption");
      const spy = vi.spyOn(fsDefault, "writeFileSync").mockImplementation(() => {
        throw new Error("EACCES: permission denied");
      });
      expect(() => freshEncrypt("sk-proj-test123456789")).toThrow(/persistent encryption key/i);
      expect(spy).toHaveBeenCalled();
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });
});
