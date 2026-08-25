import { describe, it, expect } from "vitest";
import path from "path";
import { mkdtempSync, existsSync, mkdirSync, writeFileSync } from "fs";
import os from "os";

const testRoot = mkdtempSync(path.join(os.tmpdir(), "hermos-agent-path-"));

// Isolate APP_DATA_DIR before any lib import (paths.ts computes it at
// module load), so tests never touch the real ~/.hermos or %APPDATA%.
process.env.HERMOS_APP_DATA_DIR = testRoot;

const { resolveCommandSafety, agentTempDir, ensureAgentTempDir, startBackgroundCommand, getCompletedCommand } = await import("@/lib/workspace");
const { resolveAgentPath, truncationWriteGuard } = await import("@/lib/ai/tools");
const { writeTruncation, TRUNCATION_DIR, truncationUserDir } = await import("@/lib/truncate");

const USER = "user-test-1";
const WS = { name: "proj", rootDir: path.join(testRoot, "ws") };

mkdirSync(WS.rootDir, { recursive: true });
writeFileSync(path.join(WS.rootDir, "main.ts"), "const x = 1;\n");

describe("agentTempDir", () => {
  it("is per-user, under the app data dir, and created on demand", () => {
    const dir = ensureAgentTempDir(USER);
    expect(dir).toBe(agentTempDir(USER));
    expect(dir.startsWith(testRoot)).toBe(true);
    expect(existsSync(dir)).toBe(true);
  });

  it("sanitizes unsafe characters in user ids", () => {
    expect(agentTempDir("a/b:c d")).toContain("a_b_c_d");
  });
});

describe("resolveAgentPath trusted roots", () => {
  it("resolves workspace-relative paths as before", async () => {
    const t = await resolveAgentPath(USER, WS, "c1", "main.ts");
    expect(t?.rootDir).toBe(WS.rootDir);
    expect(t?.rel).toBe("main.ts");
    expect(t?.isArtifact).toBe(false);
    expect(t?.isTemp).toBe(false);
    expect(t?.isTruncation).toBe(false);
  });

  it("rejects traversal escapes", async () => {
    expect(await resolveAgentPath(USER, WS, "c1", "../secret.txt")).toBeNull();
    expect(await resolveAgentPath(USER, WS, "c1", "a/../../../secret.txt")).toBeNull();
  });

  it("resolves truncation-cache paths (read-only root), including nonexistent ones", async () => {
    const truncAbs = await writeTruncation(USER, "full tool output that got capped");
    const t = await resolveAgentPath(USER, WS, "c1", truncAbs);
    expect(t?.isTruncation).toBe(true);
    expect(t?.rootDir).toBe(truncationUserDir(USER));
    expect(path.resolve(t!.rootDir, t!.rel)).toBe(truncAbs);

    const missing = path.join(truncationUserDir(USER), "tool_never_created_xyz");
    const t2 = await resolveAgentPath(USER, WS, "c1", missing);
    expect(t2?.isTruncation).toBe(true);
  });

  it("resolves agent-temp paths (writable root), including new files", async () => {
    const tempDir = ensureAgentTempDir(USER);
    const scriptAbs = path.join(tempDir, "scratch.js");
    writeFileSync(scriptAbs, "console.log(1)");
    const t = await resolveAgentPath(USER, WS, "c1", scriptAbs);
    expect(t?.isTemp).toBe(true);
    expect(t?.rootDir).toBe(tempDir);

    const newAbs = path.join(tempDir, "sub", "new.sh");
    const t2 = await resolveAgentPath(USER, WS, "c1", newAbs);
    expect(t2?.isTemp).toBe(true);
    expect(t2?.rel).toBe(path.join("sub", "new.sh"));
  });

  it("rejects paths outside every trusted root", async () => {
    expect(await resolveAgentPath(USER, WS, "c1", path.join(testRoot, "outside.txt"))).toBeNull();
    const escapeViaTemp = path.join(ensureAgentTempDir(USER), "..", "..", "secret.txt");
    expect(await resolveAgentPath(USER, WS, "c1", escapeViaTemp)).toBeNull();
  });

  it("never exposes another user's truncation cache", async () => {
    const otherAbs = await writeTruncation("user-other", "other user's capped output");
    expect(otherAbs.startsWith(truncationUserDir("user-other"))).toBe(true);
    expect(await resolveAgentPath(USER, WS, "c1", otherAbs)).toBeNull();
    expect(await resolveAgentPath(USER, WS, "c1", truncationUserDir("user-other"))).toBeNull();
  });

  it("never exposes another user's agent temp dir", async () => {
    const other = ensureAgentTempDir("user-other");
    const t = await resolveAgentPath(USER, WS, "c1", path.join(other, "file.txt"));
    expect(t).toBeNull();
  });

  it("truncationWriteGuard refuses writes to truncation targets", async () => {
    const truncAbs = await writeTruncation(USER, "payload");
    const target = await resolveAgentPath(USER, WS, "c1", truncAbs);
    expect(target?.isTruncation).toBe(true);
    expect(truncationWriteGuard(target)).not.toBeNull();
    const temp = await resolveAgentPath(USER, WS, "c1", path.join(ensureAgentTempDir(USER), "ok.sh"));
    expect(truncationWriteGuard(temp)).toBeNull();
  });
});

describe("resolveCommandSafety with agent temp root", () => {
  it("allows cd into the temp dir and running scripts there", () => {
    const tempDir = ensureAgentTempDir(USER);
    const safe = resolveCommandSafety(`cd "${tempDir}"; node script.js`, WS.rootDir, [tempDir]);
    expect(safe.ok).toBe(true);
    expect(safe.cwd).toBe(tempDir);
    // The resolved cd clause is consumed by design — the spawn uses the
    // tracked cwd and runs the remainder of the command.
    expect(safe.command).toBe("node script.js");
  });

  it("refuses cd that escapes the temp dir", () => {
    const tempDir = ensureAgentTempDir(USER);
    const p = path.resolve(tempDir, "..", "..");
    const safe = resolveCommandSafety(`cd "${p}"; ls`, WS.rootDir, [tempDir]);
    expect(safe.ok).toBe(false);
    expect(safe.reason).toMatch(/escapes/);
  });

  it("does NOT allow cd into the temp dir when it is not a trusted root", () => {
    const tempDir = ensureAgentTempDir(USER);
    const safe = resolveCommandSafety(`cd "${tempDir}"; node script.js`, WS.rootDir);
    expect(safe.ok).toBe(false);
    expect(safe.reason).toMatch(/escapes/);
  });

  it("keeps workspace cd semantics unchanged", () => {
    const safe = resolveCommandSafety("cd src; npm test", WS.rootDir);
    expect(safe.ok).toBe(true);
    const escape = resolveCommandSafety('cd ".."; ls', WS.rootDir);
    expect(escape.ok).toBe(false);
  });
});

describe("HERMOS_TEMP_DIR / HERMOS_TRUNCATION_DIR in spawned children", () => {
  it("reaches the child process of a background command", async () => {
    const tempDir = ensureAgentTempDir("u-env");
    const started = startBackgroundCommand(
      "u-env",
      "c-env",
      "proj",
      'node -e "console.log(process.env.HERMOS_TEMP_DIR + \'|\' + process.env.HERMOS_TRUNCATION_DIR)"',
      { rootDir: WS.rootDir },
    );
    expect(started.ok).toBe(true);
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !getCompletedCommand("u-env", "c-env")) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const completed = getCompletedCommand("u-env", "c-env");
    expect(completed?.exitCode).toBe(0);
    const stdout = completed?.stdout ?? "";
    expect(stdout.trim()).toBe(`${tempDir}|${truncationUserDir("u-env")}`);
  }, 30_000);
});