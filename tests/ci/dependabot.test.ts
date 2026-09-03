import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

interface DependabotGroup {
  "dependency-type"?: "development" | "production";
  patterns?: string[];
  "exclude-patterns"?: string[];
}

interface DependabotUpdate {
  "package-ecosystem": string;
  directory: string;
  schedule: {
    interval: string;
    day?: string;
    time?: string;
    timezone?: string;
  };
  "open-pull-requests-limit"?: number;
  labels?: string[];
  groups?: Record<string, DependabotGroup>;
  "commit-message"?: {
    prefix?: string;
  };
}

const VALID_ECOSYSTEMS = new Set([
  "npm",
  "cargo",
  "github-actions",
  "bundler",
  "pip",
  "docker",
  "gomod",
  "composer",
  "nuget",
  "maven",
  "gradle",
  "terraform",
  "hex",
  "swift",
  "pub",
]);

const VALID_INTERVALS = new Set(["daily", "weekly", "monthly"]);
const VALID_DAYS = new Set(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]);

/**
 * Strip a trailing `# comment` from a YAML line without truncating `#`
 * inside single/double-quoted scalars (e.g. `prefix: "chore#deps"`).
 * Only treats `#` as a comment when preceded by start-of-line or whitespace
 * and outside quotes — per YAML spec.
 */
function stripYamlComment(rawLine: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < rawLine.length; i++) {
    const ch = rawLine[i];
    if (ch === "'" && !inDouble) {
      // YAML escapes single quote by doubling it ('').
      if (rawLine[i + 1] === "'") {
        i++;
        continue;
      }
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle) {
      if (rawLine[i - 1] !== "\\") inDouble = !inDouble;
    } else if (ch === "#" && !inSingle && !inDouble) {
      if (i === 0 || /\s/.test(rawLine[i - 1])) return rawLine.slice(0, i);
    }
  }
  return rawLine;
}

/**
 * Strict, minimal parser for the subset of Dependabot v2 YAML used here.
 * Company-grade note: intentionally NOT a general YAML parser. It only
 * understands the keys asserted below; unknown mapping keys at group level
 * are treated as group names ONLY when nested under `groups:` (indent >= 6),
 * so `schedule:` / `commit-message:` / `ignore:` never become phantom groups.
 */
function parseDependabotYaml(content: string): { version: number; updates: DependabotUpdate[] } {
  const lines = content.split(/\r?\n/);
  let version = 0;
  const updates: DependabotUpdate[] = [];
  let currentUpdate: Partial<DependabotUpdate> | null = null;
  let currentGroup: string | null = null;
  let currentArrayKey: "labels" | "patterns" | "exclude-patterns" | null = null;
  let inGroups = false;

  const KNOWN_UPDATE_KEYS = new Set([
    "directory:",
    "target-branch:",
    "versioning-strategy:",
    "open-pull-requests-limit:",
    "schedule:",
    "interval:",
    "day:",
    "time:",
    "timezone:",
    "labels:",
    "groups:",
    "commit-message:",
    "prefix:",
    "ignore:",
    "dependency-name:",
    "update-types:",
    "patterns:",
    "exclude-patterns:",
    "dependency-type:",
  ]);

  for (const rawLine of lines) {
    const line = stripYamlComment(rawLine).trimEnd();
    if (!line.trim()) continue;

    const indent = line.search(/\S/);
    const trimmed = line.trim();

    if (trimmed.startsWith("version:")) {
      version = parseInt(trimmed.replace("version:", "").trim(), 10);
      continue;
    }

    if (trimmed.startsWith("updates:")) {
      continue;
    }

    if (trimmed.startsWith("- package-ecosystem:")) {
      if (currentUpdate && currentUpdate["package-ecosystem"]) {
        updates.push(currentUpdate as DependabotUpdate);
      }
      const eco = trimmed.replace("- package-ecosystem:", "").trim().replace(/["']/g, "");
      currentUpdate = {
        "package-ecosystem": eco,
        schedule: { interval: "weekly" },
        labels: [],
        groups: {},
      };
      currentGroup = null;
      currentArrayKey = null;
      inGroups = false;
      continue;
    }

    if (!currentUpdate) continue;

    if (trimmed.startsWith("directory:")) {
      currentUpdate.directory = trimmed.replace("directory:", "").trim().replace(/["']/g, "");
      currentArrayKey = null;
      inGroups = false;
    } else if (trimmed.startsWith("open-pull-requests-limit:")) {
      currentUpdate["open-pull-requests-limit"] = parseInt(
        trimmed.replace("open-pull-requests-limit:", "").trim(),
        10,
      );
      currentArrayKey = null;
      inGroups = false;
    } else if (trimmed.startsWith("prefix:")) {
      if (!currentUpdate["commit-message"]) currentUpdate["commit-message"] = {};
      currentUpdate["commit-message"].prefix = trimmed.replace("prefix:", "").trim().replace(/["']/g, "");
      currentArrayKey = null;
    } else if (trimmed.startsWith("interval:")) {
      currentUpdate.schedule!.interval = trimmed.replace("interval:", "").trim().replace(/["']/g, "");
      currentArrayKey = null;
      inGroups = false;
    } else if (trimmed.startsWith("day:")) {
      currentUpdate.schedule!.day = trimmed.replace("day:", "").trim().replace(/["']/g, "");
      currentArrayKey = null;
      inGroups = false;
    } else if (trimmed.startsWith("time:")) {
      currentUpdate.schedule!.time = trimmed.replace("time:", "").trim().replace(/["']/g, "");
      currentArrayKey = null;
      inGroups = false;
    } else if (trimmed.startsWith("timezone:")) {
      currentUpdate.schedule!.timezone = trimmed.replace("timezone:", "").trim().replace(/["']/g, "");
      currentArrayKey = null;
      inGroups = false;
    } else if (trimmed.startsWith("labels:")) {
      currentArrayKey = "labels";
      currentUpdate.labels = [];
      inGroups = false;
    } else if (trimmed.startsWith("groups:")) {
      currentArrayKey = null;
      currentUpdate.groups = {};
      inGroups = true;
      currentGroup = null;
    } else if (trimmed.startsWith("schedule:") || trimmed.startsWith("commit-message:") || trimmed.startsWith("ignore:")) {
      // Structural keys that must NEVER become phantom groups.
      currentArrayKey = null;
      currentGroup = null;
      inGroups = false;
    } else if (trimmed.startsWith("dependency-type:")) {
      if (currentGroup && currentUpdate.groups?.[currentGroup]) {
        currentUpdate.groups[currentGroup]["dependency-type"] = trimmed
          .replace("dependency-type:", "")
          .trim()
          .replace(/["']/g, "") as "development" | "production";
      }
      currentArrayKey = null;
    } else if (trimmed.startsWith("patterns:")) {
      currentArrayKey = "patterns";
      if (currentGroup && currentUpdate.groups?.[currentGroup]) {
        currentUpdate.groups[currentGroup].patterns = [];
      }
    } else if (trimmed.startsWith("exclude-patterns:")) {
      currentArrayKey = "exclude-patterns";
      if (currentGroup && currentUpdate.groups?.[currentGroup]) {
        currentUpdate.groups[currentGroup]["exclude-patterns"] = [];
      }
    } else if (
      inGroups &&
      indent >= 6 &&
      trimmed.endsWith(":") &&
      !trimmed.startsWith("-")
    ) {
      // Group names are the ONLY unknown `key:` nested under `groups:`.
      // Known keys (patterns, dependency-type, schedule, etc.) are handled by
      // earlier branches, so reaching here means it must be a group name.
      const candidate = trimmed.slice(0, -1).trim();
      const keyWithColon = `${candidate.split(":")[0].trim()}:`;
      if (!KNOWN_UPDATE_KEYS.has(keyWithColon) && candidate && !candidate.includes(" ")) {
        currentGroup = candidate;
        if (!currentUpdate.groups) currentUpdate.groups = {};
        currentUpdate.groups[currentGroup] = {};
        currentArrayKey = null;
      }
    } else if (trimmed.startsWith("-")) {
      const itemVal = trimmed.replace(/^[-\s]+/, "").trim().replace(/["']/g, "");
      if (currentArrayKey === "labels") {
        currentUpdate.labels!.push(itemVal);
      } else if (currentArrayKey === "patterns" && currentGroup && currentUpdate.groups?.[currentGroup]) {
        currentUpdate.groups[currentGroup].patterns!.push(itemVal);
      } else if (
        currentArrayKey === "exclude-patterns" &&
        currentGroup &&
        currentUpdate.groups?.[currentGroup]
      ) {
        currentUpdate.groups[currentGroup]["exclude-patterns"]!.push(itemVal);
      }
    }
  }

  if (currentUpdate && currentUpdate["package-ecosystem"]) {
    updates.push(currentUpdate as DependabotUpdate);
  }

  return { version, updates };
}

describe("Dependabot Security & Strict Schema Verification", () => {
  const rootDir = process.cwd();
  const dependabotPath = path.join(rootDir, ".github", "dependabot.yml");
  const azurePipelinesPath = path.join(rootDir, "azure-pipelines.yml");

  it("conforms strictly to Dependabot v2 schema specification", () => {
    expect(fs.existsSync(dependabotPath)).toBe(true);
    const content = fs.readFileSync(dependabotPath, "utf8");
    const parsed = parseDependabotYaml(content);

    expect(parsed.version).toBe(2);
    expect(Array.isArray(parsed.updates)).toBe(true);
    expect(parsed.updates.length).toBeGreaterThanOrEqual(2);

    for (const update of parsed.updates) {
      expect(VALID_ECOSYSTEMS.has(update["package-ecosystem"])).toBe(true);
      expect(update.directory.startsWith("/")).toBe(true);
      expect(VALID_INTERVALS.has(update.schedule.interval)).toBe(true);

      if (update.schedule.day) {
        expect(VALID_DAYS.has(update.schedule.day.toLowerCase())).toBe(true);
      }

      if (update.schedule.time) {
        // Must strictly match 24h time format HH:MM
        expect(update.schedule.time).toMatch(/^([01]\d|2[0-3]):[0-5]\d$/);
      }

      if (update["open-pull-requests-limit"] !== undefined) {
        expect(Number.isInteger(update["open-pull-requests-limit"])).toBe(true);
        expect(update["open-pull-requests-limit"]).toBeGreaterThanOrEqual(1);
        expect(update["open-pull-requests-limit"]).toBeLessThanOrEqual(50);
      }

      if (update.labels) {
        expect(Array.isArray(update.labels)).toBe(true);
        expect(update.labels.length).toBeGreaterThan(0);
        for (const label of update.labels) {
          expect(typeof label).toBe("string");
          expect(label.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it("contains no duplicate (ecosystem, directory) pairs", () => {
    const content = fs.readFileSync(dependabotPath, "utf8");
    const parsed = parseDependabotYaml(content);

    const seen = new Set<string>();
    for (const update of parsed.updates) {
      const key = `${update["package-ecosystem"]}::${update.directory}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it("configures npm ecosystem with existing manifests and production/dev grouping", () => {
    const content = fs.readFileSync(dependabotPath, "utf8");
    const parsed = parseDependabotYaml(content);

    const npm = parsed.updates.find((u) => u["package-ecosystem"] === "npm");
    expect(npm).toBeDefined();
    expect(npm?.directory).toBe("/");

    // Verify package manifests exist
    expect(fs.existsSync(path.join(rootDir, "package.json"))).toBe(true);
    expect(fs.existsSync(path.join(rootDir, "package-lock.json"))).toBe(true);

    // Verify native dependency-type groups exist
    expect(npm?.groups?.["production-dependencies"]?.["dependency-type"]).toBe("production");
    expect(npm?.groups?.["dev-dependencies"]?.["dependency-type"]).toBe("development");
    expect(npm?.["commit-message"]?.prefix).toBe("chore(deps)");
  });

  it("configures cargo ecosystem with existing Tauri manifests and group rules", () => {
    const content = fs.readFileSync(dependabotPath, "utf8");
    const parsed = parseDependabotYaml(content);

    const cargo = parsed.updates.find((u) => u["package-ecosystem"] === "cargo");
    expect(cargo).toBeDefined();
    expect(cargo?.directory).toBe("/src-tauri");

    // Verify cargo manifests exist
    expect(fs.existsSync(path.join(rootDir, "src-tauri", "Cargo.toml"))).toBe(true);
    expect(fs.existsSync(path.join(rootDir, "src-tauri", "Cargo.lock"))).toBe(true);

    expect(cargo?.groups?.["cargo-dependencies"]?.patterns).toContain("*");
    expect(cargo?.["commit-message"]?.prefix).toBe("chore(deps-cargo)");
  });

  it("monitors only active development ecosystems (npm and cargo), avoiding locked GitHub Actions", () => {
    const content = fs.readFileSync(dependabotPath, "utf8");
    const parsed = parseDependabotYaml(content);

    const ecosystems = parsed.updates.map((u) => u["package-ecosystem"]);
    expect(ecosystems).toContain("npm");
    expect(ecosystems).toContain("cargo");
    expect(ecosystems).not.toContain("github-actions");
  });

  it("staggers update schedules across distinct UTC time slots", () => {
    const content = fs.readFileSync(dependabotPath, "utf8");
    const parsed = parseDependabotYaml(content);

    const times = parsed.updates.map((u) => u.schedule.time).filter(Boolean);
    const uniqueTimes = new Set(times);
    expect(uniqueTimes.size).toBe(times.length);
  });

  it("integrates seamlessly with Azure Pipelines CI and GitHub CD", () => {
    expect(fs.existsSync(azurePipelinesPath)).toBe(true);
    const azureContent = fs.readFileSync(azurePipelinesPath, "utf8");

    // Validates that Azure CI tests all package ecosystems
    expect(azureContent).toContain("npm ci");
    expect(azureContent).toContain("npm run typecheck");
    expect(azureContent).toContain("npm test");
    expect(azureContent).toContain("cargo check --manifest-path src-tauri/Cargo.toml");

    // Validates that CD release mechanism to GitHub is configured
    expect(azureContent).toContain("scripts/release-to-github.mjs");
    expect(fs.existsSync(path.join(rootDir, "scripts", "release-to-github.mjs"))).toBe(true);
  });

  it("parser creates no phantom groups and preserves # inside quoted values", () => {
    const content = fs.readFileSync(dependabotPath, "utf8");
    const parsed = parseDependabotYaml(content);

    // Regression: `schedule:` must never appear as a dependency group.
    for (const update of parsed.updates) {
      const groupNames = Object.keys(update.groups ?? {});
      expect(groupNames).not.toContain("schedule");
      expect(groupNames).not.toContain("commit-message");
      expect(groupNames).not.toContain("ignore");
      expect(groupNames).not.toContain("labels");
    }

    // Unit-level: # inside quotes is data, not a comment.
    const synthetic = [
      "version: 2",
      "updates:",
      '  - package-ecosystem: "npm"',
      '    directory: "/"',
      "    schedule:",
      '      interval: "weekly"',
      "    groups:",
      "      my-group:",
      '        dependency-type: "production"',
      "    commit-message:",
      '      prefix: "chore#deps"',
      "",
    ].join("\n");
    const syn = parseDependabotYaml(synthetic);
    expect(syn.updates[0]?.["commit-message"]?.prefix).toBe("chore#deps");
    expect(Object.keys(syn.updates[0]?.groups ?? {})).toEqual(["my-group"]);
  });
});
