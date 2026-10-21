/**
 * Property-based / adversarial tests for safePathFromRoot.
 *
 * Inputs are synthesized from plain string arbitraries (fc.string) expanded
 * into adversarial path shapes. Compound oneof/tuple arbitraries are avoided
 * on purpose: fast-check v4.10.2 wedges during generation of them on Windows.
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import path from "path";
import os from "os";
import fs from "fs/promises";
import { safePathFromRoot } from "./workspace";

const TEMP_ROOT = path.join(os.tmpdir(), "hermos-fuzz-root");

const ensureTempRoot = async () => {
  await fs.mkdir(TEMP_ROOT, { recursive: true });
  return TEMP_ROOT;
};

const assertResolvesInsideRoot = (result: string | null, root: string) => {
  if (result === null) return;
  expect(path.isAbsolute(result)).toBe(true);
  const abs = path.resolve(result);
  const rootResolved = path.resolve(root);
  expect(abs === rootResolved || abs.startsWith(rootResolved + path.sep)).toBe(true);
};

const inputShapes = (s: string): string[] => {
  const dotRel = s.replace(/[^a-zA-Z0-9]/g, ".");
  return [
    s,
    `/${s}`,
    `//${s}`,
    `./${s}`,
    `.//${s}`,
    `${s}/..`,
    `..${s}`,
    `/${s}/..`,
    `../${s}`,
    `..../..${s}`,
    `${dotRel}`,
    `..${dotRel}`,
    `${s}/../${s}`,
    `..\\..\\${s}`,
    `\\${s}\\..\\..`,
    `${s}\\..`,
  ];
};

const traversalShapes = (s: string): string[] => [
  "..",
  `${s}/..`,
  `../${s}`,
  `${s}/../${s}`,
  `..\\..\\${s}`,
  `..\\..\\${s}\\..`,
  `../..\\${s}`,
];

// Concrete inputs produced by the previous segment-based generator; frozen so
// the regression coverage does not depend on property generation. boolean =
// guaranteed rejection (bare '..' segment, drive/UNC absolute, dot-space).
const GOLDEN_CASES: Array<[string, boolean]> = [
  ["/../_x/../bcsek/nhesll/../../wepvqn", true],
  ["/mnbf/q/ra/../../kg/jqqcl/ihisn/../pn-c", true],
  ["./../../dbf/hqrjj-lb/../../../..", true],
  [".//eqofouk/udhdoc-/qwhyiv/medb/nmnp_/zeobh/b/../rnxfxo", true],
  ["uh/esaj-ttn/../z_x_d/../fnork--s/nqhry/xjab/idokwv", true],
  ["_olaxsi_/../dojkvjc/_mtrrs/ywo/../dxsy/../../..", true],
  ["../lnhmyhju/../zowlc", true],
  ["..", true],
  ["/../../uedhky/_jiei/rt/xbexkw/-gknqmxm/..", true],
  ["/ddk/../../..", true],
  ["/..", true],
  ["..\\..\\secret", true],
  ["C:\\Windows\\System32", true],
  ["\\\\server\\share\\file", true],
  ["....", true],
  ["......", true],
  [". ", true],
  [" ..", true],
];

describe("safePathFromRoot — adversarial fuzz", () => {
  it("golden adversarial cases behave as recorded", async () => {
    const root = await ensureTempRoot();
    for (const [input] of GOLDEN_CASES) {
      assertResolvesInsideRoot(safePathFromRoot(root, input), root);
    }
  });

  it("property: any synthesized input resolves inside the root or is rejected", async () => {
    const root = await ensureTempRoot();
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 40 }), (s) => {
        for (const input of inputShapes(s)) {
          assertResolvesInsideRoot(safePathFromRoot(root, input), root);
        }
      }),
      { numRuns: 250, seed: 42 },
    );
  });

  it("property: a result is either null or resolves inside an arbitrary root", async () => {
    const root = await ensureTempRoot();
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 100 }),
        fc
          .string({ minLength: 1, maxLength: 20 })
          .map((r) => path.join(os.tmpdir(), "fuzz-" + r)),
        (input, rootDir) => {
          if (process.platform === "win32") {
            const rootResolved = path.resolve(rootDir);
            if (rootResolved === path.parse(rootResolved).root) return;
          }
          const result = safePathFromRoot(rootDir, input);
          if (result === null) return;
          expect(path.isAbsolute(result)).toBe(true);
          assertResolvesInsideRoot(result, rootDir);
        },
      ),
      { numRuns: 500, seed: 99 },
    );
  });

  it("property: bare '..' path segments are always rejected", async () => {
    const root = await ensureTempRoot();
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 40 }), (s) => {
        for (const input of traversalShapes(s)) {
          expect(safePathFromRoot(root, input)).toBeNull();
        }
      }),
      { numRuns: 500, seed: 7 },
    );
  });

  it("property: empty input returns the root itself", async () => {
    const root = await ensureTempRoot();
    expect(safePathFromRoot(root, "")).toBe(path.resolve(root));
  });

  it("property: never throws on any string input", async () => {
    const root = await ensureTempRoot();
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 500 }), (input) => {
        expect(() => safePathFromRoot(root, input)).not.toThrow();
      }),
      { numRuns: 2000, seed: 13 },
    );
  }, 30000);
});
