# Contributing to HermOS IDE

Thank you for contributing! This guide covers local development, building, and packaging.

## Tech Stack

- **Framework**: Next.js 16 (App Router) + React 19 + TypeScript
- **Styling**: Tailwind CSS v4 + shadcn/ui
- **Database**: SQLite via Prisma 6 ORM
- **State**: Zustand
- **Desktop shell**: Tauri v2 (Windows, macOS, Linux)

## Getting Started (Development)

HermOS provisions a local SQLite database and encryption key automatically — no login, no cloud.

1. Install dependencies (auto-generates the Prisma client via `postinstall`):
   ```bash
   npm install
   ```
   The `postinstall` script runs `prisma generate` automatically — no manual step needed. Requires Node >=22 (see `.nvmrc`).

2. Start the dev server:
   ```bash
   npm run dev          # http://127.0.0.1:3000
   ```

   No `prisma db push` needed for local dev — the SQLite database (`~/.hermos/db/hermos.db`) is provisioned automatically at runtime via `src/lib/db.ts` / `src/lib/provision-db.ts` on first boot.

The dev server binds to **http://127.0.0.1:3000** only (loopback). The desktop app uses `3001+` so the two never collide.

## Project Structure

- `src/app` — Next.js routes and API handlers
- `src/lib` — core libraries (DB, encryption, AI, MCP, SSRF policy)
- `src/components` — UI
- `prisma/` — schema and migrations
- `src-tauri/` — Tauri desktop wrapper (Rust)
- `hermos-website/` — marketing site (deployed to GitHub Pages)
- `public/installers/` — optional local installer binaries for `/api/download`

## Production Build

```bash
npm run build        # standalone server → .next-build/standalone
npm start            # serve on http://127.0.0.1:3000 (loopback only)
npm run smoke:prod   # verify /api/health, /, /robots.txt
```

`scripts/start-standalone.mjs` forces `HOSTNAME=127.0.0.1`, prunes `.env*` from the bundle, and forwards signals.
`scripts/nextjs-build.mjs` bundles Prisma migrations + client + public assets and rewrites tracing roots for portability.

## Desktop Packaging (Tauri v2)

Requires Rust stable.

```bash
npm run tauri build   # → src-tauri/target/release/bundle/
```

`npm run build:desktop` runs `provision-node-sidecar → prisma generate → nextjs-build` before Tauri bundles the standalone server into `resources`.

### Updater Signing

Releases are signed with [Tauri updater](https://tauri.app/plugin/updater/). CI reads `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` from GitHub Secrets. The public key lives in `src-tauri/tauri.conf.json` (`plugins.updater.pubkey`). Rotate via `npx tauri signer generate`.

## Runtime Data

- **Dev**: `~/.hermos` (`C:\Users\<you>\.hermos` on Windows) — uploads, workspaces, checkpoints, `db/hermos.db`
- **Desktop**: `%APPDATA%\com.hermos.ide` (Windows) / OS app-data dir
- Override with `HERMOS_APP_DATA_DIR`

Default workspace: `~/.hermos/workspaces/<userId>` (browser mode); desktop opens real folders via the native dialog.

## Environment Variables

| Variable | Purpose |
|---|---|
| `HERMOS_APP_DATA_DIR` | Relocate data dir |
| `HERMOS_DESKTOP` | `true` when spawned by Tauri |
| `HERMOS_PROJECT_ROOT` | Override workspace root for file tools |
| `HERMOS_DESKTOP_PORT` | Pin desktop port (default: first free 3001–3999) |
| `SSRF_BLOCK_PRIVATE` | `false` to allow private/LAN fetches (default: strict) |
| `HERMOS_TAURI_UPDATER_PUBKEY` | Override baked-in updater pubkey |
| `TRUST_PROXY` | `true` to honor `X-Forwarded-For` behind a proxy |
| `DATABASE_URL` | Override SQLite location (derived automatically if unset) |
| `ENCRYPTION_KEY` | 64-hex override for `~/.hermos/.secret_key` |

## Testing

```bash
npm run lint
npm run typecheck   # tsc --noEmit
npm test            # vitest run --pool=forks
npm run perf        # vitest perf harness
node scripts/verify-seo.js  # 16 checks on hermos-website/
```

E2E tests in `tests/e2e/` share `public/installers` — an atomic file lock (`tests/e2e/installers-lock.ts`) serializes those fixtures.

## Prisma

```bash
npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --exit-code  # drift check
```

Single migration chain: `prisma/migrations/20260803000000_init/`.

## Code Style

- ESLint + `eslint-config-next`
- No blank lines in `.gitignore` (CRLF blank lines are treated as catch-all ignores on some Git versions)
- Keep `hermos-website/*.png|*.webp` tracked via `!hermos-website/` exceptions
