// Downloads an additional Prisma query engine into node_modules/@prisma/engines.
// The npm package ships only the BUILD machine's engine; a universal macOS
// bundle needs BOTH darwin-arm64 and darwin-x86_64, so CI fetches the missing
// one before `npm run build:desktop` (scripts/nextjs-build.mjs then copies
// every engine present into the standalone).
//
// Usage: node scripts/ensure-extra-prisma-engines.mjs <platform>
//   e.g. node scripts/ensure-extra-prisma-engines.mjs darwin  (both `darwin` and `darwin-x86_64` map to `darwin`)

import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const platform = process.argv[2];
if (!platform) {
  console.error(
    "usage: node scripts/ensure-extra-prisma-engines.mjs <platform> (e.g. darwin — both `darwin` and `darwin-x86_64` work)",
  );
  process.exit(2);
}

const enginesDir = fileURLToPath(
  new URL("../node_modules/@prisma/engines", import.meta.url),
);
const versionPkg = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../node_modules/@prisma/engines-version/package.json", import.meta.url)),
    "utf8",
  ),
);
const hash = versionPkg.prisma?.enginesVersion ?? versionPkg.enginesVersion;
if (typeof hash !== "string" || !hash) {
  console.error("[prisma-engines] could not read enginesVersion from @prisma/engines-version");
  process.exit(1);
}

// URL naming per @prisma/get-platform getNodeAPIName(platform, "url") and
// @prisma/fetch-engine getDownloadUrl: file name is arch-agnostic, platform
// goes in the PATH, extension is always .gz on the CDN.
// Local file name must match what scripts/nextjs-build.mjs copies (platform
// suffix + correct extension per OS).
const normalizedPlatform =
  platform === "darwin" ? "darwin" : platform === "darwin-x86_64" ? "darwin" : platform === "darwin-arm64" ? "darwin-arm64" : platform;

let urlFileName;
let localName;
if (normalizedPlatform.startsWith("windows")) {
  urlFileName = "query_engine.dll.node";
  localName = `query_engine-${normalizedPlatform}.dll.node`;
} else if (normalizedPlatform.startsWith("darwin")) {
  urlFileName = "libquery_engine.dylib.node";
  localName = `libquery_engine-${normalizedPlatform}.dylib.node`;
} else {
  urlFileName = "libquery_engine.so.node";
  localName = `libquery_engine-${normalizedPlatform}.so.node`;
}
const target = join(enginesDir, localName);
if (existsSync(target)) {
  console.log(`[prisma-engines] ${localName} already present`);
  process.exit(0);
}

const base =
  process.env.PRISMA_BINARIES_MIRROR ||
  process.env.PRISMA_ENGINES_MIRROR ||
  "https://binaries.prisma.sh";
const url = `${base}/all_commits/${hash}/${normalizedPlatform}/${urlFileName}.gz`;
console.log(`[prisma-engines] downloading ${url}`);
const resp = await fetch(url);
if (!resp.ok) {
  console.error(`[prisma-engines] download failed: ${resp.status} ${resp.statusText}`);
  process.exit(1);
}
const gzBuf = Buffer.from(await resp.arrayBuffer());
const { gunzipSync } = await import("node:zlib");
const buf = gunzipSync(gzBuf);
writeFileSync(target, buf);
console.log(`[prisma-engines] saved ${localName} (${buf.length} bytes)`);