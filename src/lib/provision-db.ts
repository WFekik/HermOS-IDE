import path from "path";
import fs from "fs";
import { spawn } from "child_process";
import type { PrismaClient } from "@prisma/client";
import { UPLOADS_ROOT } from "@/lib/paths";

/**
 * Runtime database provisioning for first boot.
 *
 * The desktop app ships a standalone Next.js server whose bundle contains the
 * Prisma query engine but NOT the prisma CLI (Next's tracer only pulls in
 * @prisma/client + .prisma/client). On first run the SQLite file does not
 * exist, so this module detects a schema-less DB and provisions it:
 *
 *   1. Prefer the prisma CLI (`node_modules/prisma/build/index.js`, or the
 *      `node_modules/.bin/prisma` shim) running `migrate deploy` against the
 *      app-data DB with DATABASE_URL set.
 *   2. If the CLI is not bundled (standalone), apply the migration SQL files
 *      directly through the bundled query engine via `$executeRawUnsafe`.
 *
 * Both paths are guarded by an exclusive lockfile (`.migrate.lock` in the db
 * dir, retried 10x/100ms) so concurrent server processes never race. On
 * failure the caller must fail startup loudly — never serve a broken DB.
 */

const LOCK_RETRIES = 10;
const LOCK_RETRY_DELAY_MS = 100;
const LOCK_STALE_MS = 60_000;
const MIGRATE_TIMEOUT_MS = 120_000;

export interface ProvisionOptions {
  db: PrismaClient;
  dbUrl: string; // resolved file: URL (already set in process.env.DATABASE_URL by db.ts)
  dbFile: string; // absolute path of the SQLite file
  cliPath?: string | null; // explicit prisma CLI script; null forces direct SQL; undefined = auto-resolve
  migrationsDir?: string;
  timeoutMs?: number;
}

function isSubpathOrEqual(target: string, base: string): boolean {
  if (!target || !base) return false;
  if (process.platform === "win32") {
    const t = target.toLowerCase();
    const b = base.toLowerCase();
    if (t === b) return true;
    const bSep = b.endsWith(path.sep) ? b : b + path.sep;
    return t.startsWith(bSep);
  }
  if (target === base) return true;
  const bSep = base.endsWith(path.sep) ? base : base + path.sep;
  return target.startsWith(bSep);
}

/** True when the schema exists (User table present). */
export async function isDatabaseProvisioned(
  db: PrismaClient,
  dbFile: string,
): Promise<boolean> {
  let stat: fs.Stats | null = null;
  try {
    stat = fs.statSync(dbFile);
  } catch {
    return false; // file missing → fresh DB
  }
  if (stat.size === 0) return false; // empty file → fresh DB
  try {
    const rows = await db.$queryRawUnsafe<Array<{ name: string }>>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='User'",
    );
    return rows.length > 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `[DB] Existing database file at ${dbFile} is not readable/provisionable (${msg}). ` +
        "Refusing to provision over an existing file — it may be corrupt.",
    );
  }
}

/** Resolve the prisma CLI script path, or null when it is not bundled. */
export function resolvePrismaCli(): string | null {
  const candidates: string[] = [];
  // cwd-anchored (dev: repo root; standalone: server.js cwd)
  candidates.push(
    path.join(process.cwd(), "node_modules", "prisma", "build", "index.js"),
    path.join(process.cwd(), "node_modules", ".bin", "prisma"),
  );
  // Standalone layout: bundled server chunks live under
  // .next-build/standalone/.next-build/server/chunks — walk up to the
  // standalone root (which contains node_modules/prisma if bundled).
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    candidates.push(
      path.join(dir, "node_modules", "prisma", "build", "index.js"),
      path.join(dir, "node_modules", ".bin", "prisma"),
    );
    dir = path.dirname(dir);
    if (!dir || dir === path.dirname(dir)) break;
  }
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** Resolve the prisma/migrations directory from cwd or the module location. */
export function resolveMigrationsDir(): string | null {
  const candidates: string[] = [path.join(process.cwd(), "prisma", "migrations")];
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    candidates.push(path.join(dir, "prisma", "migrations"));
    dir = path.dirname(dir);
    if (!dir || dir === path.dirname(dir)) break;
  }
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** Split a migration.sql into individual statements (statements end with `;` on their own line). */
function splitStatements(sql: string): string[] {
  return sql
    .split(/;\s*(?:\r?\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Apply migration SQL files directly through the bundled query engine (no CLI needed). */
async function applyMigrationsDirect(db: PrismaClient, migrationsDir: string): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(migrationsDir, { withFileTypes: true });
  } catch (err) {
    throw new Error(`[DB] Cannot read migrations dir ${migrationsDir}: ${err instanceof Error ? err.message : err}`);
  }
  const names = entries
    .filter((e) => e.isDirectory() && /^\d{14}/.test(e.name))
    .map((e) => e.name)
    .sort();
  if (names.length === 0) {
    throw new Error(`[DB] No migrations found under ${migrationsDir} — cannot provision schema.`);
  }
  try {
    await db.$queryRawUnsafe("PRAGMA busy_timeout = 10000;");
  } catch {
    /* best-effort */
  }
  for (const name of names) {
    const file = path.join(migrationsDir, name, "migration.sql");
    if (!fs.existsSync(file)) continue;
    const sql = fs.readFileSync(file, "utf8");
    for (const stmt of splitStatements(sql)) {
      await db.$executeRawUnsafe(stmt);
    }
  }
}

/** Spawn `prisma migrate deploy` via node with the given CLI script. */
function runMigrateDeploy(
  cliPath: string,
  dbUrl: string,
  cwd: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = cliPath.toLowerCase().endsWith(".js")
      ? [cliPath, "migrate", "deploy"]
      : ["migrate", "deploy"];
    const useNode = cliPath.toLowerCase().endsWith(".js");
    const child = useNode
      ? spawn(process.execPath, args, {
          cwd,
          env: { ...process.env, DATABASE_URL: dbUrl },
          stdio: ["ignore", "pipe", "pipe"],
        })
      : spawn(cliPath, args, {
          cwd,
          env: { ...process.env, DATABASE_URL: dbUrl },
          stdio: ["ignore", "pipe", "pipe"],
          shell: true,
        });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    const timer = setTimeout(() => {
      child.kill();
      reject(
        new Error(
          `[DB] prisma migrate deploy timed out after ${timeoutMs}ms. Output tail: ${stderr.slice(-4000)}`,
        ),
      );
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `[DB] prisma migrate deploy exited with code ${code}. Output tail: ${(stderr || stdout).slice(-4000)}`,
          ),
        );
      }
    });
  });
}

/** Acquire the exclusive provisioning lock (create-exclusive, retried). */
async function acquireLock(lockPath: string): Promise<void> {
  // Stale-lock recovery: a crashed process may leave the dir behind.
  try {
    const st = fs.statSync(lockPath);
    if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
      fs.rmSync(lockPath, { recursive: true, force: true });
      console.warn("[DB] Removed stale .migrate.lock");
    }
  } catch {
    /* not present */
  }
  for (let i = 0; i < LOCK_RETRIES; i++) {
    try {
      fs.mkdirSync(lockPath);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      await new Promise((r) => setTimeout(r, LOCK_RETRY_DELAY_MS));
    }
  }
  throw new Error(
    `[DB] Could not acquire provisioning lock ${lockPath} after ${LOCK_RETRIES} attempts — another process may be migrating.`,
  );
}

/**
 * Provision a fresh database. No-op when the schema already exists.
 * Throws (loudly) when provisioning is impossible.
 */
export async function provisionDatabaseIfNeeded(opts: ProvisionOptions): Promise<void> {
  const { db, dbUrl, dbFile } = opts;
  const timeoutMs = opts.timeoutMs ?? MIGRATE_TIMEOUT_MS;
  const dbDir = path.dirname(dbFile);

  let provisioned: boolean;
  try {
    provisioned = await isDatabaseProvisioned(db, dbFile);
  } catch (err) {
    console.error("[DB] CRITICAL: ", err);
    throw err;
  }
  if (provisioned) return;

  const migrationsDir = opts.migrationsDir ?? resolveMigrationsDir();
  if (!migrationsDir) {
    throw new Error(
      "[DB] CRITICAL: prisma/migrations not found (looked in cwd and module dirs). " +
        "The standalone bundle is missing the bundled prisma/ directory — rebuild with scripts/nextjs-build.mjs.",
    );
  }
  const cliPath = opts.cliPath !== undefined ? opts.cliPath : resolvePrismaCli();
  const prismaRoot = path.resolve(migrationsDir, ".."); // <root>/prisma
  const rootDir = path.resolve(prismaRoot, ".."); // <root> (cwd for the CLI)

  const lockPath = path.join(dbDir, ".migrate.lock");
  await acquireLock(lockPath);
  try {
    // Re-check under the lock: another process may have provisioned meanwhile.
    if (await isDatabaseProvisioned(db, dbFile)) return;

    console.log(
      `[DB] First boot: provisioning schema at ${dbFile}` +
        (cliPath ? ` via prisma CLI (${cliPath})` : " via bundled query engine (no prisma CLI in bundle)"),
    );
    if (cliPath) {
      await runMigrateDeploy(cliPath, dbUrl, rootDir, timeoutMs);
    } else {
      await applyMigrationsDirect(db, migrationsDir);
    }

    if (!(await isDatabaseProvisioned(db, dbFile))) {
      throw new Error(
        "[DB] Provisioning completed but the User table is still missing — schema did not apply.",
      );
    }
    console.log("[DB] Database schema provisioned.");
  } finally {
    try {
      fs.rmdirSync(lockPath);
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// Uploads cleanup (F11)
// ---------------------------------------------------------------------------

const UUID_FILE_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.[A-Za-z0-9._-]{1,64})?$/i;

/**
 * Best-effort unlink of attachment files, strictly confined to UPLOADS_ROOT
 * (realpath containment check). Never throws.
 */
export function deleteAttachmentFiles(paths: string[]): void {
  let root: string | null = null;
  try {
    root = fs.realpathSync(UPLOADS_ROOT);
  } catch {
    root = null;
  }
  for (const p of paths ?? []) {
    if (!p || typeof p !== "string") continue;
    try {
      const abs = path.resolve(p);
      if (root) {
        let real: string;
        try {
          real = fs.realpathSync(abs);
        } catch {
          continue; // already gone or unreadable — nothing to delete
        }
        if (!isSubpathOrEqual(real, root)) continue;
      }
      fs.rmSync(abs, { force: true });
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Startup sweep: remove upload files older than `olderThanMs` (default 24h)
 * that have no matching Attachment row. Only files with UUID-ish names inside
 * UPLOADS_ROOT are considered (realpath-checked). Returns the count removed.
 */
export async function sweepOrphanedUploads(
  db: PrismaClient,
  olderThanMs = 24 * 60 * 60 * 1000,
): Promise<number> {
  const cutoff = Date.now() - olderThanMs;
  let root: string;
  try {
    root = fs.realpathSync(UPLOADS_ROOT);
  } catch {
    return 0;
  }
  let userDirs: fs.Dirent[];
  try {
    userDirs = fs.readdirSync(UPLOADS_ROOT, { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const d of userDirs) {
    if (!d.isDirectory() || d.name.startsWith(".")) continue;
    const userDir = path.join(UPLOADS_ROOT, d.name);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(userDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isFile() || !UUID_FILE_RE.test(e.name)) continue;
      const abs = path.join(userDir, e.name);
      try {
        const st = fs.statSync(abs);
        if (st.mtimeMs > cutoff) continue;
        const real = fs.realpathSync(abs);
        if (!isSubpathOrEqual(real, root)) continue;
        const match = await db.attachment.findFirst({
          where: { path: abs },
          select: { id: true },
        });
        if (!match) {
          fs.unlinkSync(abs);
          removed++;
        }
      } catch {
        /* ignore unreadable/racy entries */
      }
    }
  }
  if (removed > 0) console.log(`[DB] Upload sweep removed ${removed} orphaned file(s).`);
  return removed;
}