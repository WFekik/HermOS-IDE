// Production smoke test for the Next.js standalone build.
//
// Spawns the standalone server on a random loopback port (3100-3999) with
// HOSTNAME=127.0.0.1, waits for `GET /api/health` to report healthy (up to
// 30s), then asserts the core production endpoints respond correctly.
//
// The child process is ALWAYS killed, even on failure.
//
// Usage: node scripts/smoke-prod.mjs

import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const standaloneDir = fileURLToPath(
  new URL("../.next-build/standalone", import.meta.url),
);

const ENV_FILES_TO_PRUNE = [".env", ".env.local", ".env.production", ".env.production.local"];

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
      `[smoke-prod] Pruned secrets from standalone dir: ${pruned.join(", ")}`,
    );
  }
}

const HEALTH_PATH = "/api/health";
const HEALTH_TIMEOUT_MS = 30_000;
const RETRY_INTERVAL_MS = 500;
// randomPort() collisions (port already bound) get 2 attempts before failing.
const START_ATTEMPTS = 2;

const results = [];
const failures = [];

function report(name, ok, detail = "") {
  const line = `${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`;
  console.log(line);
  results.push(line);
  if (!ok) failures.push(line);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function randomPort() {
  return 3100 + Math.floor(Math.random() * 900);
}

function startServer(port) {
  const child = spawn(process.execPath, ["server.js"], {
    cwd: standaloneDir,
    env: {
      ...process.env,
      HOSTNAME: "127.0.0.1",
      PORT: String(port),
      NODE_ENV: "production",
    },
    // stdio fully ignored: the child's output is not consumed, and leaving the
    // pipes open lets the parent hit a libuv assertion on teardown after
    // kill() on Windows (0xC0000409), corrupting the script's exit code.
    stdio: ["ignore", "ignore", "ignore"],
  });
  return child;
}

async function waitForHealth(baseUrl) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetchWithTimeout(`${baseUrl}${HEALTH_PATH}`, 2000);
      if (res.status === 200) {
        const body = await res.json();
        if (body && body.status === "healthy") return { res, body };
      }
      lastError = `status ${res.status}`;
    } catch (err) {
      lastError = err.message;
    }
    await sleep(RETRY_INTERVAL_MS);
  }
  return { error: lastError ?? "server never became healthy" };
}

async function killChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    sleep(3000),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function main() {
  if (!existsSync(join(standaloneDir, "server.js"))) {
    report(
      "standalone-build-present",
      false,
      `No standalone build at ${standaloneDir} — run \`npm run build\` first.`,
    );
    process.exit(1);
  }

  pruneEnvFiles();

  // Retry loop: a freshly picked random port may already be bound by another
  // process; on health-startup failure kill the child and try one more port.
  let child = null;
  let baseUrl = null;
  let health = null;
  for (let attempt = 1; attempt <= START_ATTEMPTS && !health; attempt++) {
    if (child) await killChild(child);
    const port = randomPort();
    baseUrl = `http://127.0.0.1:${port}`;
    console.log(
      `[smoke-prod] Starting standalone server on ${baseUrl} (attempt ${attempt}/${START_ATTEMPTS}, child pid will be managed below)`,
    );
    child = startServer(port);
    const candidate = await waitForHealth(baseUrl);
    if (candidate.res && candidate.body) health = candidate;
  }

  try {
    report(
      "health-200",
      Boolean(health && health.res && health.res.status === 200),
      (health ? health.res.status : "server never became healthy") + "",
    );

    if (health && health.res && health.body) {
      report(
        "health-body",
        health.body.status === "healthy" && typeof health.body.timestamp === "string",
        `status=${JSON.stringify(health.body.status)} env=${health.body.env}`,
      );
    } else {
      report("health-body", false, "no parseable health JSON");
    }

    const home = await fetchWithTimeout(`${baseUrl}/`, 10_000);
    const homeText = await home.text();
    report(
      "home-200",
      home.status === 200,
      `status ${home.status}, ${homeText.length} bytes`,
    );
    report(
      "home-html",
      (home.headers.get("content-type") ?? "").includes("text/html") &&
        homeText.trim().length > 0,
      `content-type=${home.headers.get("content-type") ?? "none"}`,
    );

    // Hydration guard: at least one real /_next/static JS chunk must be
    // referenced by the home HTML AND serve 200. Closes the historical
    // "static chunks 404 → app never hydrates" regression class.
    const chunkMatch = homeText.match(/(?<!\\)\/_next\/static\/[A-Za-z0-9/_.-]+\.js/);
    if (!chunkMatch) {
      report("static-chunk-found", false, "no /_next/static/*.js asset referenced in home HTML");
    } else {
      const chunkUrl = `${baseUrl}${chunkMatch[0]}`;
      const chunk = await fetchWithTimeout(chunkUrl, 10_000);
      await chunk.arrayBuffer().catch(() => {});
      report(
        "static-chunk-200",
        chunk.status === 200,
        `${chunkMatch[0]} -> ${chunk.status}`,
      );
    }

    const robots = await fetchWithTimeout(`${baseUrl}/robots.txt`, 10_000);
    const robotsText = await robots.text();
    report(
      "robots-200",
      robots.status === 200,
      `status ${robots.status}, ${robotsText.length} bytes`,
    );
  } catch (err) {
    report("unexpected-error", false, err.message);
  } finally {
    await killChild(child);
  }

  if (failures.length > 0) {
    console.error(
      `[smoke-prod] ${failures.length} of ${results.length} checks FAILED`,
    );
    process.exit(1);
  }
  console.log(`[smoke-prod] All ${results.length} checks PASSED`);
  process.exit(0);
}

main();