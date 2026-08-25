import { describe, it, expect } from "vitest";
import { encrypt, decrypt, maskKey, safeEqual, randomToken } from "@/lib/encryption";

describe("Crypto Audit Verification Tests", () => {
  it("handles standard encrypt and decrypt flow", () => {
    const key = "sk-proj-1234567890abcdef1234567890abcdef";
    const ct = encrypt(key);
    expect(decrypt(ct)).toBe(key);
  });

  it("wraps non-JSON input errors in a Decryption failed Error", () => {
    expect(() => decrypt("not-valid-json")).toThrow(/Decryption failed:/);
  });

  it("fails authentication on invalid/non-standard IV length", () => {
    const tag16 = Buffer.alloc(16).toString("base64");
    const iv2 = Buffer.alloc(2).toString("base64");
    const payload = JSON.stringify({ ct: "YWI=", iv: iv2, tag: tag16 });
    expect(() => decrypt(payload)).toThrow(/unable to authenticate data|Unsupported state/i);
  });

  it("throws Error on invalid authentication tag length", () => {
    const iv12 = Buffer.alloc(12).toString("base64");
    const tag2 = Buffer.alloc(2).toString("base64");
    const payload = JSON.stringify({ ct: "YWI=", iv: iv12, tag: tag2 });
    expect(() => decrypt(payload)).toThrow(/Invalid authentication tag length/i);
  });

  it("throws Error on missing or zero-length auth tag", () => {
    const iv12 = Buffer.alloc(12).toString("base64");
    const payload = JSON.stringify({ ct: "YWI=", iv: iv12, tag: "" });
    expect(() => decrypt(payload)).toThrow();
  });

  it("throws Error on corrupted ciphertext or authentication tag failure", () => {
    const valid = JSON.parse(encrypt("secret-data"));
    valid.ct = Buffer.from("corrupted-ciphertext").toString("base64");
    expect(() => decrypt(JSON.stringify(valid))).toThrow(/unable to authenticate data|Unsupported state/i);
  });

  it("masks keys correctly", () => {
    expect(maskKey("123")).toBe("••••");
    expect(maskKey("1234")).toBe("••••");
    expect(maskKey("12345")).toBe("••••2345");
    expect(maskKey("sk-ant-api03-1234567890abcdef")).toBe("••••cdef");
  });

  it("timing-safe equality handles equal and unequal lengths safely", () => {
    expect(safeEqual("keyA", "keyA")).toBe(true);
    expect(safeEqual("keyA", "keyB")).toBe(false);
    expect(safeEqual("short", "much-longer-key-string")).toBe(false);
  });

  it("generates random tokens of specified byte lengths", () => {
    const t1 = randomToken(16);
    const t2 = randomToken(32);
    expect(t1.length).toBeGreaterThan(0);
    expect(t2.length).toBeGreaterThan(t1.length);
  });
});
