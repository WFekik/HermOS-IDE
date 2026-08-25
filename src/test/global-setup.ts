import fs from "fs";
import os from "os";
import path from "path";

/**
 * Vitest global setup/teardown — hermetic CI support.
 * Creates a temp APP_DATA_DIR (and DATABASE_URL) so `npm test` does not
 * depend on a pre-provisioned ~/.hermos DB. Provisions the schema via
 * `prisma migrate deploy` before any test imports @/lib/db.
 */
export async function setup() {
  // Create hermetic temp dir only when not already provided (allow CI override)
  let tmpDir = process.env.HERMOS_TEST_TMP_DIR || "";
  const needsCreate = !process.env.HERMOS_APP_DATA_DIR && !tmpDir;
  if (needsCreate) {
    try {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hermos-test-"));
      process.env.HERMOS_APP_DATA_DIR = tmpDir;
      process.env.HERMOS_TEST_TMP_DIR = tmpDir;
      const dbFile = path.join(tmpDir, "db", "hermos.db");
      fs.mkdirSync(path.dirname(dbFile), { recursive: true });
      const dbUrl = `file:${dbFile.replace(/\\/g, "/")}`;
      process.env.DATABASE_URL = dbUrl;

      try {
        await provisionDirect(dbUrl, dbFile);
      } catch (e) {
        console.warn("[test-setup] provision failed:", e);
      }
    } catch (e) {
      console.warn("[test-setup] failed to create hermetic DB:", e);
    }
  } else if (tmpDir) {
    // Reuse existing temp dir from env
    process.env.HERMOS_APP_DATA_DIR = tmpDir;
    process.env.HERMOS_TEST_TMP_DIR = tmpDir;
    if (!process.env.DATABASE_URL) {
      const dbFile = path.join(tmpDir, "db", "hermos.db");
      process.env.DATABASE_URL = `file:${dbFile.replace(/\\/g, "/")}`;
    }
  }
}

async function provisionDirect(dbUrl: string, dbFile: string): Promise<void> {
  try {
    const { PrismaClient } = await import("@prisma/client");
    const { provisionDatabaseIfNeeded } = await import("@/lib/provision-db");
    const prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } } as any);
    try {
      await provisionDatabaseIfNeeded({ db: prisma as any, dbUrl, dbFile });
    } finally {
      await prisma.$disconnect().catch(() => {});
    }
  } catch (e) {
    throw e;
  }
}

export async function teardown() {
  try {
    // Dynamically import to avoid errors if prisma was never initialized
    const { db } = await import("@/lib/db");
    await db.$disconnect();
  } catch {
    // ignore — db may not have been initialized in this run
  }
  // Clean hermetic temp dir
  const tmpDir = process.env.HERMOS_TEST_TMP_DIR;
  if (tmpDir) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
  // Force-exit as a final safety net in case other handles remain open
  process.exit(0);
}
