import { describe, it, expect } from "vitest";
import { isTreeLineContent, splitInlineTree, preprocessContent, stripTreeFenceLine } from "@/components/ide/message-renderer";
import { sanitizeContent } from "@/lib/sanitize-content";

/**
 * Regression test: single-line horizontal tree blobs (branch markers with
 * bare `|` separators and backticked spans, as models often emit) must be
 * re-fenced into vertical ```tree blocks with no literal backticks or
 * trailing separator artifacts.
 */
const BLOB =
  "`src/features/todos/` \u251c\u2500\u2500 `components/` | \u251c\u2500\u2500 `TodoList.tsx` | \u251c\u2500\u2500 `TodoItem.tsx` | \u251c\u2500\u2500 `TodoForm.tsx` | \u2514\u2500\u2500 `TodoFilter.tsx` |\u2014 `hooks/` | \u2514\u2500\u2500 `useTodos.ts` `index.ts` (export `components` + `logic`)";

describe("horizontal tree blob rescue", () => {
  it("detects", () => {
    expect(isTreeLineContent(BLOB)).toBe(true);
  });
  it("splits", () => {
    const parts = splitInlineTree(BLOB);
    expect(parts.length).toBeGreaterThan(1);
  });
  it("fences", () => {
    const md = "Suggested minimal structure:\n" + BLOB + "\n\nNext para.";
    const out = preprocessContent(md);
    expect(out).toContain("```tree");
    // No literal backticks survive inside the tree fence body.
    const bodyStart = out.indexOf("```tree") + "```tree".length;
    const fenceBody = out.slice(bodyStart, out.indexOf("```", bodyStart));
    expect(fenceBody).not.toContain("`");
    // No trailing separator artifacts on fence lines.
    for (const l of fenceBody.split("\n")) {
      expect(l).not.toMatch(/[ \t]+[│|][ \t]*$/);
    }
  });
  it("strips backtick wraps", () => {
    expect(stripTreeFenceLine("├── `components/` |")).toBe("├── components/");
  });

  it("unwraps model-authored tree fences containing prose, not trees", () => {
    const md =
      "Here's a proper tree:\n```tree\nThe first one used simple indentation\n```\n\n```tree\nsrc/\n├── a.ts\n```\n";
    const out = preprocessContent(md);
    // Prose fence dropped, real tree fence kept.
    expect(out).toContain("The first one used simple indentation");
    expect(out).not.toContain("```tree\nThe first one");
    expect(out).toContain("```tree\nsrc/\n├── a.ts\n```");
  });

  it("rescues multi-line chains with one marker per line", () => {
    const chained = [
      "`project/` |— `dist/` |",
      "| |— `assets/` |",
      "| |— `favicon.svg` |",
      "|— `src/` |",
      "| |— `App.tsx` |",
    ].join("\n");
    const out = preprocessContent("Here's the visual tree:\n" + chained + "\n\nDone.");
    expect(out).toContain("```tree");
    const bodyStart = out.indexOf("```tree") + "```tree".length;
    const fenceBody = out.slice(bodyStart, out.indexOf("```", bodyStart));
    expect(fenceBody).not.toContain("`");
    // Header and continuation must land on separate lines (no two entries
    // share one fence line).
    expect(fenceBody).toContain("project/\n");
    expect(fenceBody).toContain("|— dist/");
  });

  it("rescues pipe-dash blobs with deep nesting", () => {
    const dashBlob =
      "`project/` |— `dist/` | |— `assets/` | |— `favicon.svg` | |— `index.html` |— `node_modules/` (omitted - 100+ dirs) |— `public/` | |— `favicon.svg` |— `src/` | |— `assets/` | | |— `hero.png` | | |— `react.svg` |— `features/` | | |— `todos/` | | | |— `index.ts` | | | |— `todos.test.ts` | | | |— `todos.ts` | | |— `App.css` | |— `App.tsx` | |— `main.tsx` | |— `.gitignore` |— `index.html` |— `package.json` |— `README.md`";
    expect(isTreeLineContent(dashBlob)).toBe(true);
    const out = preprocessContent("Here's the visual tree:\n" + dashBlob + "\n\nDone.");
    expect(out).toContain("```tree");
    const bodyStart = out.indexOf("```tree") + "```tree".length;
    const fenceBody = out.slice(bodyStart, out.indexOf("```", bodyStart));
    expect(fenceBody).not.toContain("`");
    for (const l of fenceBody.split("\n")) {
      expect(l).not.toMatch(/[ \t]+[│|][ \t]*$/);
    }
  });

  it("rescues backtick-free blobs starting with a dot root", () => {
    const dotBlob =
      ". |— dist/ | |— assets/ | |— favicon.svg | |— icons.svg | |— index.html |— node_modules/ # (dependencies, omitted for brevity) |— public/ | |— favicon.svg |— src/ | |— App.tsx | |— main.tsx |— .gitignore |— index.html |— package.json |— README.md";
    expect(isTreeLineContent(dotBlob)).toBe(true);
    const out = preprocessContent("Here is the tree:\n" + dotBlob + "\n\nDone.");
    expect(out).toContain("```tree");
  });

  it("keeps an already-vertical box-drawing tree vertical end to end", () => {
    const stored = [
      ".",
      "├── dist",
      "│   ├── assets",
      "│   ├── favicon.svg",
      "│   ├── icons.svg",
      "│   └── index.html",
      "├── node_modules",
      "│   └── (many packages)",
      "├── public",
      "│   ├── favicon.svg",
      "│   └── icons.svg",
      "├── src",
      "│   ├── App.tsx",
      "│   └── main.tsx",
      "├── .gitignore",
      "└── vite.config.ts",
    ].join("\n");
    // Full production path: sanitize (as SegmentedMessageRenderer does)
    // then preprocess. Newlines must survive; output must fence vertically.
    const sanitized = sanitizeContent(stored);
    expect(sanitized).toContain("\n");
    const out = preprocessContent("Here is the tree:\n" + sanitized + "\n\nDone.");
    expect(out).toContain("```tree");
    const bodyStart = out.indexOf("```tree") + "```tree".length;
    const fenceBody = out.slice(bodyStart, out.indexOf("```", bodyStart));
    expect(fenceBody).toContain("├── dist");
    expect(fenceBody).toContain("│   ├── assets");
  });

  it("rescues a whole blob wrapped in a single code span", () => {
    const singleSpan =
      "`. |— dist/ | |— assets/ | |— favicon.svg |— src/ | |— App.tsx | |— main.tsx |— package.json`";
    const out = preprocessContent("Here is the tree:\n" + singleSpan + "\n\nDone.");
    expect(out).toContain("```tree");
    const bodyStart = out.indexOf("```tree") + "```tree".length;
    const fenceBody = out.slice(bodyStart, out.indexOf("```", bodyStart));
    expect(fenceBody).not.toContain("`");
    expect(fenceBody).toContain("|— dist/");
    expect(fenceBody).toContain("|— App.tsx");
  });
});
