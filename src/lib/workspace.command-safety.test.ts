/**
 * Tests for src/lib/workspace.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import path from "path";
import os from "os";
import fs from "fs/promises";
import { existsSync } from "fs";
import {
  resolveCommandSafety,
  startBackgroundCommand,
  runCommandWs,
} from "./workspace";

vi.mock("@/lib/db", () => {
  let activeWs: { id: string; name: string; rootDir: string } | null = null;
  return {
    __setMockActiveWs: (ws: { id: string; name: string; rootDir: string } | null) => {
      activeWs = ws;
    },
    db: {
      workspace: {
        findFirst: vi.fn(async () => activeWs),
        upsert: vi.fn(async () => ({ id: "ws-1" })),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
      user: {
        update: vi.fn(async () => ({})),
      },
    },
  };
});

const isWin = process.platform === "win32";
const rand = () => Math.random().toString(36).slice(2);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveCommandSafety — leading cd clause", () => {
  const root = path.join(os.tmpdir(), "hermos-cmd-safety-" + rand());
  const base = path.join(root, "base");
  const outside = path.join(root, "outside");
  beforeAll(async () => {
    await fs.mkdir(path.join(base, "inside-dir"), { recursive: true });
    await fs.mkdir(path.join(base, "subdir"), { recursive: true });
    await fs.mkdir(outside, { recursive: true });
  });
  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("allows `cd inside-dir && npm run dev` (strips cd, runs at resolved cwd)", () => {
    const r = resolveCommandSafety("cd inside-dir && npm run dev", base);
    expect(r.ok).toBe(true);
    expect(r.command).toBe("npm run dev");
    expect(r.cwd).toBe(path.join(base, "inside-dir"));
  });

  it("allows `cd inside-dir; npm run dev` (semicolon separator)", () => {
    const r = resolveCommandSafety("cd inside-dir; npm run dev", base);
    expect(r.ok).toBe(true);
    expect(r.command).toBe("npm run dev");
    expect(r.cwd).toBe(path.join(base, "inside-dir"));
  });

  it("allows a quoted cd target", () => {
    const r = resolveCommandSafety('cd "inside-dir" && npm run dev', base);
    expect(r.ok).toBe(true);
    expect(r.command).toBe("npm run dev");
    expect(r.cwd).toBe(path.join(base, "inside-dir"));
  });

  it("allows a standalone `cd inside-dir` that stays inside the base", () => {
    const r = resolveCommandSafety("cd inside-dir", base);
    expect(r.ok).toBe(true);
    expect(r.cwd).toBe(path.join(base, "inside-dir"));
  });

  it("allows `cd missing-dir && x` (nonexistent target: shell fails harmlessly, runs at base)", () => {
    const r = resolveCommandSafety("cd missing-dir && x", base);
    expect(r.ok).toBe(true);
    expect(r.command).toBe("cd missing-dir && x");
    expect(r.cwd).toBe(base);
  });

  it("allows `x && cd subdir && y` (mid-chain cd to an existing inside dir)", () => {
    const r = resolveCommandSafety("x && cd subdir && y", base);
    expect(r.ok).toBe(true);
    expect(r.command).toBe("x && cd subdir && y");
    expect(r.cwd).toBe(base);
  });

  it("allows a chained relative `cd subdir && cd .. && x` (stays inside)", () => {
    const r = resolveCommandSafety("cd subdir && cd .. && x", base);
    expect(r.ok).toBe(true);
    expect(r.command).toBe("cd .. && x");
    expect(r.cwd).toBe(path.join(base, "subdir"));
  });

  it("allows `x | cd subdir | y` (pipe-separated mid-chain cd)", () => {
    const r = resolveCommandSafety("x | cd subdir | y", base);
    expect(r.ok).toBe(true);
    expect(r.cwd).toBe(base);
  });

  it("refuses `cd ../outside && x` when it resolves to an existing dir outside the base", () => {
    const r = resolveCommandSafety("cd ../outside && x", base);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/cd target escapes the workspace root/);
    expect(r.reason).toContain("../outside");
  });

  it("refuses `x && cd ../outside && y` (mid-chain escape)", () => {
    const r = resolveCommandSafety("x && cd ../outside && y", base);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/cd target escapes the workspace root/);
    expect(r.reason).toContain('(segment: "cd ../outside")');
  });

  it("allows nonexistent mid-chain cd targets (`x && cd missing && y`)", () => {
    const r = resolveCommandSafety("x && cd missing && y", base);
    expect(r.ok).toBe(true);
    expect(r.command).toBe("x && cd missing && y");
    expect(r.cwd).toBe(base);
  });
});

describe.skipIf(!isWin)("resolveCommandSafety — Windows cmd.exe forms", () => {
  const root = path.join(os.tmpdir(), "hermos-cmd-safety-win-" + rand());
  const base = path.join(root, "base");
  beforeAll(async () => {
    await fs.mkdir(path.join(base, "inside-dir"), { recursive: true });
    await fs.mkdir(path.join(base, "subdir"), { recursive: true });
  });
  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("refuses `cd C:\\Windows && x` (absolute existing path outside base)", () => {
    const r = resolveCommandSafety("cd C:\\Windows && x", base);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/cd target escapes the workspace root/);
    expect(r.reason).toContain("C:\\Windows");
  });

  it("refuses `cd /d C:\\Windows && x`", () => {
    const r = resolveCommandSafety("cd /d C:\\Windows && x", base);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/cd target escapes the workspace root/);
  });

  it("refuses `cd /D C:\\Windows && x` (case-insensitive flag)", () => {
    const r = resolveCommandSafety("cd /D C:\\Windows && x", base);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/cd target escapes the workspace root/);
  });

  it("strips `cd /d <inside-dir>` when it stays inside the base", () => {
    const r = resolveCommandSafety("cd /d inside-dir && x", base);
    expect(r.ok).toBe(true);
    expect(r.command).toBe("x");
    expect(r.cwd).toBe(path.join(base, "inside-dir"));
  });

  it("refuses `cd ..\\outside && x` (backslash traversal to existing dir)", async () => {
    const outside = path.join(root, "outside");
    await fs.mkdir(outside, { recursive: true });
    const r = resolveCommandSafety("cd ..\\outside && x", base);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/cd target escapes the workspace root/);
    await fs.rm(outside, { recursive: true, force: true });
  });

  it("refuses `x && cd C:\\ && y` (mid-chain absolute escape)", () => {
    const r = resolveCommandSafety("x && cd C:\\ && y", base);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/cd target escapes the workspace root/);
  });

  it("refuses `x && pushd C:\\Windows && y` (pushd escape)", () => {
    const r = resolveCommandSafety("x && pushd C:\\Windows && y", base);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/cd target escapes the workspace root/);
  });

  it("refuses `cd %USERPROFILE% && x` (shell-expansion target, unverifiable)", () => {
    const r = resolveCommandSafety("cd %USERPROFILE% && x", base);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/unverifiable shell expansion/);
  });

  it("allows bare `cd` (cmd prints the cwd)", () => {
    const r = resolveCommandSafety("cd", base);
    expect(r.ok).toBe(true);
  });

  it("refuses `cd\"C:\\Windows\" && x` (concatenated quote, no whitespace)", () => {
    const r = resolveCommandSafety('cd"C:\\Windows" && x', base);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/cd target escapes the workspace root/);
    expect(r.reason).toContain("C:\\Windows");
  });

  it("refuses `cd /d\"C:\\Windows\" && x` (flag with attached quote)", () => {
    const r = resolveCommandSafety('cd /d"C:\\Windows" && x', base);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/cd target escapes the workspace root/);
  });

  it("refuses `cd /dC:\\Windows && x` (flag with no whitespace or quote)", () => {
    const r = resolveCommandSafety("cd /dC:\\Windows && x", base);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/cd target escapes the workspace root/);
  });

  it("allows `cd\"subdir\" && x` when the quoted target exists inside the base", () => {
    const r = resolveCommandSafety('cd"subdir" && x', base);
    expect(r.ok).toBe(true);
    expect(r.command).toBe("x");
    expect(r.cwd).toBe(path.join(base, "subdir"));
  });

  it("refuses `cd\"../outside\" && x` (POSIX concatenated-quote traversal)", async () => {
    const outside = path.join(root, "outside");
    await fs.mkdir(outside, { recursive: true });
    const r = resolveCommandSafety('cd"../outside" && x', base);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/cd target escapes the workspace root/);
    await fs.rm(outside, { recursive: true, force: true });
  });

  it("allows `cd \"subdir\"` with quotes kept (still stripped by the shell)", () => {
    const r = resolveCommandSafety('cd "subdir"', base);
    expect(r.ok).toBe(true);
    expect(r.cwd).toBe(path.join(base, "subdir"));
  });

  it("refuses `sl -Path C:\\Windows` (PowerShell parameter flag as cd target)", () => {
    const r = resolveCommandSafety("sl -Path C:\\Windows", base);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/PowerShell parameter flag/);
  });

  it("refuses `cd -LiteralPath C:\\Windows`", () => {
    const r = resolveCommandSafety("cd -LiteralPath C:\\Windows", base);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/PowerShell parameter flag/);
  });

  it("refuses leading `cd -P C:\\Windows` (abbreviated parameter)", () => {
    const r = resolveCommandSafety("cd -P C:\\Windows", base);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/PowerShell parameter flag/);
  });

  it("refuses `cd C:\\Wi*dows` (wildcard expansion, unverifiable)", () => {
    const r = resolveCommandSafety("cd C:\\Wi*dows", base);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/shell expansion/);
  });

  it("refuses `cd C:\\Win`dows` (backtick escape)", () => {
    const r = resolveCommandSafety("cd C:\\Win`dows", base);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/shell expansion/);
  });

  it("allows a quoted `cd \"-child\"` (dash is literal inside quotes)", () => {
    const r = resolveCommandSafety('cd "-child"', base);
    expect(r.ok).toBe(true);
  });
});

describe.skipIf(isWin)("resolveCommandSafety — POSIX forms", () => {
  const root = path.join(os.tmpdir(), "hermos-cmd-safety-posix-" + rand());
  const base = path.join(root, "base");
  beforeAll(async () => {
    await fs.mkdir(base, { recursive: true });
  });
  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("refuses `cd ~ && x` (unverifiable expansion)", () => {
    const r = resolveCommandSafety("cd ~ && x", base);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/unverifiable shell expansion/);
  });

  it("refuses `cd $HOME && x` (unverifiable expansion)", () => {
    const r = resolveCommandSafety("cd $HOME && x", base);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/unverifiable shell expansion/);
  });

  it("refuses bare `cd` (goes to $HOME = escape)", () => {
    const r = resolveCommandSafety("cd", base);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/bare cd without a target/);
  });

  it("refuses `cd && x` (bare cd with a continuation)", () => {
    const r = resolveCommandSafety("cd && x", base);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/bare cd without a target/);
  });

  it("refuses `cd\"../outside\" && x` (concatenated quote, no whitespace)", async () => {
    const outside = path.join(root, "outside");
    await fs.mkdir(outside, { recursive: true });
    const r = resolveCommandSafety('cd"../outside" && x', base);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/cd target escapes the workspace root/);
    expect(r.reason).toContain("../outside");
    await fs.rm(outside, { recursive: true, force: true });
  });
});

describe("resolveCommandSafety — nested shell spawners with execution flags", () => {
  const root = path.join(os.tmpdir(), "hermos-cmd-nested-" + rand());
  const base = path.join(root, "base");
  const outside = path.join(root, "outside");
  let symlinkOk = false;
  beforeAll(async () => {
    await fs.mkdir(path.join(base, "inside-dir"), { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    try {
      await fs.symlink(outside, path.join(base, "escape-link"), isWin ? "junction" : "dir");
      symlinkOk = true;
    } catch {
      symlinkOk = false;
    }
  });
  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it.skipIf(!isWin)("refuses `cmd /c \"cd C:\\Windows && x\"` (escaping inner cd)", () => {
    const r = resolveCommandSafety('cmd /c "cd C:\\Windows && x"', base);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/nested shell with an execution flag/);
  });

  it.skipIf(!isWin)("refuses `cmd.exe /c \"cd C:\\Windows\"` (dot-suffixed binary)", () => {
    const r = resolveCommandSafety('cmd.exe /c "cd C:\\Windows"', base);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/nested shell with an execution flag/);
  });

  it("refuses `bash -c \"cd ../outside && x\"` (escaping inner cd)", () => {
    const r = resolveCommandSafety('bash -c "cd ../outside && x"', base);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/nested shell with an execution flag/);
  });

  it("refuses `powershell -Command \"Set-Location C:\\\"` (PS verbs are outside the cd grammar)", () => {
    const r = resolveCommandSafety('powershell -Command "Set-Location C:\\"', base);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/nested shell with an execution flag/);
  });

  it("refuses `sh -x -c \"cd ../outside && x\"` (option flags before the exec flag)", () => {
    const r = resolveCommandSafety('sh -x -c "cd ../outside && x"', base);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/nested shell with an execution flag/);
  });

  it("refuses `bash -lc \"cd ../outside && x\"` (combined short flags)", () => {
    const r = resolveCommandSafety('bash -lc "cd ../outside && x"', base);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/nested shell with an execution flag/);
  });

  it.skipIf(!isWin)("refuses `cmd /q /c \"cd C:\\Windows\"` (cmd option flags before /c)", () => {
    const r = resolveCommandSafety('cmd /q /c "cd C:\\Windows"', base);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/nested shell with an execution flag/);
  });

  it("refuses `powershell -NoProfile -Command \"Set-Location C:\\\"`", () => {
    const r = resolveCommandSafety('powershell -NoProfile -Command "Set-Location C:\\"', base);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/nested shell with an execution flag/);
  });

  it("refuses `powershell /command \"Set-Location C:\\\"` (slash-prefixed flag)", () => {
    const r = resolveCommandSafety('powershell /command "Set-Location C:\\"', base);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/nested shell with an execution flag/);
  });

  it("refuses `env bash -c \"cd ../outside && x\"` (spawner hidden behind env prefix)", () => {
    const r = resolveCommandSafety('env bash -c "cd ../outside && x"', base);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/nested shell with an execution flag/);
  });

  it("allows `sh script.sh` (no execution flag)", () => {
    const r = resolveCommandSafety("sh script.sh", base);
    expect(r.ok).toBe(true);
    expect(r.command).toBe("sh script.sh");
  });

  it("allows `x && bash -c y` (inline command has no escaping cd)", () => {
    const r = resolveCommandSafety("x && bash -c y", base);
    expect(r.ok).toBe(true);
    expect(r.command).toBe("x && bash -c y");
  });

  it("refuses `x && bash -c \"cd ../outside && y\"` (escaping inner cd in a later segment)", () => {
    const r = resolveCommandSafety('x && bash -c "cd ../outside && y"', base);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/nested shell with an execution flag/);
  });

  it("allows `git log --oneline` / `git commit -c msg` (no spawner before the flag)", () => {
    const r = resolveCommandSafety("git log --oneline && git commit -c msg", base);
    expect(r.ok).toBe(true);
    expect(r.command).toBe("git log --oneline && git commit -c msg");
  });

  it("allows `bash -c \"npm run dev\"` (safe quoted inline command)", () => {
    const r = resolveCommandSafety('bash -c "npm run dev"', base);
    expect(r.ok).toBe(true);
    expect(r.command).toBe('bash -c "npm run dev"');
  });

  it("allows `cmd /c \"npm test\"` (legitimate Windows idiom)", () => {
    const r = resolveCommandSafety('cmd /c "npm test"', base);
    expect(r.ok).toBe(true);
    expect(r.command).toBe('cmd /c "npm test"');
  });

  it("refuses `dash -c \"cd ../outside && x\"` (Debian /bin/sh)", () => {
    const r = resolveCommandSafety('dash -c "cd ../outside && x"', base);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/nested shell with an execution flag/);
  });

  it("refuses `ash -c \"cd ../outside && x\"` (Alpine /bin/sh)", () => {
    const r = resolveCommandSafety('ash -c "cd ../outside && x"', base);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/nested shell with an execution flag/);
  });

  it("refuses `busybox sh -c \"cd ../outside && x\"`", () => {
    const r = resolveCommandSafety('busybox sh -c "cd ../outside && x"', base);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/nested shell with an execution flag/);
  });

  it("refuses `wsl bash -c \"cd /tmp\"` (wsl blanket)", () => {
    const r = resolveCommandSafety('wsl bash -c "cd /tmp"', base);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/nested shell with an execution flag/);
  });

  it("refuses `wsl.exe --command \"cd /tmp\"` (wsl exec flag)", () => {
    const r = resolveCommandSafety('wsl.exe --command "cd /tmp"', base);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/nested shell with an execution flag/);
  });

  it("refuses `wsl -e bash` (wsl-only -e flag)", () => {
    const r = resolveCommandSafety("wsl -e bash", base);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/nested shell with an execution flag/);
  });

  it("allows `echo bash -c hi` (the flag has no spawner-inline command)", () => {
    const r = resolveCommandSafety("echo bash -c hi", base);
    expect(r.ok).toBe(true);
  });

  it("allows `bash deploy.sh -c prod` (script path between spawner and flag)", () => {
    const r = resolveCommandSafety("bash deploy.sh -c prod", base);
    expect(r.ok).toBe(true);
    expect(r.command).toBe("bash deploy.sh -c prod");
  });

  it.skipIf(!isWin)("refuses `cmd /c \"cd\" C:\\Windows` (cmd strips the first/last quote of the remainder)", () => {
    const r = resolveCommandSafety('cmd /c "cd" C:\\Windows', base);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/nested shell with an execution flag/);
  });

  it.skipIf(!isWin)("refuses `start \"title\" cmd /c \"cd C:\\Windows\"` (prefix before the spawner)", () => {
    const r = resolveCommandSafety('start "title" cmd /c "cd C:\\Windows"', base);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/nested shell with an execution flag/);
  });

  it("refuses `bash -c \"cd \\\"../outside\\\" && pwd\"` (escaped quotes in the inline command)", () => {
    const r = resolveCommandSafety('bash -c "cd \\"../outside\\" && pwd"', base);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/nested shell with an execution flag/);
  });

  it("refuses `bash -c\"cd ../outside\"` (attached-value exec flag)", () => {
    const r = resolveCommandSafety('bash -c"cd ../outside"', base);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/nested shell with an execution flag/);
  });

  it("refuses `bash -ccd ../outside` (bundled flag with attached value)", () => {
    const r = resolveCommandSafety("bash -ccd ../outside", base);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/nested shell with an execution flag/);
  });

  it.skipIf(!isWin)("refuses `cmd /c\"cd C:\\Windows\"` (cmd attached-value exec flag)", () => {
    const r = resolveCommandSafety('cmd /c"cd C:\\Windows"', base);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/nested shell with an execution flag/);
  });

  it("refuses `x && sh -c\"cd ../outside\"` (attached value after a chain)", () => {
    const r = resolveCommandSafety('x && sh -c"cd ../outside"', base);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/nested shell with an execution flag/);
  });

  it("refuses `bash \"-c\" \"cd ../outside && x\"` (quoted exec flag)", () => {
    const r = resolveCommandSafety('bash "-c" "cd ../outside && x"', base);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/nested shell with an execution flag/);
  });

  it.skipIf(isWin)("refuses `X=1 cd /etc` (env-assignment prefix hides the cd)", () => {
    const r = resolveCommandSafety("X=1 cd /etc", base);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/cd target escapes the workspace root/);
  });

  it.skipIf(isWin)("refuses `command cd /etc` (builtin keyword prefix)", () => {
    const r = resolveCommandSafety("command cd /etc", base);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/cd target escapes the workspace root/);
  });

  it.skipIf(isWin)("refuses `cd ../outside # comment && ls` (POSIX comment hides the target)", () => {
    const r = resolveCommandSafety("cd ../outside # comment && ls", base);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/cd target escapes the workspace root/);
  });

  it.skipIf(!isWin)("refuses `\"cd\" C:\\Windows && dir` (quoted builtin)", () => {
    const r = resolveCommandSafety('"cd" C:\\Windows && dir', base);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/cd target escapes the workspace root/);
  });

  it.skipIf(!isWin)("refuses `chdir C:\\Windows && x` (cmd alias)", () => {
    const r = resolveCommandSafety("chdir C:\\Windows && x", base);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/cd target escapes the workspace root/);
  });

  it.skipIf(isWin)("refuses `'cd' /tmp && ls` (quoted builtin, POSIX)", () => {
    const r = resolveCommandSafety("'cd' /tmp && ls", base);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/cd target escapes the workspace root/);
  });

  it.skipIf(isWin)("refuses `` cd `echo /tmp` && ls `` (command substitution)", () => {
    const r = resolveCommandSafety("cd `echo /tmp` && ls", base);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/cd target contains unverifiable shell expansion/);
  });

  it.skipIf(!symlinkOk)("refuses `cd escape-link && x` (symlink inside base pointing outside)", () => {
    const r = resolveCommandSafety("cd escape-link && x", base);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/cd target escapes the workspace root/);
  });

  it("allows `\"cd\" inside-dir && npm run dev` (quoted builtin with a safe target)", () => {
    const r = resolveCommandSafety('"cd" inside-dir && npm run dev', base);
    expect(r.ok).toBe(true);
    expect(r.command).toBe('"cd" inside-dir && npm run dev');
  });
});

describe("HERMOS_ENABLE_COMMANDS gate", () => {
  const base = path.join(os.tmpdir(), "hermos-cmd-gate-" + rand());
  beforeAll(async () => {
    await fs.mkdir(base, { recursive: true });
  });
  afterAll(async () => {
    await fs.rm(base, { recursive: true, force: true });
  });

  it("startBackgroundCommand returns a blocked result when the gate is closed", () => {
    vi.stubEnv("HERMOS_ENABLE_COMMANDS", "false");
    const res = startBackgroundCommand("u1", "c1", "ws1", "echo hi", { rootDir: base });
    expect(res.ok).toBe(false);
    expect(res.commandId).toBe("");
    expect(res.error).toBe(
      "Terminal commands are disabled on this deployment (set HERMOS_ENABLE_COMMANDS=true to enable)",
    );
  });

  it("runCommandWs returns a blocked result when the gate is closed (no throw, no 500)", async () => {
    vi.stubEnv("HERMOS_ENABLE_COMMANDS", "false");
    const res = await runCommandWs("u1", "ws1", "echo hi");
    expect(res.ok).toBe(false);
    expect(res.blocked).toBe(true);
    expect(res.exitCode).toBe(126);
    expect(res.reason).toBe(
      "Terminal commands are disabled on this deployment (set HERMOS_ENABLE_COMMANDS=true to enable)",
    );
  });

  it("commands run when the gate is open or unset", async () => {
    vi.stubEnv("HERMOS_ENABLE_COMMANDS", "true");
    const { __setMockActiveWs } = (await import("@/lib/db")) as {
      __setMockActiveWs: (ws: { id: string; name: string; rootDir: string } | null) => void;
    };
    __setMockActiveWs({ id: "ws-1", name: "ws1", rootDir: base });
    const res = await runCommandWs("u1", "ws1", "echo hello");
    expect(res.ok).toBe(true);
    expect(res.stdout).toContain("hello");
  });
});

describe("startBackgroundCommand — sandbox enforcement", () => {
  const root = path.join(os.tmpdir(), "hermos-cmd-bg-" + rand());
  const base = path.join(root, "base");
  const outside = path.join(root, "outside");
  beforeAll(async () => {
    await fs.mkdir(base, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
  });
  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("refuses an escaping cd without spawning", () => {
    const r = startBackgroundCommand("u1", "c1", "ws1", "cd ../outside && x", {
      rootDir: base,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/cd target escapes the workspace root/);
  });

  it("returns a blocked result when the resolved cwd is missing (dead rootDir)", () => {
    const dead = path.join(root, "dead");
    const r = startBackgroundCommand("u1", "c1", "ws1", "echo hi", { rootDir: dead });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Command cwd is outside the workspace root or missing/);
  });
});

describe.skipIf(!isWin)("resolveCommandSafety — PowerShell statement forms", () => {
  const root = path.join(os.tmpdir(), "hermos-cmd-safety-ps-" + rand());
  const base = path.join(root, "base");
  const outside = path.join(root, "outside");
  beforeAll(async () => {
    await fs.mkdir(path.join(base, "subdir"), { recursive: true });
    await fs.mkdir(outside, { recursive: true });
  });
  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("refuses `cd C:\\Windows -PassThru` (trailing switch belongs to the cd)", () => {
    const r = resolveCommandSafety("cd C:\\Windows -PassThru", base);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/cd target escapes the workspace root/);
  });

  it("refuses `cd C:\\Windows 2>&1 && x` (redirect handle digits are cd glue)", () => {
    const r = resolveCommandSafety("cd C:\\Windows 2>&1 && x", base);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/cd target escapes the workspace root/);
  });

  it("refuses `cd ..\\outside 2>&1 && x` (raw-suffix peel keeps the separator)", () => {
    const r = resolveCommandSafety("cd ..\\outside 2>&1 && x", base);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/cd target escapes the workspace root/);
  });

  it("refuses `cd ..\\outside -PassThru` (trailing flag after a traversal target)", () => {
    const r = resolveCommandSafety("cd ..\\outside -PassThru", base);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/cd target escapes the workspace root/);
  });

  it("allows `cd C:\\DirectoryName 1` when no glued prefix exists (no false positive)", () => {
    const r = resolveCommandSafety("cd C:\\DirectoryName 1", base);
    expect(r.ok).toBe(true);
  });

  it("refuses `(cd C:\\Windows)` (parenthesized statement)", () => {
    const r = resolveCommandSafety("(cd C:\\Windows)", base);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/cd target escapes the workspace root/);
  });

  it("refuses `& { cd C:\\Windows }` (script-block wrapper)", () => {
    const r = resolveCommandSafety("& { cd C:\\Windows }", base);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/cd target escapes the workspace root/);
  });

  it("refuses `$(cd C:\\Windows)` (subexpression wrapper)", () => {
    const r = resolveCommandSafety("$(cd C:\\Windows)", base);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/cd target escapes the workspace root/);
  });

  it("refuses `if ($true) { cd C:\\Windows }` (control-block wrapper)", () => {
    const r = resolveCommandSafety("if ($true) { cd C:\\Windows }", base);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/cd target escapes the workspace root/);
  });

  it("refuses `& {cd C:\\Windows}` (glued script-block wrapper)", () => {
    const r = resolveCommandSafety("& {cd C:\\Windows}", base);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/cd target escapes the workspace root/);
  });

  it("refuses `$(& {cd C:\\Windows})` and `@(& {cd C:\\Windows})` (glued subexpression/array wrappers)", () => {
    expect(resolveCommandSafety("$(& {cd C:\\Windows})", base).ok).toBe(false);
    expect(resolveCommandSafety("@(& {cd C:\\Windows})", base).ok).toBe(false);
  });

  it("refuses `& {sl C:\\Windows}` and `& {cd ..}` (PS alias / traversal inside a glued block)", () => {
    expect(resolveCommandSafety("& {sl C:\\Windows}", base).ok).toBe(false);
    expect(resolveCommandSafety("& {cd ..}", base).ok).toBe(false);
  });

  it("refuses `if($true){cd C:\\Windows}` and other glued control blocks", () => {
    expect(resolveCommandSafety("if($true){cd C:\\Windows}", base).ok).toBe(false);
    expect(resolveCommandSafety("while($true){cd C:\\Windows}", base).ok).toBe(false);
    expect(resolveCommandSafety("switch($x){1{cd C:\\Windows}}", base).ok).toBe(false);
    expect(resolveCommandSafety("try{cd C:\\Windows}catch{}", base).ok).toBe(false);
    expect(resolveCommandSafety("for($i=0;$i -lt 1;$i++){cd C:\\Windows}", base).ok).toBe(false);
  });

  it("refuses dot-source wrappers (`.{cd ...}`, `. {cd ...}`, `.(cd ...)`)", () => {
    expect(resolveCommandSafety(".{cd C:\\Windows}", base).ok).toBe(false);
    expect(resolveCommandSafety(". {cd C:\\Windows}", base).ok).toBe(false);
    expect(resolveCommandSafety(".(cd C:\\Windows)", base).ok).toBe(false);
  });

  it("refuses `iex 'cd C:\\Windows'` / `Invoke-Expression 'cd C:\\Windows'` (full evaluator)", () => {
    expect(resolveCommandSafety("iex 'cd C:\\Windows'", base).ok).toBe(false);
    expect(resolveCommandSafety("Invoke-Expression 'cd C:\\Windows'", base).ok).toBe(false);
    expect(resolveCommandSafety("if($true){iex 'cd C:\\Windows'}", base).ok).toBe(false);
  });

  it("allows `iex` as a plain argument (`npm run iex`, `echo iex C:\\Windows`)", () => {
    expect(resolveCommandSafety("npm run iex", base).ok).toBe(true);
    expect(resolveCommandSafety("echo iex C:\\Windows", base).ok).toBe(true);
  });

  it("refuses a bare script-block literal `{cd C:\\Windows}` (byte-identical to the invoked form)", () => {
    const r = resolveCommandSafety("{cd C:\\Windows}", base);
    expect(r.ok).toBe(false);
  });

  it("refuses `cd C:\\Windows\\rpwd` (bare CR is a statement separator)", () => {
    const r = resolveCommandSafety("cd C:\\Windows\rpwd", base);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/cd target escapes the workspace root/);
  });

  it("refuses `cd C:\\Windows -ErrorAction Stop -PassThru` (flag values must not break the peel)", () => {
    const r = resolveCommandSafety("cd C:\\Windows -ErrorAction Stop -PassThru", base);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/cd target escapes the workspace root/);
  });

  it("allows `cd C:\\DirectoryName 1 -PassThru` when no peeled candidate exists (cut-advance is not over-broad)", () => {
    const r = resolveCommandSafety("cd C:\\DirectoryName 1 -PassThru", base);
    expect(r.ok).toBe(true);
  });

  it("allows `echo cd C:\\Windows` (mid-token `cd` is just an argument)", () => {
    const r = resolveCommandSafety("echo cd C:\\Windows", base);
    expect(r.ok).toBe(true);
  });

  it("refuses `cd C:\\Windows\\npwd` (newline statement separator)", () => {
    const r = resolveCommandSafety("cd C:\\Windows\npwd", base);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/cd target escapes the workspace root/);
  });

  it("allows `cd subdir\\nnpm run dev` and tracks the cwd across lines", () => {
    const r = resolveCommandSafety("cd subdir\nnpm run dev", base);
    expect(r.ok).toBe(true);
    expect(r.cwd).toBe(path.join(base, "subdir"));
    expect(r.command).toContain("npm run dev");
  });

  it("refuses an escaping cd on a later line (`echo hi\\ncd ..\\outside`)", () => {
    const r = resolveCommandSafety("echo hi\ncd ..\\outside", base);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/cd target escapes the workspace root/);
  });

  it("refuses `start \"title\" /D C:\\Windows app.exe` (title form)", () => {
    const r = resolveCommandSafety('start "title" /D C:\\Windows app.exe', base);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/cd target escapes the workspace root/);
  });

  it("allows `start /D subdir app.exe` when the target stays inside the base", () => {
    const r = resolveCommandSafety("start /D subdir app.exe", base);
    expect(r.ok).toBe(true);
  });

  it("refuses `cmd /d C:\\Windows` in NOTHING — /d is refused only after a cd-type first token or spawner (cmd /d is not a cd)", () => {
    const r = resolveCommandSafety("cmd /d C:\\Windows && x", base);
    expect(r.ok).toBe(true);
  });
});

describe("runCommandWs — sandbox enforcement", () => {
  const root = path.join(os.tmpdir(), "hermos-cmd-ws-" + rand());
  const base = path.join(root, "base");
  const outside = path.join(root, "outside");
  beforeAll(async () => {
    await fs.mkdir(base, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
  });
  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("returns a blocked result for an escaping cd (never runs it)", async () => {
    const { __setMockActiveWs } = (await import("@/lib/db")) as {
      __setMockActiveWs: (ws: { id: string; name: string; rootDir: string } | null) => void;
    };
    __setMockActiveWs({ id: "ws-1", name: "ws1", rootDir: base });
    const res = await runCommandWs("u1", "ws1", "cd ../outside && x");
    expect(res.ok).toBe(false);
    expect(res.blocked).toBe(true);
    expect(res.exitCode).toBe(126);
    expect(res.reason).toMatch(/cd target escapes the workspace root/);
    expect(res.stdout).toBe("");
  });

  it("returns a blocked result when the resolved cwd is missing (fallback path is dead)", async () => {
    const appData = path.join(os.tmpdir(), "hermos-dead-ws-" + rand());
    vi.stubEnv("HERMOS_APP_DATA_DIR", appData);
    const { __setMockActiveWs } = (await import("@/lib/db")) as {
      __setMockActiveWs: (ws: { id: string; name: string; rootDir: string } | null) => void;
    };
    __setMockActiveWs(null);
    vi.resetModules();
    const ws = await import("./workspace");
    const res = await ws.runCommandWs("u-dead", "ws-dead", "echo hi");
    expect(res.ok).toBe(false);
    expect(res.blocked).toBe(true);
    expect(res.exitCode).toBe(126);
    expect(res.reason).toMatch(/Command cwd is outside the workspace root or missing/);
    await fs.rm(appData, { recursive: true, force: true }).catch(() => {});
  });
});

describe("persistent default workspaces (WORKSPACES_ROOT, not os.tmpdir)", () => {
  let appData = "";
  const cleanup: string[] = [];

  async function freshWorkspace() {
    vi.resetModules();
    const ws = await import("./workspace");
    const paths = await import("@/lib/paths");
    return { ...ws, WORKSPACES_ROOT: paths.WORKSPACES_ROOT };
  }

  afterEach(async () => {
    vi.unstubAllEnvs();
    for (const dir of cleanup) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    cleanup.length = 0;
  });

  it("openWorkspace defaults to WORKSPACES_ROOT/userId/name", async () => {
    appData = path.join(os.tmpdir(), "hermos-default-ws-" + rand());
    cleanup.push(appData);
    vi.stubEnv("HERMOS_APP_DATA_DIR", appData);
    const ws = await freshWorkspace();
    const info = await ws.openWorkspace("u1", "my-ws");
    expect(info.rootDir).toBe(path.join(ws.WORKSPACES_ROOT, "u1", "my-ws"));
    expect(ws.WORKSPACES_ROOT).toBe(path.join(appData, "workspaces"));
  });

  it("openWorkspace honors an explicit rootDir", async () => {
    appData = path.join(os.tmpdir(), "hermos-default-ws-" + rand());
    cleanup.push(appData);
    vi.stubEnv("HERMOS_APP_DATA_DIR", appData);
    const ws = await freshWorkspace();
    const explicit = path.join(os.tmpdir(), "hermos-explicit-" + rand());
    cleanup.push(explicit);
    const info = await ws.openWorkspace("u1", "explicit-ws", explicit);
    expect(info.rootDir).toBe(explicit);
  });

  it("openWorkspace ensures the workspace dir exists on disk", async () => {
    appData = path.join(os.tmpdir(), "hermos-default-ws-" + rand());
    cleanup.push(appData);
    vi.stubEnv("HERMOS_APP_DATA_DIR", appData);
    const ws = await freshWorkspace();
    const info = await ws.openWorkspace("u1", "mkdir-ws");
    expect(info.rootDir).toBe(path.join(ws.WORKSPACES_ROOT, "u1", "mkdir-ws"));
    expect(existsSync(info.rootDir)).toBe(true);
  });

  it("ensureDefaultWorkspace uses WORKSPACES_ROOT/userId and mkdirs it", async () => {
    appData = path.join(os.tmpdir(), "hermos-default-ws-" + rand());
    cleanup.push(appData);
    vi.stubEnv("HERMOS_APP_DATA_DIR", appData);
    const ws = await freshWorkspace();
    const info = await ws.ensureDefaultWorkspace("u1");
    expect(info.rootDir).toBe(path.join(ws.WORKSPACES_ROOT, "u1"));
    expect(existsSync(info.rootDir)).toBe(true);
  });

  it("ensureDefaultWorkspace never points into os.tmpdir()/.hermos", async () => {
    appData = path.join(os.tmpdir(), "hermos-default-ws-" + rand());
    cleanup.push(appData);
    vi.stubEnv("HERMOS_APP_DATA_DIR", appData);
    const ws = await freshWorkspace();
    const info = await ws.ensureDefaultWorkspace("u1");
    expect(info.rootDir).not.toContain(path.join(os.tmpdir(), ".hermos"));
  });
});
