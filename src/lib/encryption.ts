import { randomBytes, createCipheriv, createDecipheriv, timingSafeEqual, createHash } from "crypto";

import fs from "fs";
import path from "path";
import { APP_DATA_DIR, ensureRuntimeDirs } from "@/lib/paths";

const ALGO = "aes-256-gcm";

function getOrInitPersistentKey(): Buffer {
  // 1. Env var override takes precedence; when present it MUST be valid.
  //    Falling back to another key would silently orphan every stored secret.
  if (typeof process !== "undefined" && process.env?.ENCRYPTION_KEY) {
    const k = process.env.ENCRYPTION_KEY;
    if (k.length === 64 && /^[0-9a-fA-F]{64}$/.test(k)) {
      return Buffer.from(k, "hex");
    }
    throw new Error(
      "ENCRYPTION_KEY is set but invalid (expected a 64-char hex string). " +
        "Refusing to fall back to a different key: stored secrets would become undecryptable.",
    );
  }

  // Persistent file storage under APP_DATA_DIR. The key is a long-lived
  // secret: falling back to an ephemeral in-memory key would make every
  // value encrypted with it permanently undecryptable after a restart,
  // so a persistence failure must abort initialization instead.
  let keyPath = "";
  try {
    ensureRuntimeDirs();
    keyPath = path.join(APP_DATA_DIR, ".secret_key");
    if (fs.existsSync(keyPath)) {
      const raw = fs.readFileSync(keyPath, "utf8").trim();
      if (raw.length === 64 && /^[0-9a-fA-F]{64}$/.test(raw)) {
        return Buffer.from(raw, "hex");
      }
      // Never silently rotate a corrupt persisted key — that would orphan
      // every stored provider secret. Fail closed instead.
      throw new Error(
        `Persisted encryption key at ${keyPath} is invalid (expected 64 hex chars). ` +
          "Restore the key file or delete it to regenerate a fresh key.",
      );
    }
    // Generate a new key and persist it before use.
    const newKey = randomBytes(32);
    fs.writeFileSync(keyPath, newKey.toString("hex"), { encoding: "utf8", mode: 0o600 });
    return newKey;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to initialize persistent encryption key at ${keyPath}: ${detail}`);
  }
}

let cachedKey: Buffer | null = null;

function getKey(): Buffer {
  if (!cachedKey) {
    cachedKey = getOrInitPersistentKey();
  }
  return cachedKey;
}

export interface EncryptedPayload {
  // base64 strings
  ct: string;
  iv: string;
  tag: string;
}

/** Encrypt a plaintext secret with AES-256-GCM. Returns base64 JSON string. */
export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload: EncryptedPayload = {
    ct: ct.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
  };
  return JSON.stringify(payload);
}

/** Decrypt a payload produced by encrypt(). Returns plaintext or throws. */
export function decrypt(serialized: string): string {
  try {
    const key = getKey();
    const payload = JSON.parse(serialized) as EncryptedPayload;
    if (!payload || typeof payload !== "object" || !payload.iv || !payload.tag || !payload.ct) {
      throw new Error("Invalid encrypted payload structure");
    }
    const iv = Buffer.from(payload.iv, "base64");
    const tag = Buffer.from(payload.tag, "base64");
    const ct = Buffer.from(payload.ct, "base64");
    if (tag.length !== 16) {
      throw new Error("Invalid authentication tag length (must be 16 bytes)");
    }
    if (iv.length !== 12) {
      throw new Error("Invalid initialization vector length (must be 12 bytes)");
    }
    const decipher = createDecipheriv(ALGO, key, iv, { authTagLength: 16 });
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString("utf8");
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Decryption failed:")) {
      throw err;
    }
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Decryption failed: ${detail}`);
  }
}

/** Safely decrypts a stored JSON string or parses legacy plaintext JSON. */
export function tryDecryptJson<T = Record<string, string>>(serialized?: string | null): T | undefined {
  if (!serialized || typeof serialized !== "string") return undefined;
  const trimmed = serialized.trim();
  if (!trimmed) return undefined;
  try {
    const decrypted = decrypt(trimmed);
    return JSON.parse(decrypted) as T;
  } catch {
    try {
      return JSON.parse(trimmed) as T;
    } catch {
      return undefined;
    }
  }
}

/** Mask a key for display, keeping the last 4 chars. */
export function maskKey(key: string): string {
  if (!key || typeof key !== "string") return "••••";
  if (key.length <= 4) return "••••";
  return "••••" + key.slice(-4);
}

/** Mask all values in a key-value record for safe display/DTO export. */
export function maskRecord(record?: Record<string, string> | null): Record<string, string> | undefined {
  if (!record || typeof record !== "object") return undefined;
  const masked: Record<string, string> = {};
  for (const [k, v] of Object.entries(record)) {
    masked[k] = typeof v === "string" ? maskKey(v) : "••••";
  }
  return masked;
}

/** Constant-time string compare that does not leak length information. */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** Generate a random opaque token (URL-safe). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}
