// Re-signs Tauri updater bundles with minisign AFTER any post-build mutation
// (e.g. SignPath Authenticode signing, which changes installer bytes and
// therefore invalidates the .sig files Tauri generated during `tauri build`).
//
// Why this exists: an uploader-side .sig that does not match its binary fails
// updater signature verification on EVERY client, systematically — with zero
// useful signal on Windows. This script re-creates all .sig files from the
// final bytes and then VERIFIES each one; any mismatch fails CI loudly before
// release-to-github.mjs uploads anything.
//
// Env:
//   TAURI_SIGNING_PRIVATE_KEY - minisign secret key, base64 (pipeline secret)
//   EXPECTED_PUBKEY (optional) - overrides the tauri.conf.json pubkey check
//
// Usage: node scripts/resign-updater-artifacts.mjs
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const BUNDLE_DIRS = process.env.RESIGN_DIRS
  ? process.env.RESIGN_DIRS.split(";").filter(Boolean)
  : [
      "src-tauri/target/release/bundle",
      "src-tauri/target/universal-apple-darwin/release/bundle",
    ];

// Bundles the updater consumes (sibling .sig files are (re)created for these).
const BUNDLE_FILE_RE = /\.(exe|msi|dmg|deb|AppImage|tar\.gz)$/i;

function fail(msg) {
  console.error(`[resign-updater] FATAL: ${msg}`);
  process.exit(1);
}

function readTauriPubkeyBlob() {
  const confPath = path.join(ROOT, "src-tauri", "tauri.conf.json");
  const conf = JSON.parse(fs.readFileSync(confPath, "utf8"));
  const embedded = String(conf?.plugins?.updater?.pubkey || "").replace(/\s+/g, "");
  if (!embedded) fail("no plugins.updater.pubkey in tauri.conf.json");
  // Embedded value is base64(full minisign .pub file text).
  const pubFileText = Buffer.from(embedded, "base64").toString("utf8");
  const keyLine = pubFileText.split("\n").find((l) => /^[A-Za-z0-9+/=]+$/.test(l.trim()));
  if (!keyLine) fail("could not parse embedded minisign .pub");
  const blob = Buffer.from(keyLine.trim(), "base64");
  if (blob.length !== 42) fail(`unexpected pubkey blob length ${blob.length} (want 42)`);
  return blob;
}

function loadSecretKey() {
  const raw = String(process.env.TAURI_SIGNING_PRIVATE_KEY || "").replace(/\s+/g, "");
  if (!raw) fail("TAURI_SIGNING_PRIVATE_KEY is not set");
  const bytes = Buffer.from(raw, "base64");
  let keynum;
  let seed;
  if (bytes.length === 42) {
    // minisign secret form: SIGALG(2) + KEYNUM(8) + SEED(32)
    if (bytes.subarray(0, 2).toString("ascii") !== "Ed") fail("secret key has bad SIGALG");
    keynum = bytes.subarray(2, 10);
    seed = bytes.subarray(10, 42);
  } else if (bytes.length === 64) {
    // libsodium secret form: SEED(32) + PUBKEY(32); keynum anchored to shipped pubkey below
    seed = bytes.subarray(0, 32);
  } else {
    fail(`secret key decodes to ${bytes.length} bytes (want 42 or 64)`);
  }
  // PKCS#8 DER wrap around the raw 32-byte Ed25519 seed (RFC 8410).
  const pkcs8Prefix = Buffer.from("302e020100300506032b657004220420", "hex");
  const privKey = crypto.createPrivateKey({
    format: "der",
    type: "pkcs8",
    key: Buffer.concat([pkcs8Prefix, seed]),
  });
  const pubDer = crypto.createPublicKey(privKey).export({ format: "der", type: "spki" });
  return { privKey, derivedPub: pubDer.subarray(-32), keynum };
}

function collectBundleFiles() {
  const out = [];
  for (const dir of BUNDLE_DIRS) {
    const abs = path.isAbsolute(dir) ? dir : path.join(ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.isFile() && BUNDLE_FILE_RE.test(e.name) && !e.name.endsWith(".sig")) out.push(full);
      }
    };
    walk(abs);
  }
  return out;
}

async function main() {
  const pubBlob = process.env.EXPECTED_PUBKEY
    ? Buffer.from(String(process.env.EXPECTED_PUBKEY).replace(/\s+/g, ""), "base64")
    : readTauriPubkeyBlob();
  const expectedPub = pubBlob.subarray(-32);
  const expectedKeynum = pubBlob.subarray(2, 10);

  const { privKey, derivedPub, keynum } = loadSecretKey();
  if (!derivedPub.equals(expectedPub)) {
    fail("private key does not correspond to the expected updater pubkey — refusing to sign");
  }
  const activeKeynum = keynum ?? expectedKeynum;
  console.log(`[resign-updater] key ${activeKeynum.toString("hex").toUpperCase()} matches shipped pubkey`);

  const files = collectBundleFiles();
  if (files.length === 0) fail("no updater bundle files found — nothing to sign");
  console.log(`[resign-updater] signing ${files.length} bundle(s)`);

  const pubForVerify = await crypto.subtle.importKey("raw", expectedPub, { name: "Ed25519" }, false, ["verify"]);
  const timestamp = Math.floor(Date.now() / 1000);

  for (const file of files) {
    const data = fs.readFileSync(file);
    const base = path.basename(file);

    const fileSig = Buffer.from(crypto.sign(null, data, privKey)); // 64 bytes Ed25519
    const trustedComment = `timestamp:${timestamp}\tfile:${base}`;
    const trustedSig = Buffer.from(crypto.sign(null, Buffer.from(trustedComment, "utf8"), privKey));

    const enc = (keynumBuf, sigBuf) =>
      Buffer.concat([Buffer.from("Ed", "ascii"), keynumBuf, sigBuf]).toString("base64");

    const sigText =
      `untrusted comment: signature from tauri secret key\n` +
      `${enc(activeKeynum, fileSig)}\n` +
      `trusted comment: ${trustedComment}\n` +
      `${enc(activeKeynum, trustedSig)}\n`;

    fs.writeFileSync(`${file}.sig`, sigText, "utf8");

    // Self-verify from disk: parse back what we wrote and check both signatures.
    const written = fs.readFileSync(`${file}.sig`, "utf8").split("\n");
    const wFileSig = Buffer.from(written[1].trim(), "base64");
    const wTrustedSig = Buffer.from(written[3].trim(), "base64");
    if (wFileSig.length !== 74 || wTrustedSig.length !== 74) {
      fail(`${base}: malformed .sig just written`);
    }
    const okFile = await crypto.subtle.verify({ name: "Ed25519" }, pubForVerify, wFileSig.subarray(10), data);
    const okTrusted = await crypto.subtle.verify(
      { name: "Ed25519" },
      pubForVerify,
      wTrustedSig.subarray(10),
      Buffer.from(`timestamp:${timestamp}\tfile:${base}`, "utf8"),
    );
    if (!okFile || !okTrusted) fail(`${base}: self-verification of fresh .sig FAILED`);
    console.log(`[resign-updater] signed + verified ${base}`);
  }
  console.log("[resign-updater] all signatures valid — safe to upload");
}

await main();
