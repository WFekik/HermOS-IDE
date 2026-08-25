import path from 'path'
import { mkdirSync } from 'fs'
import { PrismaClient } from '@prisma/client'
import { APP_DATA_DIR } from '@/lib/paths'
import {
  provisionDatabaseIfNeeded,
  sweepOrphanedUploads,
} from '@/lib/provision-db'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

/**
 * Resolve the DB URL deterministically: derives absolute SQLite path from
 * APP_DATA_DIR if unset/relative.
 */
export function resolveDatabaseUrl(envUrl: string | undefined): string {
  const derivedUrl = `file:${path.join(APP_DATA_DIR, 'db', 'hermos.db').replace(/\\/g, '/')}`
  if (!envUrl) return derivedUrl
  if (/^file:(?!([A-Za-z]:|[\\/]))/.test(envUrl)) return derivedUrl
  return envUrl
}

/** Extract the absolute SQLite file path from a `file:` URL, or null for non-file URLs. */
export function sqliteFilePathFromUrl(url: string): string | null {
  if (!/^file:/i.test(url)) return null
  let p = url.slice(5)
  if (p.startsWith('///')) p = p.slice(2) // file:///abs → /abs
  else if (p.startsWith('//')) p = p.slice(1) // file://host/path → /path (approx)
  try {
    p = decodeURIComponent(p)
  } catch {
    /* keep raw on malformed escapes */
  }
  return path.resolve(p.replace(/\//g, path.sep))
}

try {
  mkdirSync(path.join(APP_DATA_DIR, 'db'), { recursive: true })
} catch {
  /* best-effort: runtime dirs are ensured elsewhere too */
}

const resolvedUrl = resolveDatabaseUrl(process.env.DATABASE_URL)
process.env.DATABASE_URL = resolvedUrl

/** Absolute path of the SQLite db file (null when the datasource is not a local file). */
export const DB_FILE_PATH: string | null = sqliteFilePathFromUrl(resolvedUrl)

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ['warn', 'error'],
  })

if (typeof globalThis !== 'undefined') globalForPrisma.prisma = db

// First-boot provisioning guards: never fork/spawn from unit tests, during
// `next build`, or in edge runtimes (no fs/child_process there).
const isTestEnv = process.env.NODE_ENV === 'test' || process.env.VITEST === 'true'
const isBuildPhase = process.env.NEXT_PHASE === 'phase-production-build'
const isEdgeRuntime =
  typeof process === 'undefined' || process.env.NEXT_RUNTIME === 'edge'
const canProvision = !isTestEnv && !isBuildPhase && !isEdgeRuntime && !!DB_FILE_PATH

/**
 * Provision the schema on first boot (detect + migrate). Kicked off at module
 * init so a fresh desktop DB is ready before the first request; `dbReady`
 * awaits it. On failure we log the command/output and fail startup loudly
 * instead of silently serving a broken DB.
 */
export const provisionPromise: Promise<void> = (async () => {
  if (!canProvision) return
  try {
    await provisionDatabaseIfNeeded({
      db,
      dbUrl: resolvedUrl,
      dbFile: DB_FILE_PATH!,
    })
  } catch (err) {
    console.error(
      '[DB] CRITICAL: database provisioning failed — refusing to start with a broken database:',
      err,
    )
    // Fail startup loudly (the desktop launcher surfaces the non-zero exit).
    setTimeout(() => process.exit(1), 50)
    throw err
  }
})()

// Startup sweep: remove orphaned upload files (older than 24h, no Attachment
// row). Best-effort, non-blocking — never breaks boot.
if (canProvision) {
  void provisionPromise
    .then(() => sweepOrphanedUploads(db))
    .catch((err) => console.warn('[DB] Upload sweep failed:', err))
}

// Enable WAL mode & performance pragmas on SQLite connection
export const dbReady = (async () => {
  if (canProvision) {
    await provisionPromise // throws when provisioning failed → health checks report unhealthy
  }
  if (/^file:|^sqlite:/i.test(resolvedUrl)) {
    try {
      await db.$queryRawUnsafe('PRAGMA journal_mode = WAL;')
      await db.$queryRawUnsafe('PRAGMA synchronous = NORMAL;')
      await db.$queryRawUnsafe('PRAGMA busy_timeout = 5000;')
    } catch (err) {
      console.warn('[DB] Could not set WAL mode pragma:', err)
    }
  }
})()