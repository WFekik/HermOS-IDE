import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * Never-log-secrets guard: no console.* / log::* call site may reference
 * credential VALUES (headers, keys, tokens). Path-only logging (e.g. the
 * key file path) is allowed. Scans TS sources + the Tauri entrypoint.
 */
const rootDir = path.resolve(__dirname, "..", "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "target") continue;
      walk(full, out);
    } else if (/\.(ts|tsx|rs)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

// Matches a logging call on the SAME line as a secret-value reference.
const LOG_CALL = /(console\.(log|warn|error|debug|info)|log::(info|warn|error|debug))\(/;
const SECRET_VALUE = /(x-api-key|Authorization|ENCRYPTION_KEY|TAURI_SIGNING_PRIVATE_KEY|GITHUB_TOKEN|Bearer \$\{|apiKey\}|\.apiKey\b)/;

describe("never log credential values", () => {
  it("has no logging call site referencing secret values", () => {
    const violations: string[] = [];
    for (const file of [...walk(path.join(rootDir, "src")), ...walk(path.join(rootDir, "src-tauri", "src"))]) {
      // Test fixtures intentionally contain these strings — only scan prod code paths,
      // and skip the redaction regex itself (sanitize-content.ts defines the patterns).
      if (file.endsWith(".test.ts") || file.endsWith(".test.tsx")) continue;
      if (file.endsWith("sanitize-content.ts")) continue;
      const lines = fs.readFileSync(file, "utf-8").split("\n");
      lines.forEach((line, i) => {
        if (LOG_CALL.test(line) && SECRET_VALUE.test(line)) {
          violations.push(`${path.relative(rootDir, file)}:${i + 1}: ${line.trim().slice(0, 160)}`);
        }
      });
    }
    expect(violations, `secret values must never appear in log calls:\n${violations.join("\n")}`).toEqual([]);
  });
});
