import { describe, it, expect } from "vitest";
import { extractSymbols, languageFromExt } from "./symbols";

describe("extractSymbols", () => {
  it("should return empty array for non-string input", () => {
    expect(extractSymbols(null as any, "typescript")).toEqual([]);
    expect(extractSymbols(undefined as any, "typescript")).toEqual([]);
    expect(extractSymbols(123 as any, "typescript")).toEqual([]);
  });

  it("should return empty array for empty content", () => {
    expect(extractSymbols("", "typescript")).toEqual([]);
  });

  it("should extract function declarations", () => {
    const code = "function hello() {}\nfunction add(a: number, b: number) {}";
    const symbols = extractSymbols(code, "typescript");
    expect(symbols.length).toBeGreaterThanOrEqual(2);
    expect(symbols[0]).toMatchObject({ name: "hello", kind: "function", line: 1 });
    expect(symbols[1]).toMatchObject({ name: "add", kind: "function", line: 2 });
  });

  it("should extract exported functions", () => {
    const code = "export function greet(name: string) {}\nexport async function fetchData() {}";
    const symbols = extractSymbols(code, "typescript");
    const exports = symbols.filter((s) => s.kind === "function" && s.exportName);
    expect(exports.length).toBeGreaterThanOrEqual(2);
  });

  it("should extract class declarations", () => {
    const code = "class MyClass {}\nexport class ExportedClass {}";
    const symbols = extractSymbols(code, "typescript");
    const classes = symbols.filter((s) => s.kind === "class");
    expect(classes.length).toBeGreaterThanOrEqual(2);
    expect(classes[0].name).toBe("MyClass");
  });

  it("should extract const declarations", () => {
    const code = "const x = 1;\nconst fn = () => {};";
    const symbols = extractSymbols(code, "typescript");
    const consts = symbols.filter((s) => s.kind === "const");
    expect(consts.length).toBeGreaterThanOrEqual(2);
  });

  it("should extract interfaces (TS only)", () => {
    const code = "interface User { name: string; age: number; }";
    const symbols = extractSymbols(code, "typescript");
    const ifaces = symbols.filter((s) => s.kind === "interface");
    expect(ifaces.length).toBeGreaterThanOrEqual(1);
    expect(ifaces[0].name).toBe("User");
  });

  it("should NOT extract interfaces for JS files", () => {
    const code = "interface User { name: string; }";
    const symbols = extractSymbols(code, "javascript");
    const ifaces = symbols.filter((s) => s.kind === "interface");
    expect(ifaces).toHaveLength(0);
  });

  it("should extract type aliases (TS only)", () => {
    const code = "type UserId = string;\nexport type Callback = () => void;";
    const symbols = extractSymbols(code, "typescript");
    const types = symbols.filter((s) => s.kind === "type");
    expect(types.length).toBeGreaterThanOrEqual(2);
  });

  it("should extract import names", () => {
    const code = 'import { useState, useEffect } from "react";';
    const symbols = extractSymbols(code, "typescript");
    const imports = symbols.filter((s) => s.kind === "import");
    expect(imports.length).toBeGreaterThanOrEqual(2);
    expect(imports[0].name).toBe("useState");
    expect(imports[1].name).toBe("useEffect");
  });

  it("should extract export list names", () => {
    const code = "export { foo, bar, baz };";
    const symbols = extractSymbols(code, "typescript");
    const exports = symbols.filter((s) => s.kind === "export");
    expect(exports.length).toBeGreaterThanOrEqual(3);
  });

  it("should handle async functions", () => {
    const code = "async function process() {}\nexport async function handle() {}";
    const symbols = extractSymbols(code, "typescript");
    expect(symbols.length).toBeGreaterThanOrEqual(2);
  });

  it("should handle generator functions", () => {
    const code = "function* generator() {}\nexport async function* asyncGen() {}";
    const symbols = extractSymbols(code, "typescript");
    expect(symbols.length).toBeGreaterThanOrEqual(2);
  });

  it("should skip comment lines", () => {
    const code = `// function commented() {}
/* function blockComment() {} */
function real() {}`;
    const symbols = extractSymbols(code, "typescript");
    const fns = symbols.filter((s) => s.kind === "function");
    expect(fns).toHaveLength(1);
    expect(fns[0].name).toBe("real");
  });

  it("should handle export default function", () => {
    const code = "export default function App() {}\nexport default function() {}";
    const symbols = extractSymbols(code, "typescript");
    const fns = symbols.filter((s) => s.exportName === "default");
    expect(fns.length).toBeGreaterThanOrEqual(1);
  });

  it("should handle export default class", () => {
    const code = "export default class Container {}";
    const symbols = extractSymbols(code, "typescript");
    const cls = symbols.find((s) => s.exportName === "default");
    expect(cls).toBeDefined();
    expect(cls!.kind).toBe("class");
  });

  it("should respect MAX_SYMBOLS cap", () => {
    // Generate enough lines to hit the cap
    const lines: string[] = [];
    for (let i = 0; i < 600; i++) {
      lines.push(`const var${i} = ${i};`);
    }
    const symbols = extractSymbols(lines.join("\n"), "typescript");
    expect(symbols.length).toBeLessThanOrEqual(500);
  });

  it("should return symbols sorted by line number", () => {
    const code = `
function last() {}
function first() {}
function middle() {}
`.trim();
    const symbols = extractSymbols(code, "typescript");
    for (let i = 1; i < symbols.length; i++) {
      expect(symbols[i].line).toBeGreaterThanOrEqual(symbols[i - 1].line);
    }
  });
});

describe("languageFromExt", () => {
  it("should detect TypeScript", () => {
    expect(languageFromExt("file.ts")).toBe("typescript");
    expect(languageFromExt("file.tsx")).toBe("tsx");
  });

  it("should detect JavaScript", () => {
    expect(languageFromExt("file.js")).toBe("javascript");
    expect(languageFromExt("file.jsx")).toBe("jsx");
    expect(languageFromExt("file.mjs")).toBe("javascript");
    expect(languageFromExt("file.cjs")).toBe("javascript");
  });

  it("should return null for unsupported extensions", () => {
    expect(languageFromExt("file.py")).toBeNull();
    expect(languageFromExt("file.css")).toBeNull();
    expect(languageFromExt("file.json")).toBeNull();
    expect(languageFromExt("file")).toBeNull();
  });

  it("should be case-insensitive", () => {
    expect(languageFromExt("file.TS")).toBe("typescript");
    expect(languageFromExt("file.JS")).toBe("javascript");
  });
});
