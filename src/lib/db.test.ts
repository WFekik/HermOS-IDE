/**
 * Tests for src/lib/db.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import path from "path";
import os from "os";
import fs from "fs/promises";

const rand = () => Math.random().toString(36).slice(2);

afterEach(() => {
  vi.unstubAllEnvs();
});

async function freshDb(appData: string) {
  vi.stubEnv("HERMOS_APP_DATA_DIR", appData);
  vi.resetModules();
  const mod = await import("./db");
  return mod;
}

function derivedUrl(appData: string): string {
  return `file:${path.join(appData, "db", "hermos.db").replace(/\\/g, "/")}`;
}

describe("resolveDatabaseUrl", () => {
  const appData = path.join(os.tmpdir(), "hermos-db-" + rand());

  afterEach(async () => {
    await fs.rm(appData, { recursive: true, force: true }).catch(() => {});
  });

  it("unset URL -> derived absolute SQLite URL", async () => {
    const mod = await freshDb(appData);
    expect(mod.resolveDatabaseUrl("")).toBe(derivedUrl(appData));
    expect(mod.resolveDatabaseUrl(undefined)).toBe(derivedUrl(appData));
  });

  it("file:./x -> derived", async () => {
    const mod = await freshDb(appData);
    expect(mod.resolveDatabaseUrl("file:./db/hermos.db")).toBe(derivedUrl(appData));
  });

  it("file:../x -> derived", async () => {
    const mod = await freshDb(appData);
    expect(mod.resolveDatabaseUrl("file:../data/hermos.db")).toBe(derivedUrl(appData));
  });

  it("file:db/x (no dot prefix) -> derived", async () => {
    const mod = await freshDb(appData);
    expect(mod.resolveDatabaseUrl("file:db/hermos.db")).toBe(derivedUrl(appData));
  });

  it("file:dev.db (bare relative) -> derived", async () => {
    const mod = await freshDb(appData);
    expect(mod.resolveDatabaseUrl("file:dev.db")).toBe(derivedUrl(appData));
  });

  it("file:C:/x (drive letter, forward slashes) -> passthrough", async () => {
    const mod = await freshDb(appData);
    const url = "file:C:/Users/me/.hermos/db/hermos.db";
    expect(mod.resolveDatabaseUrl(url)).toBe(url);
  });

  it("file:C:\\x (drive letter, backslashes) -> passthrough", async () => {
    const mod = await freshDb(appData);
    const url = "file:C:\\Users\\me\\hermos.db";
    expect(mod.resolveDatabaseUrl(url)).toBe(url);
  });

  it("file:/abs and file:///abs -> passthrough", async () => {
    const mod = await freshDb(appData);
    expect(mod.resolveDatabaseUrl("file:/var/lib/hermos.db")).toBe("file:/var/lib/hermos.db");
    expect(mod.resolveDatabaseUrl("file:///var/lib/hermos.db")).toBe("file:///var/lib/hermos.db");
  });

  it("postgresql:// -> passthrough", async () => {
    const mod = await freshDb(appData);
    const url = "postgresql://user:password@host:5432/hermos";
    expect(mod.resolveDatabaseUrl(url)).toBe(url);
  });
});
