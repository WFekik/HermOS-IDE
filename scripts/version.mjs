#!/usr/bin/env node

/**
 * Enterprise Version Control CLI for HermOS IDE.
 * 
 * Synchronizes, validates, and bumps versions in lockstep across:
 * - package.json
 * - package-lock.json
 * - src-tauri/tauri.conf.json
 * - src-tauri/Cargo.toml
 * 
 * Usage:
 *   node scripts/version.mjs get
 *   node scripts/version.mjs check
 *   node scripts/version.mjs sync
 *   node scripts/version.mjs bump [major|minor|patch|<version>]
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");

const PKG_PATH = path.join(ROOT_DIR, "package.json");
const PKG_LOCK_PATH = path.join(ROOT_DIR, "package-lock.json");
const TAURI_CONF_PATH = path.join(ROOT_DIR, "src-tauri", "tauri.conf.json");
const CARGO_TOML_PATH = path.join(ROOT_DIR, "src-tauri", "Cargo.toml");
const CARGO_LOCK_PATH = path.join(ROOT_DIR, "src-tauri", "Cargo.lock");
const WEBSITE_PATH = path.join(ROOT_DIR, "hermos-website", "index.html");

function parseSemver(v) {
  const clean = String(v).trim().replace(/^v/i, "");
  const match = clean.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/);
  if (!match) return null;
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
    prerelease: match[4] || null,
    build: match[5] || null,
    raw: clean,
  };
}

function bumpSemver(current, type) {
  const parsed = parseSemver(current);
  if (!parsed) throw new Error(`Invalid base version: ${current}`);

  if (type === "major") {
    return `${parsed.major + 1}.0.0`;
  }
  if (type === "minor") {
    return `${parsed.major}.${parsed.minor + 1}.0`;
  }
  if (type === "patch") {
    return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
  }

  // Explicit target version provided
  const target = parseSemver(type);
  if (target) return target.raw;

  throw new Error(`Unknown bump type or invalid version: "${type}". Expected: major, minor, patch, or x.y.z`);
}

function readVersions() {
  const versions = {};

  if (fs.existsSync(PKG_PATH)) {
    const pkg = JSON.parse(fs.readFileSync(PKG_PATH, "utf-8"));
    versions.packageJson = pkg.version;
  }

  if (fs.existsSync(TAURI_CONF_PATH)) {
    const tauri = JSON.parse(fs.readFileSync(TAURI_CONF_PATH, "utf-8"));
    versions.tauriConf = tauri.version;
  }

  if (fs.existsSync(CARGO_TOML_PATH)) {
    const cargo = fs.readFileSync(CARGO_TOML_PATH, "utf-8");
    const m = cargo.match(/^version\s*=\s*"([^"]+)"/m);
    if (m) versions.cargoToml = m[1];
  }

  if (fs.existsSync(PKG_LOCK_PATH)) {
    try {
      const lock = JSON.parse(fs.readFileSync(PKG_LOCK_PATH, "utf-8"));
      versions.packageLock = lock.version;
    } catch { /* ignore parse errors */ }
  }

  if (fs.existsSync(WEBSITE_PATH)) {
    const html = fs.readFileSync(WEBSITE_PATH, "utf-8");
    const vm = html.match(/"softwareVersion":\s*"([^"]+)"/);
    if (vm) versions.website = vm[1];
  }

  return versions;
}

function updatePackageJson(newVersion) {
  if (!fs.existsSync(PKG_PATH)) return;
  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, "utf-8"));
  pkg.version = newVersion;
  fs.writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + "\n", "utf-8");
}

function updatePackageLock(newVersion) {
  if (!fs.existsSync(PKG_LOCK_PATH)) return;
  try {
    const lock = JSON.parse(fs.readFileSync(PKG_LOCK_PATH, "utf-8"));
    lock.version = newVersion;
    if (lock.packages && lock.packages[""]) {
      lock.packages[""].version = newVersion;
    }
    fs.writeFileSync(PKG_LOCK_PATH, JSON.stringify(lock, null, 2) + "\n", "utf-8");
  } catch {
    /* lockfile format optional */
  }
}

function updateTauriConf(newVersion) {
  if (!fs.existsSync(TAURI_CONF_PATH)) return;
  const tauri = JSON.parse(fs.readFileSync(TAURI_CONF_PATH, "utf-8"));
  tauri.version = newVersion;
  fs.writeFileSync(TAURI_CONF_PATH, JSON.stringify(tauri, null, 2) + "\n", "utf-8");
}

function updateCargoToml(newVersion) {
  if (!fs.existsSync(CARGO_TOML_PATH)) return;
  let content = fs.readFileSync(CARGO_TOML_PATH, "utf-8");
  content = content.replace(/^version\s*=\s*"[^"]+"/m, `version = "${newVersion}"`);
  fs.writeFileSync(CARGO_TOML_PATH, content, "utf-8");
}

function updateCargoLock(newVersion) {
  if (!fs.existsSync(CARGO_LOCK_PATH)) return;
  let content = fs.readFileSync(CARGO_LOCK_PATH, "utf-8");
  content = content.replace(
    /(\[\[package\]\]\r?\nname = "app"\r?\nversion = )"[^"]+"/m,
    `$1"${newVersion}"`
  );
  fs.writeFileSync(CARGO_LOCK_PATH, content, "utf-8");
}

function updateHermosWebsite(newVersion) {
  if (!fs.existsSync(WEBSITE_PATH)) return;
  let content = fs.readFileSync(WEBSITE_PATH, "utf-8");
  content = content.replace(/"softwareVersion":\s*"[^"]+"/g, `"softwareVersion": "${newVersion}"`);
  content = content.replace(/version:\s*"[^"]+"/g, `version: "${newVersion}"`);
  fs.writeFileSync(WEBSITE_PATH, content, "utf-8");
}

function applyVersion(newVersion) {
  const parsed = parseSemver(newVersion);
  if (!parsed) throw new Error(`Cannot apply invalid version: ${newVersion}`);

  updatePackageJson(parsed.raw);
  updatePackageLock(parsed.raw);
  updateTauriConf(parsed.raw);
  updateCargoToml(parsed.raw);
  updateCargoLock(parsed.raw);
  updateHermosWebsite(parsed.raw);

  console.log(`✓ Synchronized HermOS version to v${parsed.raw}`);
}

const action = process.argv[2] || "get";
const arg = process.argv[3];

try {
  if (action === "get") {
    const vers = readVersions();
    console.log(`HermOS Version: ${vers.packageJson || "unknown"}`);
    console.log(`- package.json:          ${vers.packageJson || "N/A"}`);
    console.log(`- package-lock.json:     ${vers.packageLock || "N/A"}`);
    console.log(`- src-tauri/tauri.conf:  ${vers.tauriConf || "N/A"}`);
    console.log(`- src-tauri/Cargo.toml:  ${vers.cargoToml || "N/A"}`);
    console.log(`- hermos-website:        ${vers.website || "N/A"}`);
  } else if (action === "check") {
    const vers = readVersions();
    const unique = new Set(Object.values(vers).filter(Boolean));
    if (unique.size > 1) {
      console.error("✗ Version mismatch detected across workspace files:");
      console.error(vers);
      process.exit(1);
    }
    console.log(`✓ All project files are in lockstep at version v${vers.packageJson}`);
  } else if (action === "sync") {
    const vers = readVersions();
    const target = vers.packageJson;
    if (!target) throw new Error("No version found in package.json");
    applyVersion(target);
  } else if (action === "bump") {
    const vers = readVersions();
    const current = vers.packageJson || "1.0.0";
    const bumpType = arg || "patch";
    const nextVersion = bumpSemver(current, bumpType);
    applyVersion(nextVersion);
  } else {
    console.error(`Unknown command: ${action}`);
    console.error("Usage: node scripts/version.mjs [get|check|sync|bump]");
    process.exit(1);
  }
} catch (e) {
  console.error(`Error: ${e.message}`);
  process.exit(1);
}
