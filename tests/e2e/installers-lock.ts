// Cross-file mutex for tests that create `public/installers` fixtures.
// feature-coverage.test.ts and real-world-scenarios.test.ts run in parallel forks and
// both create `public/installers/hermos-ide-setup.msi`; without a lock, a
// fixture window from one file makes the other file's 307-redirect tests see a
// local installer (200) and fail. An atomic `wx` open provides the mutex.

import fs from "fs/promises";
import path from "path";

const LOCK_PATH = path.join(process.cwd(), "public", "installers", ".test-lock");
const LOCK_TIMEOUT_MS = 30_000;

export async function acquireInstallersLock(): Promise<void> {
  await fs.mkdir(path.dirname(LOCK_PATH), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const fd = await fs.open(LOCK_PATH, "wx");
      await fd.close();
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (Date.now() > deadline) {
        throw new Error("Timed out waiting for the installers fixture lock");
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

export async function releaseInstallersLock(): Promise<void> {
  await fs.rm(LOCK_PATH, { force: true }).catch(() => null);
}