/**
 * Property-based / adversarial tests for src/lib/workspace.
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import path from "path";
import os from "os";
import fs from "fs/promises";
import { safePathFromRoot } from "./workspace";

const TEMP_ROOT = path.join(os.tmpdir(), "hermos-fuzz-root");

// We create the temp root once. fast-check is deterministic per seed.
const ensureTempRoot = async () => {
  await fs.mkdir(TEMP_ROOT, { recursive: true });
  return TEMP_ROOT;
};

// A relative-path arbitrary: a mix of plain segments and ".." segments.
const segmentArbitrary = fc.oneof(
  fc.constant(".."),
  fc.stringMatching(/^[a-zA-Z0-9_-]{1,8}$/),
);

const relPathArbitrary = fc
  .array(segmentArbitrary, { minLength: 0, maxLength: 12 })
  .map((parts) => parts.join("/"));

// Allow leading "./" or "/" — they're stripped by the implementation.
const relPathWithPrefixArbitrary = fc
  .tuple(
    fc.option(fc.constantFrom("/", "//", "./", ".//", ""), { nil: "" }),
    relPathArbitrary,
  )
  .map(([prefix, body]) => prefix + body);

describe("safePathFromRoot — property-based fuzz", () => {
  it("property: an input containing a '..' segment NEVER escapes the root", async () => {
    const root = await ensureTempRoot();
    fc.assert(
      fc.property(relPathWithPrefixArbitrary, (input) => {
        // Only assert for inputs that actually contain '..'.
        if (!input.includes("..")) return; // skip non-attack inputs

        const result = safePathFromRoot(root, input);
        if (result === null) return; // correctly rejected

        // If we got back a path, it must resolve inside the root.
        const abs = path.resolve(result);
        const rootResolved = path.resolve(root);
        const ok =
          abs === rootResolved || abs.startsWith(rootResolved + path.sep);
        expect(ok).toBe(true);
      }),
      { numRuns: 2000, seed: 42 },
    );
  });

  it("property: a result is either null or resolves inside the root", async () => {
    const root = await ensureTempRoot();
    fc.assert(
      fc.property(
        // Combine any string with any "root" path
        fc.string({ minLength: 0, maxLength: 100 }),
        fc.string({ minLength: 1, maxLength: 20 }).map((s) => path.join(os.tmpdir(), "fuzz-" + s)),
        (input, rootDir) => {
          const result = safePathFromRoot(rootDir, input);
          if (result === null) return;
          // Result must be absolute.
          expect(path.isAbsolute(result)).toBe(true);
          // Result must resolve to a path that is `rootDir` itself
          // or a child of it.
          const abs = path.resolve(result);
          const rootResolved = path.resolve(rootDir);
          expect(
            abs === rootResolved || abs.startsWith(rootResolved + path.sep),
          ).toBe(true);
        },
      ),
      { numRuns: 2000, seed: 99 },
    );
  });

  it("property: result is null iff input contains a '..' path segment", async () => {
    const root = await ensureTempRoot();
    fc.assert(
      fc.property(relPathWithPrefixArbitrary, (input) => {
        const result = safePathFromRoot(root, input);
        // If result is non-null, the input must NOT have had a '..'
        // segment. (Conversely, we don't require the converse — there
        // may be additional rejection criteria like the symlink check.)
        if (result !== null) {
          // Either no '..', or '..' was inside a filename like 'foo..bar'.
          // We check segment-wise: split by / and verify no segment is exactly '..'.
          const segments = input.replace(/\\/g, "/").split("/").filter(Boolean);
          const hasBareDotDot = segments.includes("..");
          expect(hasBareDotDot).toBe(false);
        }
      }),
      { numRuns: 1000, seed: 7 },
    );
  });

  it("property: empty input returns the root itself", async () => {
    const root = await ensureTempRoot();
    fc.assert(
      fc.property(fc.constant(""), (input) => {
        const result = safePathFromRoot(root, input);
        expect(result).toBe(path.resolve(root));
      }),
      { numRuns: 10 },
    );
  });

  it("property: never throws on any string input", async () => {
    const root = await ensureTempRoot();
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 500 }), (input) => {
        // Must never throw — defensive coding for a security primitive.
        expect(() => safePathFromRoot(root, input)).not.toThrow();
      }),
      { numRuns: 2000, seed: 13, timeout: 10000 },
    );
  }, 30000);

  it("property: backslash-containing inputs are never allowed to escape (Windows-style)", async () => {
    const root = await ensureTempRoot();
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 50 }),
        (arbitraryPrefix) => {
          // Build adversarial inputs that mix forward + backslashes
          const inputs = [
            `..\\..\\${arbitraryPrefix}`,
            `${arbitraryPrefix}\\..\\..\\etc`,
            `..\\${arbitraryPrefix}\\..`,
          ];
          for (const input of inputs) {
            if (input.includes("..")) {
              const result = safePathFromRoot(root, input);
              if (result === null) continue;
              // If not null, must still be inside root.
              expect(
                path.resolve(result).startsWith(path.resolve(root) + path.sep) ||
                  path.resolve(result) === path.resolve(root),
              ).toBe(true);
            }
          }
        },
      ),
      { numRuns: 1000, seed: 21 },
    );
  });
});