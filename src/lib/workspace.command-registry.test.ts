/**
 * Regression tests for the running-command registry (`commandKey`): a long-running command must
 * stay discoverable/stopped-able after a NEWER command completes in the same conversation.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import path from "path";
import os from "os";
import fs from "fs/promises";
import {
  startBackgroundCommand,
  stopRunningCommand,
  getRunningCommand,
  getCompletedCommand,
  acknowledgeCompletedCommand,
  clearCompletedCommand,
} from "./workspace";

const isWin = process.platform === "win32";

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

const rand = () => Math.random().toString(36).slice(2);
const LONG_RUNNER = 'node -e "setInterval(()=>{},1000)"';

async function waitFor(cond: () => boolean, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * Kill any conversation command that is still running (belongs to the
 * cleanup phase — deliberately NOT asserted in the tests themselves, so a
 * mid-test failure cannot leak an eternal `node` process).
 */
function forceStopAll(...pairs: Array<[string, string]>): void {
  for (const [u, c] of pairs) {
    try {
      stopRunningCommand(u, c);
    } catch {
      /* best-effort cleanup */
    }
  }
}

describe("running-command registry — orphan-proof stop after alias handover", () => {
  const root = path.join(os.tmpdir(), "hermos-cmd-registry-" + rand());
  const base = path.join(root, "ws");

  beforeAll(async () => {
    await fs.mkdir(base, { recursive: true });
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });

  it(
    "command_stop kills a long-running command even after a newer command completed",
    async () => {
      const uid = "u-reg";
      const cid = "c-reg";
      clearCompletedCommand(uid, cid);
      try {
        // 1. Start a long-running process (stands in for `next start` / a dev server).
        const long = startBackgroundCommand(uid, cid, "ws-reg", LONG_RUNNER, { rootDir: base });
        expect(long.ok).toBe(true);
        await waitFor(() => getRunningCommand(uid, cid) !== null);

        // 2. A quick second command in the SAME conversation steals the alias and
        //    unregisters it on completion — the exact sequence that previously
        //    left the first command undiscoverable (stopped:false + live orphan).
        const quick = startBackgroundCommand(uid, cid, "ws-reg", 'node -e ""', { rootDir: base });
        expect(quick.ok).toBe(true);
        await waitFor(() => getCompletedCommand(uid, cid) !== null);

        // 3. The long-running command must still be resolvable via the
        //    exec-keyed fallback and must actually be stoppable.
        expect(getRunningCommand(uid, cid)).not.toBeNull();
        const stopped = stopRunningCommand(uid, cid);
        expect(stopped).toBe(true);
        expect(getRunningCommand(uid, cid)).toBeNull();
        // Stopping again reports nothing left to stop.
        expect(stopRunningCommand(uid, cid)).toBe(false);
      } finally {
        forceStopAll([uid, cid]);
      }
    },
    // The kill must traverse the real process tree (powershell → cmd → node);
    // PS spawn + tree-kill + close settling runs ~5s on loaded Windows hosts.
    30_000,
  );

  it("commands in different conversations do not interfere", async () => {
    const long = startBackgroundCommand("u-a", "c-a", "ws-reg", LONG_RUNNER, { rootDir: base });
    expect(long.ok).toBe(true);
    try {
      await waitFor(() => getRunningCommand("u-a", "c-a") !== null);

      // A quick command in another conversation completes and must not affect
      // the first conversation's registry.
      const quick = startBackgroundCommand("u-a", "c-b", "ws-reg", 'node -e ""', { rootDir: base });
      expect(quick.ok).toBe(true);
      await waitFor(() => getCompletedCommand("u-a", "c-b") !== null);

      expect(getRunningCommand("u-a", "c-a")).not.toBeNull();
      expect(stopRunningCommand("u-a", "c-a")).toBe(true);
      expect(stopRunningCommand("u-a", "c-b")).toBe(false);
    } finally {
      forceStopAll(["u-a", "c-a"], ["u-a", "c-b"]);
    }
  },
  30_000,
);

  it("propagates native failure exit codes through the shell wrapper", async () => {
    const uid = "u-exit";
    const cid = "c-exit";
    clearCompletedCommand(uid, cid);
    try {
      const started = startBackgroundCommand(uid, cid, "ws-reg", 'node -e "process.exit(8)"', {
        rootDir: base,
      });
      expect(started.ok).toBe(true);
      await waitFor(() => getCompletedCommand(uid, cid) !== null);
      const completed = getCompletedCommand(uid, cid);
      expect(completed?.exitCode).toBe(8);
      // Acknowledging must remove BOTH the alias entry and its exec-keyed
      // twin — otherwise getCompletedCommand resurrects it (duplicate
      // delivery on the next injection pass).
      acknowledgeCompletedCommand(uid, cid, started.commandId.includes(":") ? started.commandId.split(":").slice(2).join(":") : started.commandId);
      expect(getCompletedCommand(uid, cid)).toBeNull();
      await new Promise((r) => setTimeout(r, 300));
      expect(getCompletedCommand(uid, cid)).toBeNull();
    } finally {
      forceStopAll([uid, cid]);
    }
  },
  30_000,
);

it.skipIf(!isWin)(
  "propagates exit codes even when the command ends with a `#` comment",
  async () => {
    const uid = "u-comment";
    const cid = "c-comment";
    clearCompletedCommand(uid, cid);
    try {
      // The PS suffix must not be swallowed by the trailing comment — the
      // old wrapper glued it to the command's last line.
      const started = startBackgroundCommand(uid, cid, "ws-reg", 'node -e "process.exit(8)" # ci', {
        rootDir: base,
      });
      expect(started.ok).toBe(true);
      await waitFor(() => getCompletedCommand(uid, cid) !== null);
      expect(getCompletedCommand(uid, cid)?.exitCode).toBe(8);
    } finally {
      forceStopAll([uid, cid]);
    }
  },
  30_000,
);

it.skipIf(!isWin)("command_stop does not re-inject a completion for the stopped command", async () => {
  const uid = "u-stop-no";
  const cid = "c-stop-no";
  clearCompletedCommand(uid, cid);
  try {
    const started = startBackgroundCommand(uid, cid, "ws-reg", LONG_RUNNER, { rootDir: base });
    expect(started.ok).toBe(true);
    await waitFor(() => getRunningCommand(uid, cid) !== null);
    expect(stopRunningCommand(uid, cid)).toBe(true);
    // Wait out the close of the killed tree — a completion must NOT appear.
    await new Promise((r) => setTimeout(r, 1500));
    expect(getCompletedCommand(uid, cid)).toBeNull();
    expect(getRunningCommand(uid, cid)).toBeNull();
  } finally {
    forceStopAll([uid, cid]);
  }
},
  30_000,
);
});