import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { enforceLoopbackRequest, toMcpServerDTO } from "@/app/api/_lib/helpers";
import { encrypt, decrypt, tryDecryptJson, maskRecord, maskKey } from "@/lib/encryption";
import { DEFAULT_PERMISSIONS, evaluatePermission, actionForTool } from "@/lib/permissions-core";
import { checkUrlHost } from "@/lib/ssrf";
import { NextRequest } from "next/server";

describe("Security Audit Remediation Regression Suite", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("1. Remote Bind & Host Enforcement", () => {
    it("strictly blocks external 0.0.0.0 bind even if HERMOS_ALLOW_REMOTE=true is set", () => {
      process.env.HOSTNAME = "0.0.0.0";
      (process.env as any).HERMOS_ALLOW_REMOTE = "true";

      const req = new NextRequest("http://127.0.0.1:3000/api/terminal/run", {
        headers: { host: "127.0.0.1:3000" },
      });

      const res = enforceLoopbackRequest(req);
      expect(res).not.toBeNull();
      expect(res?.status).toBe(403);
    });

    it("strictly blocks non-loopback external IP bind", () => {
      process.env.HOSTNAME = "192.168.1.100";
      const req = new NextRequest("http://192.168.1.100:3000/api/terminal/run", {
        headers: { host: "192.168.1.100:3000" },
      });

      const res = enforceLoopbackRequest(req);
      expect(res).not.toBeNull();
      expect(res?.status).toBe(403);
    });

    it("allows local loopback binding (127.0.0.1)", () => {
      process.env.HOSTNAME = "127.0.0.1";
      const req = new NextRequest("http://127.0.0.1:3000/api/auth/me", {
        headers: { host: "127.0.0.1:3000" },
      });

      const res = enforceLoopbackRequest(req);
      expect(res).toBeNull();
    });
  });

  describe("2. AES-256-GCM 16-Byte Tag & 12-Byte IV Enforcement", () => {
    it("encrypts and decrypts correctly with standard 16-byte tag and 12-byte IV", () => {
      const secret = "super-secret-mcp-api-key-987654";
      const encrypted = encrypt(secret);
      expect(decrypt(encrypted)).toBe(secret);
    });

    it("rejects truncated authentication tags (e.g. 4-byte/32-bit tag)", () => {
      const iv12 = Buffer.alloc(12).toString("base64");
      const tag4 = Buffer.alloc(4).toString("base64");
      const payload = JSON.stringify({ ct: "c2VjcmV0", iv: iv12, tag: tag4 });

      expect(() => decrypt(payload)).toThrow(/Invalid authentication tag length/);
    });

    it("rejects invalid IV lengths (not 12 bytes)", () => {
      const iv16 = Buffer.alloc(16).toString("base64");
      const tag16 = Buffer.alloc(16).toString("base64");
      const payload = JSON.stringify({ ct: "c2VjcmV0", iv: iv16, tag: tag16 });

      expect(() => decrypt(payload)).toThrow(/Invalid initialization vector length/);
    });
  });

  describe("3. MCP Credentials Masking & Storage Protection", () => {
    it("toMcpServerDTO masks secret values in env and headers", () => {
      const rawEnv = { API_KEY: "sk-proj-super-secret-key-1234", ENV_VAR: "prod-secret-9999" };
      const rawHeaders = { Authorization: "Bearer my-secret-token-5678" };
      const encryptedEnv = encrypt(JSON.stringify(rawEnv));
      const encryptedHeaders = encrypt(JSON.stringify(rawHeaders));

      const dto = toMcpServerDTO({
        id: "server-1",
        name: "Test Server",
        transport: "stdio",
        command: "npx",
        args: JSON.stringify(["-y", "mcp-server"]),
        env: encryptedEnv,
        url: null,
        headers: encryptedHeaders,
        status: "disconnected",
        lastError: null,
        tools: null,
        createdAt: new Date(),
      });

      expect(dto.env).toBeDefined();
      expect(dto.env?.API_KEY).toBe("••••1234");
      expect(dto.env?.ENV_VAR).toBe("••••9999");
      expect(dto.headers?.Authorization).toBe("••••5678");
      expect(JSON.stringify(dto)).not.toContain("sk-proj-super-secret-key-1234");
      expect(JSON.stringify(dto)).not.toContain("my-secret-token-5678");
    });

    it("tryDecryptJson transparently handles encrypted JSON and legacy plaintext JSON", () => {
      const data = { token: "secret-token-1234" };
      const encrypted = encrypt(JSON.stringify(data));
      const plaintext = JSON.stringify(data);

      expect(tryDecryptJson(encrypted)).toEqual(data);
      expect(tryDecryptJson(plaintext)).toEqual(data);
      expect(tryDecryptJson(null)).toBeUndefined();
      expect(tryDecryptJson("")).toBeUndefined();
    });

    it("maskKey and maskRecord properly redact secrets", () => {
      expect(maskKey("12345678")).toBe("••••5678");
      expect(maskKey("abc")).toBe("••••");
      expect(maskRecord({ a: "secret-val-1", b: "secret-val-2" })).toEqual({
        a: "••••al-1",
        b: "••••al-2",
      });
    });
  });

  describe("4. Default Agent Permissions & Plugin Permissions", () => {
    it("defaults web.fetch to 'ask' to prevent silent prompt-injection data exfiltration", () => {
      const fetchRule = DEFAULT_PERMISSIONS.rules.find((r) => r.action === "web.fetch");
      expect(fetchRule?.mode).toBe("ask");
    });

    it("does not auto-allow web.fetch under autoAllowReadonly", () => {
      const result = evaluatePermission(DEFAULT_PERMISSIONS, "web.fetch");
      expect(result).toBe("ask");
    });

    it("maps plugin_call to command.run permission action", () => {
      expect(actionForTool("plugin_call")).toBe("command.run");
    });
  });

  describe("5. SSRF Loopback Port Allowlist", () => {
    it("allows standard local AI ports on loopback", async () => {
      expect(await checkUrlHost("http://127.0.0.1:11434/api/generate")).toBeNull();
      expect(await checkUrlHost("http://localhost:1234/v1/models")).toBeNull();
      expect(await checkUrlHost("http://127.0.0.1:8080/completion")).toBeNull();
      expect(await checkUrlHost("http://localhost:8000/v1/chat/completions")).toBeNull();
    });

    it("blocks dangerous non-AI ports on loopback (e.g. database, redis, ssh, docker)", async () => {
      expect(await checkUrlHost("http://127.0.0.1:6379/")).toMatch(/blocked/);
      expect(await checkUrlHost("http://127.0.0.1:22/")).toMatch(/blocked/);
      expect(await checkUrlHost("http://localhost:5432/")).toMatch(/blocked/);
      expect(await checkUrlHost("http://127.0.0.1:2375/")).toMatch(/blocked/);
      expect(await checkUrlHost("http://127.0.0.1:9000/")).toMatch(/blocked/);
    });
  });
});
