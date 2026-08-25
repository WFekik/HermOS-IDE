import { describe, it, expect } from "vitest";
import { preprocessContent } from "@/components/ide/message-renderer";
import fc from "fast-check";

// preprocessContent — tables, trees, and requirements rendering
// Note: preprocessContent adds a trailing \n to non-empty output,
// and separator rows are compacted (|---|---| not | --- | --- |).

describe("preprocessContent — basic", () => {
  it("passes through plain text unchanged (preserves trailing newline)", () => {
    expect(preprocessContent("hello world")).toBe("hello world");
    expect(preprocessContent("hello world\n")).toBe("hello world\n");
  });

  it("preserves plain markdown content", () => {
    const result = preprocessContent("# Title\n\nSome **bold** and _italic_ text.\n");
    expect(result).toContain("# Title");
    expect(result).toContain("**bold**");
  });

  it("preserves lists", () => {
    const result = preprocessContent("- item one\n- item two\n- item three\n");
    expect(result).toContain("- item one");
    expect(result).toContain("- item three");
  });

  it("handles empty string", () => {
    expect(preprocessContent("")).toBe("");
  });

  it("preserves headings", () => {
    const result = preprocessContent("# H1\n## H2\n### H3\n");
    expect(result).toContain("# H1");
    expect(result).toContain("## H2");
    expect(result).toContain("### H3");
  });

  it("preserves code blocks", () => {
    const result = preprocessContent("```ts\nconst x = 1;\n```\n");
    expect(result).toContain("```ts");
    expect(result).toContain("const x = 1;");
  });

  it("preserves link references", () => {
    const result = preprocessContent("See [example](https://example.com) for details.\n");
    expect(result).toContain("[example](https://example.com)");
  });
});

describe("preprocessContent — tables", () => {
  it("adds missing GFM separator row for DeepSeek-style tables", () => {
    const input = "| Name | Age |\n| Alice | 30 |\n| Bob | 25 |\n";
    const result = preprocessContent(input);
    expect(result).toContain("| --- | --- |");
    expect(result).toContain("| Alice | 30 |");
    expect(result).toContain("| Bob | 25 |");
  });

  it("normalizes existing separator row", () => {
    const result = preprocessContent("| Name | Age |\n| --- | --- |\n| Alice | 30 |\n");
    expect(result).toContain("| --- | --- |");
    expect(result).toContain("| Name | Age |");
    expect(result).toContain("| Alice | 30 |");
  });

  it("normalizes column counts across rows", () => {
    const input = "| A | B | C |\n| 1 | 2 |\n| 3 | 4 | 5 |\n";
    const result = preprocessContent(input);
    const lines = result.split("\n").filter((l) => l.startsWith("|") && !l.includes("---"));
    // All data lines should have same column count (pipe-minus-border) as the widest row (3)
    for (const line of lines) {
      const cols = line.split("|").length - 2; // subtract leading & trailing empty
      expect(cols).toBe(3);
    }
  });

  it("normalizes to at least 2 columns", () => {
    const result = preprocessContent("| X |\n| y |\n");
    expect(result).toContain("| X |");
    expect(result).toContain("---");
    const sepLine = result.split("\n").find((l) => l.includes("---"));
    expect(sepLine).toBeTruthy();
    if (sepLine) {
      expect(sepLine.split("|").filter((s) => s.trim().includes("---")).length).toBeGreaterThanOrEqual(2);
    }
  });

  it("handles pipe in inline code (not treated as table row)", () => {
    const result = preprocessContent("Use `|` to separate values in the table.\n");
    // The line has < 2 pipes so it's not treated as a table
    expect(result).not.toContain("---");
  });

  it("handles pipe in inline code next to a real table", () => {
    const input = "The `|` char is a pipe.\n| A | B |\n| 1 | 2 |\n";
    const result = preprocessContent(input);
    expect(result).toContain("| A | B |");
    expect(result).toContain("| 1 | 2 |");
  });

  it("handles tree lines with pipes (not treated as table rows)", () => {
    const input = "| ├── src/\n| │   ├── index.ts\n| │   └── utils.ts\n";
    const result = preprocessContent(input);
    expect(result).toContain("```tree");
    expect(result).not.toContain("|---|---|");
  });

  it("handles multiple tables separated by text", () => {
    const input = "| A | B |\n| 1 | 2 |\n\nSome text\n\n| C | D |\n| 3 | 4 |\n";
    const result = preprocessContent(input);
    expect(result).toContain("| A | B |");
    expect(result).toContain("| C | D |");
    expect(result).toContain("Some text");
  });

  it("handles tables with formatted cell content", () => {
    const input = "| Name | Description |\n| **Bold** | `code` |\n| _italic_ | [link](u) |\n";
    const result = preprocessContent(input);
    const boldRow = result.split("\n").find((l) => l.includes("**Bold**"));
    expect(boldRow).toBeTruthy();
    expect(boldRow).toContain("**Bold**");
  });

  it("handles tables with Unicode content", () => {
    const input = "| 🏷️ | Значение |\n| A | 你好 |\n| B | émoji 🎉 |\n";
    const result = preprocessContent(input);
    expect(result).toContain("| 🏷️ |");
    expect(result).toContain("| A |");
    expect(result).toContain("| B |");
  });

  it("handles single data row (header + one row, no separator)", () => {
    const input = "| X | Y |\n| 1 | 2 |\n";
    const result = preprocessContent(input);
    expect(result).toContain("| X | Y |");
    expect(result).toContain("| 1 | 2 |");
    expect(result).toContain("---");
  });

  it("handles empty table cells", () => {
    const input = "| A | B | C |\n| 1 | | 3 |\n| | x | |\n";
    const result = preprocessContent(input);
    const dataLines = result.split("\n").filter((l) => l.startsWith("|") && !l.includes("---"));
    expect(dataLines.length).toBeGreaterThanOrEqual(3);
  });

  it("does not process tables inside code blocks", () => {
    const result = preprocessContent("```\n| A | B |\n| 1 | 2 |\n```\n");
    // Content inside code blocks is untouched
    expect(result).toContain("```");
    expect(result).toContain("| A | B |");
    expect(result).toContain("| 1 | 2 |");
    // No separator row added inside the code block
    const contentInside = result.slice(result.indexOf("```") + 3, result.lastIndexOf("```"));
    expect(contentInside).not.toContain("---");
  });

  it("handles table with many columns", () => {
    const cols = Array.from({ length: 20 }, (_, i) => `Col${i + 1}`);
    const vals = Array.from({ length: 20 }, (_, i) => `v${i + 1}`);
    const input = "| " + cols.join(" | ") + " |\n| " + vals.join(" | ") + " |\n";
    const result = preprocessContent(input);
    expect(result).toContain("| Col1 |");
    expect(result).toContain("| v1 |");
    const sepLine = result.split("\n").find((l) => l.includes("---"));
    expect(sepLine).toBeTruthy();
    if (sepLine) {
      expect(sepLine.split("|").filter((s) => s.trim().includes("---")).length).toBe(20);
    }
  });

  it("handles table with 100 rows", () => {
    const rows = Array.from({ length: 100 }, (_, i) => `| Row ${i} | value ${i} |`);
    const input = "| Name | Value |\n" + rows.join("\n") + "\n";
    const result = preprocessContent(input);
    expect(result).toContain("| Row 0 |");
    expect(result).toContain("| Row 99 |");
  });

  it("handles table with inline code spans in cells", () => {
    const input = "| A | B |\n| `|` | C |\n| D | `a|b` |\n";
    const result = preprocessContent(input);
    expect(result).toContain("| A | B |");
    expect(result).toContain("`|`");
  });

  it("does not create tables from lines with only one pipe", () => {
    const input = "| This is not a table\nneither is this |\n";
    const result = preprocessContent(input);
    expect(result).not.toContain("---");
  });

  it("handles table with separator row but no data rows", () => {
    const result = preprocessContent("| H1 | H2 |\n| --- | --- |\n");
    expect(result).toContain("| H1 | H2 |");
    expect(result).toContain("---");
  });

  it("handles table with separator row matching content", () => {
    // | --- | is ambiguous: it could be a sep row or a content row
    // With only whitespace+minus cells, it IS treated as a sep row
    const result = preprocessContent("| Name | Time |\n| --- | --- |\n| Bob | 5:00 |\n| Alice | --- |\n");
    expect(result).toContain("| Bob | 5:00 |");
    expect(result).toContain("| Alice | --- |");
  });

  it("strips leading/trailing pipes from inline-code placeholders before table detection", () => {
    const result = preprocessContent("The `|` char and `---` are markdown syntax.\n| A | B |\n| `|` | `---` |\n");
    expect(result).toContain("| A | B |");
    expect(result).toContain("`---`");
  });
});

describe("preprocessContent — trees", () => {
  it("wraps basic tree in ```tree block", () => {
    const input = "src\n├── index.ts\n└── utils.ts\n";
    const result = preprocessContent(input);
    expect(result).toContain("```tree");
    expect(result).toContain("├── index.ts");
    expect(result).toContain("└── utils.ts");
  });

  it("handles tree with nested directories", () => {
    const input = "project\n├── src/\n│   ├── components/\n│   │   ├── Button.tsx\n│   │   └── Card.tsx\n│   └── index.ts\n└── README.md\n";
    const result = preprocessContent(input);
    expect(result).toContain("```tree");
    expect(result).toContain("│   ├── components/");
    expect(result).toContain("│   │   ├── Button.tsx");
    expect(result).toMatch(/```tree\s*\n[\s\S]*?\n```/);
  });

  it("handles single-line tree", () => {
    const result = preprocessContent("└── file.txt\n");
    expect(result).toContain("```tree");
    expect(result).toContain("└── file.txt");
  });

  it("handles tree with vertical-bar-only lines", () => {
    const result = preprocessContent("│\n├── a\n│\n└── b\n");
    expect(result).toContain("```tree");
    expect(result).toContain("│");
  });

  it("handles tree with header ending in /", () => {
    const result = preprocessContent("src/\n├── index.ts\n└── utils.ts\n");
    expect(result).toContain("```tree");
    expect(result).toContain("src/");
  });

  it("handles tree with backslash path separator", () => {
    const result = preprocessContent("src\\\n├── index.ts\n└── utils.ts\n");
    expect(result).toContain("```tree");
  });

  it("handles tree with . root indicator", () => {
    const result = preprocessContent(".\n├── src/\n└── README.md\n");
    expect(result).toContain("```tree");
    expect(result).toContain(".");
  });

  it("handles adjacent trees", () => {
    const result = preprocessContent("frontend/\n├── src/\n│   └── App.tsx\nbackend/\n├── server.ts\n└── db.ts\n");
    expect(result).toContain("```tree");
    expect(result).toContain("App.tsx");
    expect(result).toContain("server.ts");
  });

  it("preserves single backticks in tree line content", () => {
    const result = preprocessContent("└── `file`.ts\n");
    expect(result).toContain("```tree");
    // Single backticks are preserved (only 3+ consecutive are stripped to avoid fence breakage)
    expect(result).toContain("└── `file`.ts");
  });

  it("does not process tree inside markdown code blocks", () => {
    const result = preprocessContent("```\n├── should be ignored\n└── because inside code block\n```\n");
    expect(result).not.toContain("```tree");
    expect(result).toContain("```\n├── should be ignored\n└── because inside code block\n```");
  });

  it("does not treat lone ─ as tree (prevents prose false positive)", () => {
    // Lone ─ without ├ or └ is now ignored to avoid wrapping prose like
    // "features ── they are great" as a tree block.
    const result = preprocessContent("─ a\n─ b\n─ c\n");
    expect(result).not.toContain("```tree");
  });

  it("handles tree with ┬ junction characters", () => {
    const result = preprocessContent("┬ a\n├── b\n└── c\n");
    expect(result).toContain("```tree");
  });

  it("handles very deep nesting (10+ levels)", () => {
    const lines: string[] = ["root/"];
    for (let i = 0; i < 10; i++) {
      lines.push("│   ".repeat(i) + "├── level" + i + "/");
    }
    lines.push("│   ".repeat(10) + "└── leaf.ts");
    const input = lines.join("\n") + "\n";
    const result = preprocessContent(input);
    expect(result).toContain("```tree");
    expect(result).toContain("leaf.ts");
  });

  it("no longer wraps prose containing lone ─ as tree", () => {
    // ─ is excluded from tree detection to avoid false positives like em dashes
    const result = preprocessContent("The project has these features ── they are great.\n");
    expect(result).not.toContain("```tree");
    expect(result).toContain("features ── they");
  });

  it("handles mixed ├ and └ branches at same level", () => {
    const result = preprocessContent("root\n├── a\n├── b\n├── c\n└── d\n");
    expect(result).toContain("```tree");
    const treeBlock = result.slice(result.indexOf("```tree"), result.lastIndexOf("```") + 3);
    expect(treeBlock).toContain("├── a");
    expect(treeBlock).toContain("├── b");
    expect(treeBlock).toContain("├── c");
    expect(treeBlock).toContain("└── d");
  });

  it("handles tree with bare │ connector continuation lines", () => {
    const result = preprocessContent("dir\n│\n├── file.ts\n│\n└── other.ts\n");
    expect(result).toContain("```tree");
    expect(result).toContain("│");
  });
});

describe("preprocessContent — requirements / realistic content", () => {
  it("preprocesses an implementation plan with table", () => {
    const input = `# Implementation Plan

## Tasks

| Task | Status | Priority |
| Auth module | ✅ Done | High |
| Database | 🚧 In Progress | High |
| Tests | ⏳ Pending | Medium |

## Notes

- Auth uses JWT
- DB is SQLite
`;
    const result = preprocessContent(input);
    expect(result).toContain("# Implementation Plan");
    expect(result).toContain("| Auth module | ✅ Done | High |");
    expect(result).toContain("- Auth uses JWT");
  });

  it("preprocesses a requirements document with multiple tables", () => {
    const input = `# Requirements

## Functional

| ID | Description | Status |
| FR-1 | User login | Approved |
| FR-2 | File upload | Approved |

## Non-Functional

| ID | Description | Target |
| NF-1 | Response time | <200ms |
| NF-2 | Availability | 99.9% |

## Timeline

- Phase 1: Q1
- Phase 2: Q2
`;
    const result = preprocessContent(input);
    expect(result).toContain("| FR-1 | User login | Approved |");
    expect(result).toContain("| NF-1 | Response time | <200ms |");
    expect(result).toContain("- Phase 1: Q1");
    expect(result).toContain("# Requirements");
  });

  it("preprocesses a document with tree + table + code blocks", () => {
    const input = `# Architecture

## File Structure

src/
├── components/
│   └── app.tsx
└── index.ts

## Configuration

\`\`\`json
{
  "name": "test"
}
\`\`\`

## Schema

| Column | Type | Default |
| id | int | auto |
| name | text | null |
`;
    const result = preprocessContent(input);
    expect(result).toContain("```tree");
    expect(result).toContain("├── components/");
    expect(result).toContain("```json");
    expect(result).toContain('"name": "test"');
    expect(result).toContain("| Column | Type | Default |");
  });

  it("preprocesses an architecture decision record", () => {
    const result = preprocessContent(`# ADR-001: Use SQLite

## Context

We need a database for the IDE.

## Decision

Use SQLite via Prisma ORM.

## Consequences

| Pro | Con |
| Simplicity | Limited concurrency |
| Zero config | No replication |
`);
    expect(result).toContain("# ADR-001: Use SQLite");
    expect(result).toContain("| Simplicity | Limited concurrency |");
  });

  it("preprocesses a specification with checklist and commands", () => {
    const result = preprocessContent(`# Spec v2.0

## Checklist

- [x] Auth flow
- [ ] Tests
- [ ] Docs

## Commands

\`\`\`bash
npm run build
npm run test
\`\`\`

## Tree

src/
├── lib/
│   └── db.ts
└── app.tsx
`);
    expect(result).toContain("- [x] Auth flow");
    expect(result).toContain("- [ ] Tests");
    expect(result).toContain("```bash");
    expect(result).toContain("```tree");
    expect(result).toContain("├── lib/");
  });

  it("preprocesses a progress report with table of metrics", () => {
    const result = preprocessContent(`# Sprint Report

| Metric | Value | Change |
| Coverage | 85% | +5% |
| Bugs | 12 | -3 |
| Velocity | 34 | +2 |

## Blockers

None.
`);
    expect(result).toContain("| Coverage | 85% | +5% |");
    expect(result).toContain("| Bugs | 12 | -3 |");
    expect(result).toContain("## Blockers");
  });

  it("preprocesses a design doc with nested table content", () => {
    const result = preprocessContent(`# Design

## Endpoints

| Method | Path | Auth |
| GET | /api/users | JWT |
| POST | /api/items | API Key |

### Request Body (POST /api/items)

\`\`\`json
{"name": "item"}
\`\`\`
`);
    expect(result).toContain("| GET | /api/users | JWT |");
    expect(result).toContain("| POST | /api/items | API Key |");
    expect(result).toContain('{"name": "item"}');
  });
});

describe("preprocessContent — combined edge cases", () => {
  it("handles table with separator-looking content cell values", () => {
    const result = preprocessContent("| Name | Time |\n| --- | --- |\n| Bob | 5:00 |\n| Alice | --- |\n");
    expect(result).toContain("| Bob | 5:00 |");
    expect(result).toContain("| Alice | --- |");
  });

  it("handles many inline code spans mixed with tables", () => {
    const input = "The `|` char and `---` are markdown syntax.\n| A | B |\n| `|` | `---` |\n";
    const result = preprocessContent(input);
    expect(result).toContain("| A | B |");
    expect(result).toContain("`---`");
  });

  it("handles content where tree line starts with |", () => {
    const result = preprocessContent("| ├── src\n| └── lib\n");
    expect(result).toContain("```tree");
  });

  it("handles table immediately followed by tree", () => {
    const input = "| A | B |\n| 1 | 2 |\nsrc/\n├── index.ts\n└── util.ts\n";
    const result = preprocessContent(input);
    expect(result).toContain("| A | B |");
    expect(result).toContain("```tree");
    expect(result).toContain("├── index.ts");
  });

  it("handles tree immediately followed by table", () => {
    const input = "src/\n├── index.ts\n| A | B |\n| 1 | 2 |\n";
    const result = preprocessContent(input);
    expect(result).toContain("```tree");
    expect(result).toContain("| A | B |");
  });

  it("does not interpret blockquote markers as table rows", () => {
    const result = preprocessContent("> | Not a table |\n> just a quote\n");
    expect(result).not.toContain("---");
  });
});

describe("preprocessContent — ReDoS resistance", () => {
  it("handles many alternating pipe patterns without catastrophic backtracking", () => {
    const input = "| " + "a | ".repeat(500) + "\n";
    const start = performance.now();
    const result = preprocessContent(input);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(500);
    expect(result).toBeTruthy();
  });

  it("handles many box-drawing chars in a row without performance issues", () => {
    const input = "├".repeat(1000) + "\n";
    const start = performance.now();
    const result = preprocessContent(input);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(500);
    expect(result).toBeTruthy();
  });

  it("handles hugely wide line with pipes and no newlines", () => {
    const line = "|" + "x".repeat(50000) + "|\n";
    const start = performance.now();
    const result = preprocessContent(line);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(1000);
    expect(result).toBeTruthy();
  });

  it("handles 1000 table rows with good performance", () => {
    const rows = Array.from({ length: 1000 }, (_, i) => `| row ${i} | val ${i} | data ${i} |`);
    const input = "| A | B | C |\n" + rows.join("\n") + "\n";
    const start = performance.now();
    const result = preprocessContent(input);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(2000);
    const dataLines = result.split("\n").filter((l) => l.startsWith("|") && !l.includes("---"));
    expect(dataLines.length).toBe(1001);
  });
});

describe("preprocessContent — adversarial edge cases", () => {
  it("handles content that is only pipe characters", () => {
    expect(preprocessContent("|\n|\n|\n")).toBeTruthy();
  });

  it("handles content that is only box-drawing chars", () => {
    const result = preprocessContent("├── \n└── \n│   \n");
    expect(result).toContain("```tree");
  });

  it("handles unicode box-drawing chars mixed with CJK", () => {
    const result = preprocessContent("项目\n├── 源代码\n│   └── 主文件.ts\n└── 文档.md\n");
    expect(result).toContain("```tree");
    expect(result).toContain("├── 源代码");
  });

  it("handles very long root header (50+ chars, not a tree header)", () => {
    const input = "this-is-a-very-long-string-that-exceeds-fifty-characters-limit\n├── child\n└── other\n";
    const result = preprocessContent(input);
    // Header > 50 chars so isPossibleTreeHeader returns false
    // But └── line is still a tree line, so it gets wrapped starting from there
    expect(result).toContain("```tree");
  });

  it("handles tree with only │ lines", () => {
    const result = preprocessContent("│\n│\n│\n");
    expect(result).toContain("```tree");
  });

  it("handles tree with mixed tab and space indentation", () => {
    const result = preprocessContent("root\n├── a\n\t├── b\n\t└── c\n└── d\n");
    expect(result).toContain("```tree");
  });

  it("handles table with pipe in cell adjacent to code fence", () => {
    const input = "| Syntax | Description |\n| `\\|` | Escaped pipe |\n\n```js\nconsole.log('hello');\n```\n";
    const result = preprocessContent(input);
    expect(result).toContain("`\\|`");
    expect(result).toContain("```js");
  });
});

describe("preprocessContent — property-based fuzzing", () => {
  it("never throws on any string", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(() => preprocessContent(s)).not.toThrow();
      }),
      { numRuns: 200 },
    );
  });

  it("output length does not catastrophically blow up", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 500 }), (s) => {
        const result = preprocessContent(s);
        expect(result.length).toBeLessThanOrEqual(s.length * 10 + 200);
      }),
      { numRuns: 100 },
    );
  });

  it("idempotent: applying twice produces same result", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 100 }), (s) => {
        const once = preprocessContent(s);
        const twice = preprocessContent(once);
        expect(twice).toBe(once);
      }),
      { numRuns: 100 },
    );
  });

  it("```tree blocks always have matching close fences", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 500 }), (s) => {
        const result = preprocessContent(s);
        const openCount = (result.match(/```tree/g) || []).length;
        const closeCount = (result.match(/^```$/gm) || []).length;
        expect(closeCount).toBeGreaterThanOrEqual(openCount);
      }),
      { numRuns: 100 },
    );
  });
});

describe("CodeBlock tree detection regex", () => {
  const TREE_RE = /[├└│─┬]/;

  it("detects box-drawing chars in text content", () => {
    expect(TREE_RE.test("├── src")).toBe(true);
    expect(TREE_RE.test("└── lib")).toBe(true);
    expect(TREE_RE.test("│   index.ts")).toBe(true);
    expect(TREE_RE.test("───")).toBe(true);
    expect(TREE_RE.test("┬ a")).toBe(true);
  });

  it("does not detect box-drawing chars in plain text", () => {
    expect(TREE_RE.test("hello world")).toBe(false);
    expect(TREE_RE.test("const x = 1;")).toBe(false);
    expect(TREE_RE.test("# Heading")).toBe(false);
    expect(TREE_RE.test("---")).toBe(false);
    expect(TREE_RE.test("--")).toBe(false);
    expect(TREE_RE.test("| table | row |")).toBe(false);
  });

  it("detects box-drawing chars mixed with unicode", () => {
    expect(TREE_RE.test("项目\n├── 源代码")).toBe(true);
    expect(TREE_RE.test("émoji 🎉 ── text")).toBe(true);
  });

  it("detects each box-drawing char individually", () => {
    expect(TREE_RE.test("├")).toBe(true);
    expect(TREE_RE.test("└")).toBe(true);
    expect(TREE_RE.test("│")).toBe(true);
    expect(TREE_RE.test("─")).toBe(true);
    expect(TREE_RE.test("┬")).toBe(true);
  });

  it("does not confuse ASCII dashes with box-drawing ──", () => {
    expect(TREE_RE.test("---")).toBe(false);
    expect(TREE_RE.test("--")).toBe(false);
    expect(TREE_RE.test("- ")).toBe(false);
  });

  it("property: plain ASCII text never triggers tree detection", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 50 }), (s) => {
        // ASCII strings should not contain Unicode box-drawing chars
        expect(TREE_RE.test(s)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });
});

describe("preprocessContent — stress tests", () => {
  it("handles 2000 lines of mixed content without excessive time", () => {
    const lines: string[] = [];
    for (let i = 0; i < 1000; i++) {
      lines.push(`| row ${i} | col2 | col3 |`);
    }
    for (let i = 0; i < 1000; i++) {
      lines.push(`├── file_${i}.ts`);
    }
    const input = lines.join("\n");
    const start = performance.now();
    const result = preprocessContent(input);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(3000);
    expect(result).toContain("```tree");
    expect(result).toContain("| row 0 |");
  });

  it("repeated application does not multiply structure", () => {
    const input = `# Project

## Structure

src/
├── main.ts
├── lib/
│   ├── a.ts
│   └── b.ts
└── test.ts

## Data

| Name | Value |
| x | 1 |
| y | 2 |
`;
    let result = input;
    for (let i = 0; i < 20; i++) {
      result = preprocessContent(result);
    }
    expect(result).toContain("```tree");
    expect(result).toContain("| x | 1 |");
    const treeBlocks = result.match(/```tree/g) || [];
    expect(treeBlocks.length).toBe(1);
  });
});
