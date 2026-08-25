import { describe, it, expect } from "vitest";
import {
  scrubString,
  scrubHistoryForWire,
  scrubPromptString,
  type ScrubMessageLike,
} from "./security-scrub";
import { DEFAULT_SECURITY_SETTINGS, type SecuritySettings } from "./security-types";

const SECRET_KEY = "sk-proj-AAAAAAAAAAAAAAAAAAAAAAA";

const off: SecuritySettings = { autoScrubSecrets: false, customRedactionRegex: "" };
const on: SecuritySettings = DEFAULT_SECURITY_SETTINGS;
const custom: SecuritySettings = { autoScrubSecrets: true, customRedactionRegex: "COMPANY_TOKEN_[A-Z0-9]+" };

describe("scrubString", () => {
  it("redacts a known API key", () => {
    const out = scrubString(`Bearer ${SECRET_KEY}`, on)!;
    expect(out).toContain("[REDACTED_API_KEY]");
    expect(out).not.toContain(SECRET_KEY);
  });

  it("preserves null and undefined", () => {
    expect(scrubString(null, on)).toBeNull();
    expect(scrubString(undefined, on)).toBeUndefined();
  });

  it("applies a custom user regex via [REDACTED_CUSTOM_SECRET]", () => {
    const out = scrubString("token=COMPANY_TOKEN_123", custom)!;
    expect(out).toContain("[REDACTED_CUSTOM_SECRET]");
  });

  it("returns the same value when scrubbing is disabled", () => {
    expect(scrubString(`kept ${SECRET_KEY}`, off)).toBe(`kept ${SECRET_KEY}`);
  });
});

describe("scrubPromptString", () => {
  it("redacts a secret nested in a prompt", () => {
    const out = scrubPromptString(`db url: postgres://u:p@host/db\nkey: ${SECRET_KEY}`, on)!;
    expect(out).not.toContain(SECRET_KEY);
    expect(out).not.toContain("u:p@host");
  });

  it("passes through when disabled", () => {
    const prompt = `reachable: ${SECRET_KEY}`;
    expect(scrubPromptString(prompt, off)).toBe(prompt);
  });
});

describe("scrubHistoryForWire", () => {
  const history: ScrubMessageLike[] = [
    { role: "user", content: `config: ${SECRET_KEY}`, thinking: "db postgres://u:p@host/x" },
    { role: "assistant", content: "no secrets here", thinking: undefined },
  ];

  it("redacts content and thinking without mutating the source rows", () => {
    const out = scrubHistoryForWire(history, on);
    expect(out).toHaveLength(history.length);
    expect(out[0].content).toContain("[REDACTED_API_KEY]");
    expect(out[0].thinking).toContain("[REDACTED_DB_CREDENTIALS]");
    // Original rows untouched.
    expect(history[0].content).toBe(`config: ${SECRET_KEY}`);
    // Unaffected rows keep their reference.
    expect(out[1]).toBe(history[1]);
  });

  it("returns the same array reference when disabled", () => {
    expect(scrubHistoryForWire(history, off)).toBe(history);
  });

  it("returns the same array reference when nothing changed", () => {
    const clean = [{ role: "user" as const, content: "plain", thinking: undefined }];
    expect(scrubHistoryForWire(clean, on)).toBe(clean);
  });

  it("is defensive against empty input", () => {
    expect(scrubHistoryForWire([], on)).toEqual([]);
    expect(scrubHistoryForWire(undefined as unknown as ScrubMessageLike[], on)).toBeUndefined();
  });
});