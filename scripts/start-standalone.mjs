// Production server launcher for the Next.js standalone build.
//
// Hard requirements:
//  1. Bind to loopback ONLY. The generated standalone `server.js` defaults to
//     0.0.0.0 (see node_modules/next/dist/docs/01-app/03-api-reference/.../output.md:
//     "HOSTNAME environment variables before running server.js"). We force
//     HOSTNAME=127.0.0.1 so the web server is never exposed to the network.
//  2. Prune any `.env*` files from the standalone dir before boot. The
//     standalone output is bundled wholesale into the installer
//     (tauri.conf.json `resources: ../.next-build/standalone/**/*`), and
//     `next build` can trace the dev machine's real `.env` (DATABASE_URL,
//     ENCRYPTION_KEY) into it. This is a second line of defense on top of the
//     prune that `scripts/nextjs-build.mjs` performs at build time.
//  3. Forward termination signals to the child so the server shuts down
//     cleanly, and surface a non-zero exit code if the child dies.
//
// Usage: node scripts/start-standalone.mjs [--port <port>]

import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const standaloneDir = fileURLToPath(
  new URL("../.next-build/standalone", import.meta.url),
);

const DEFAULT_PORT = 3000;
const ENV_FILES_TO_PRUNE = [".env", ".env.local", ".env.production", ".env.production.local"];

function parseArgs(argv) {
  let port = DEFAULT_PORT;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--port") {
      port = Number(argv[i + 1]);
      i += 1;
    } else if (arg.startsWith("--port=")) {
      port = Number(arg.slice("--port=".length));
    } else {
      console.warn(`[start-standalone] Ignoring unknown argument: ${arg}`);
    }
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`[start-standalone] Invalid --port value: ${argv.join(" ")}`);
    process.exit(2);
  }
  return port;
}

function pruneEnvFiles() {
  const pruned = [];
  for (const name of ENV_FILES_TO_PRUNE) {
    const target = join(standaloneDir, name);
    if (existsSync(target)) {
      rmSync(target, { force: true });
      pruned.push(name);
    }
  }
  if (pruned.length > 0) {
    console.log(
      `[start-standalone] Pruned secrets from standalone dir: ${pruned.join(", ")}`,
    );
  }
}

function main() {
  if (!existsSync(join(standaloneDir, "server.js"))) {
    console.error(
      `[start-standalone] No standalone build found at ${standaloneDir}. ` +
        "Run `npm run build` first.",
    );
    process.exit(1);
  }

  pruneEnvFiles();

  const port = parseArgs(process.argv.slice(2));
  const env = {
    ...process.env,
    HOSTNAME: "127.0.0.1",
    PORT: String(port),
    NODE_ENV: "production",
  };

  console.log(
    `[start-standalone] Starting standalone server on http://127.0.0.1:${port}`,
  );
  const child = spawn(process.execPath, ["server.js"], {
    cwd: standaloneDir,
    env,
    stdio: "inherit",
  });

  let shuttingDown = false;

  const forwardSignal = (signal) => {
    if (shuttingDown || !child.pid) return;
    shuttingDown = true;
    console.log(`[start-standalone] Forwarding ${signal} to server child`);
    child.kill(signal);
  };

  process.on("SIGINT", () => forwardSignal("SIGINT"));
  process.on("SIGTERM", () => forwardSignal("SIGTERM"));

  child.on("error", (err) => {
    console.error(`[start-standalone] Failed to spawn server: ${err.message}`);
    process.exit(1);
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      console.error(`[start-standalone] Server child died with signal ${signal}`);
      process.exit(1);
    }
    console.log(`[start-standalone] Server child exited with code ${code}`);
    process.exit(code ?? 1);
  });
}

main();
