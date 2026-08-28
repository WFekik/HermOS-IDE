// Hermetic production build runner.
//
// Why this wrapper exists: Next.js 16 throws during prerendering the
// auto-generated /_global-error page ("TypeError: Cannot read properties of
// null (reading 'useContext')") when the spawning environment pre-sets a
// non-production NODE_ENV (e.g. a launcher/dev shell exporting
// NODE_ENV=development — see vercel/next.js discussion #94654). Forcing the
// canonical value here makes `npm run build` behave identically on Docker,
// CI, the Tauri desktop build, and plain shells.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  rmSync,
  cpSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.NODE_ENV = "production";

const nextBin = fileURLToPath(
  new URL("../node_modules/next/dist/bin/next", import.meta.url),
);

const result = spawnSync(process.execPath, [nextBin, "build", ...process.argv.slice(2)], {
  stdio: "inherit",
});

// [fix: prune env from standalone]
// The standalone dir is bundled wholesale into the installer
// (tauri.conf.json `resources: ../.next-build/standalone/**/*`). `next build`
// can trace the dev machine's real `.env` (DATABASE_URL, ENCRYPTION_KEY) into
// the standalone output, so those secrets would ship inside the installer.
// Delete them right after the standalone build completes. Kept in its own
// function so parallel edits to this file (e.g. the prisma copy step) do not
// collide; `scripts/start-standalone.mjs` repeats this prune defensively.
function pruneEnvFromStandalone() {
  const standaloneDir = fileURLToPath(
    new URL("../.next-build/standalone", import.meta.url),
  );
  const pruned = [];
  for (const name of [".env", ".env.local", ".env.production", ".env.production.local"]) {
    const target = join(standaloneDir, name);
    if (existsSync(target)) {
      rmSync(target, { force: true });
      pruned.push(name);
    }
  }
  if (pruned.length > 0) {
    console.log(
      `[nextjs-build] pruned secrets from standalone: ${pruned.join(", ")}`,
    );
  }
}

// [fix: prune env + bundle prisma]
// Ship the prisma migrations + schema alongside the standalone server so the
// runtime provisioning step (src/lib/provision-db.ts) can create the schema
// on a fresh desktop DB at first boot. The prisma CLI itself is NOT bundled
// by Next's tracer; the runtime falls back to applying the migration SQL
// through the bundled query engine when the CLI is absent.
function pruneAndBundlePrisma() {
  const standaloneDir = fileURLToPath(
    new URL("../.next-build/standalone", import.meta.url),
  );
  const sourcePrisma = fileURLToPath(new URL("../prisma", import.meta.url));
  const destPrisma = join(standaloneDir, "prisma");
  rmSync(destPrisma, { recursive: true, force: true });
  cpSync(sourcePrisma, destPrisma, {
    recursive: true,
    // Never ship a dev DB (prisma/hermos.db*) inside the installer — same
    // secret-leak class as the .env prune.
    filter: (src) => !/^.+\.db(?:-wal|-shm|-journal)?$/i.test(src.split(/[\\/]/).pop() ?? src),
  });
  console.log(
    "[nextjs-build] bundled prisma/migrations + schema.prisma into standalone",
  );
}

// [fix: copy public assets into standalone]
// Next standalone mode does NOT copy `public/` automatically; without this,
// /robots.txt, /sitemap.xml, favicon and the local installers served via
// /api/download (public/installers) would 404 in production and in the
// desktop bundle.
function copyPublicIntoStandalone() {
  const standaloneDir = fileURLToPath(
    new URL("../.next-build/standalone", import.meta.url),
  );
  const sourcePublic = fileURLToPath(new URL("../public", import.meta.url));
  if (!existsSync(sourcePublic)) return;
  const destPublic = join(standaloneDir, "public");
  rmSync(destPublic, { recursive: true, force: true });
  cpSync(sourcePublic, destPublic, { recursive: true });
  console.log("[nextjs-build] copied public/ into standalone");
}

// [fix: copy client static assets into standalone]
// Turbopack's standalone trace (.nft.json) does NOT include the client
// `static/` chunks — only server code. Without this copy, every
// `/_next/static/...` request (JS/CSS bundles, images, fonts) 404s in
// production: the SSR HTML renders but the app never hydrates. Must run
// AFTER `next build`, which emits `.next-build/static`.
function copyStaticIntoStandalone() {
  const standaloneDir = fileURLToPath(
    new URL("../.next-build/standalone", import.meta.url),
  );
  const sourceStatic = fileURLToPath(
    new URL("../.next-build/static", import.meta.url),
  );
  if (!existsSync(sourceStatic)) return;
  const destStatic = join(
    standaloneDir,
    ".next-build",
    "static",
  );
  rmSync(destStatic, { recursive: true, force: true });
  cpSync(sourceStatic, destStatic, { recursive: true });
  console.log("[nextjs-build] copied .next-build/static/ into standalone");
}

// [fix: make standalone portable — never load the build machine's .env]
// Next.js embeds the absolute build root (`outputFileTracingRoot`, `repoRoot`,
// `turbopack.root`) into the standalone's runtime config. At startup the
// server resolves env files relative to that path and loads the DEV machine's
// real `.env` (DATABASE_URL → dev DB, ENCRYPTION_KEY → dev key) into every
// production process. Rewriting those roots to "." makes the bundle resolve
// against its own directory (where `.env` is pruned), so runtime env comes
// exclusively from real env vars (HERMOS_APP_DATA_DIR etc.).
function portableStandaloneConfig() {
  const standaloneDir = fileURLToPath(
    new URL("../.next-build/standalone", import.meta.url),
  );
  const serverJsPath = join(standaloneDir, "server.js");
  const requiredFilesPath = join(
    standaloneDir,
    ".next-build",
    "required-server-files.json",
  );
  let changed = false;
  for (const target of [serverJsPath, requiredFilesPath]) {
    if (!existsSync(target)) continue;
    let text = readFileSync(target, "utf8");
    const before = text;
    text = text
      .replace(/"outputFileTracingRoot"\s*:\s*"[^"]*"/g, '"outputFileTracingRoot":"."')
      .replace(/"repoRoot"\s*:\s*"[^"]*"/g, '"repoRoot":"."')
      .replace(/"root"\s*:\s*"[^"]*"/g, '"root":"."')
      .replace(/"appDir"\s*:\s*"[^"]*"/g, '"appDir":"."');
    if (text !== before) {
      writeFileSync(target, text);
      changed = true;
    }
  }
  if (changed) {
    console.log(
      "[nextjs-build] rewrote absolute tracing roots -> '.' (portable standalone)",
    );
  }
}

// [fix: bundle the Prisma client into the standalone]
// `@prisma/client` ships `turbopackIgnore: true`, so Next's tracer never
// copies it into the standalone output. At runtime the bundled server code
// then resolves `@prisma/client` from the BUILD MACHINE's `node_modules`
// (works only on that machine) and Prisma's own dotenv loader reads the
// repo's `.env` next to that install (injecting the dev DATABASE_URL and
// ENCRYPTION_KEY into every process). Copying the client + generated client
// + engine into the standalone makes it portable AND makes Prisma resolve
// `.env` against the standalone dir itself (where `.env` is pruned).
function bundlePrismaClientIntoStandalone() {
  const repoNodeModules = fileURLToPath(
    new URL("../node_modules", import.meta.url),
  );
  const standaloneNodeModules = join(
    fileURLToPath(new URL("../.next-build/standalone", import.meta.url)),
    "node_modules",
  );
  const pruneAndCopy = (from, to) => {
    rmSync(to, { recursive: true, force: true });
    if (existsSync(from)) cpSync(from, to, { recursive: true });
  };
  for (const pkg of [
    "client",
    "debug",
    "get-platform",
    "engines-version",
    "fetch-engine",
  ]) {
    pruneAndCopy(
      join(repoNodeModules, "@prisma", pkg),
      join(standaloneNodeModules, "@prisma", pkg),
    );
  }
  const enginesFrom = join(repoNodeModules, "@prisma", "engines");
  const enginesTo = join(standaloneNodeModules, "@prisma", "engines");
  rmSync(enginesTo, { recursive: true, force: true });
  mkdirSync(enginesTo, { recursive: true });
  // Copy the query engine for EVERY platform present in the package (the npm
  // install provides only the build machine's engine; CI downloads the others
  // via scripts/ensure-extra-prisma-engines.mjs — e.g. the x86_64 engine for
  // the universal macOS bundle). The schema engine is NOT needed at runtime
  // (provisioning applies the bundled migration SQL through the query engine).
  for (const name of readdirSync(enginesFrom)) {
    if (/\.tmp\d*$/.test(name)) continue;
    if (/^(?:lib)?query_engine-/.test(name) || name === "package.json" || name === "LICENSE") {
      cpSync(join(enginesFrom, name), join(enginesTo, name));
    }
  }
  const generatedTo = join(standaloneNodeModules, ".prisma", "client");
  pruneAndCopy(
    join(repoNodeModules, ".prisma", "client"),
    generatedTo,
  );
  for (const entry of readdirSync(generatedTo)) {
    if (/\.tmp\d+$/.test(entry)) {
      rmSync(join(generatedTo, entry), { force: true });
    }
  }
  // The traced `node_modules/.bin` only contains a POSIX `prisma` shim that
  // is useless (and broken, carrying the build-machine path) on Windows.
  // Remove it so src/lib/provision-db.ts skips the CLI path and applies the
  // bundled migration SQL directly through the query engine.
  rmSync(join(standaloneNodeModules, ".bin"), { recursive: true, force: true });
  // `serverExternalPackages` makes Turbopack emit a runtime require for a
  // mangled id like `@prisma/client-<hash>` that exists nowhere. Without an
  // alias, the loader falls back to its bundled duplicate, whose baked
  // `__dirname` points at the build machine and re-reads its repo `.env`.
  // Create the alias package pointing back at the real bundled client.
  const chunksDir = join(
    fileURLToPath(new URL("../.next-build/standalone", import.meta.url)),
    ".next-build",
    "server",
    "chunks",
  );
  const aliasRegex = /"@prisma\/client-[0-9a-f]{16}"/;
  for (const entry of readdirSync(chunksDir)) {
    const chunkPath = join(chunksDir, entry);
    if (!existsSync(chunkPath) || !entry.endsWith(".js")) continue;
    const text = readFileSync(chunkPath, "utf8");
    const match = text.match(aliasRegex);
    if (match) {
      const aliasName = match[0].slice(1, -1);
      const aliasDir = join(standaloneNodeModules, "@prisma", aliasName.slice("@prisma/".length));
      mkdirSync(aliasDir, { recursive: true });
      writeFileSync(
        join(aliasDir, "package.json"),
        JSON.stringify({
          name: aliasName,
          private: true,
          main: "../../@prisma/client/index.js",
        }),
      );
      console.log(`[nextjs-build] aliased ${aliasName} -> @prisma/client`);
      break;
    }
  }
  console.log(
    "[nextjs-build] bundled @prisma/client + .prisma/client + engine into standalone",
  );
}

// [fix: bundle agent-browser native binaries into standalone]
// `agent-browser` relies on native binaries (agent-browser-win32-x64.exe,
// agent-browser-darwin-arm64, agent-browser-linux-x64, etc.) located in
// `node_modules/agent-browser/bin`. Next.js standalone file tracing ignores
// .exe and native binary files from node_modules, causing "No binary found for win32-x64"
// errors when the packaged desktop app runs browser commands.
// Copy the entire agent-browser package (including native binaries) into standalone node_modules.
function bundleAgentBrowserIntoStandalone() {
  const repoNodeModules = fileURLToPath(
    new URL("../node_modules", import.meta.url),
  );
  const standaloneNodeModules = join(
    fileURLToPath(new URL("../.next-build/standalone", import.meta.url)),
    "node_modules",
  );
  const sourceAgentBrowser = join(repoNodeModules, "agent-browser");
  const destAgentBrowser = join(standaloneNodeModules, "agent-browser");
  if (!existsSync(sourceAgentBrowser)) return;
  rmSync(destAgentBrowser, { recursive: true, force: true });
  cpSync(sourceAgentBrowser, destAgentBrowser, { recursive: true });
  console.log(
    "[nextjs-build] bundled agent-browser (including native binaries) into standalone",
  );
}

if (result.error || result.status !== 0) {
  console.error(
    "[nextjs-build] Next build failed with exit code:",
    result.status,
    result.error || "",
  );
  process.exit(result.status ?? 1);
}

// [fix: prune env from standalone]
pruneEnvFromStandalone();
// [fix: make standalone portable — never load the build machine's .env]
portableStandaloneConfig();
// [fix: prune env + bundle prisma]
pruneAndBundlePrisma();
// [fix: bundle the Prisma client into the standalone]
bundlePrismaClientIntoStandalone();
// [fix: bundle agent-browser native binaries into standalone]
bundleAgentBrowserIntoStandalone();
// [fix: copy public assets into standalone]
copyPublicIntoStandalone();
// [fix: copy client static assets into standalone]
copyStaticIntoStandalone();
process.exit(result.status ?? 1);