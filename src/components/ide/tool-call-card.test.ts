import { describe, it, expect } from "vitest";
import {
  parseDirectoryResult,
  parseGlobResult,
  parseGrepResult,
  parseWebSearchResult,
  parseHttpFetchResult,
  extractFilePath,
  safeParse,
} from "@/components/ide/tool-call-card";

describe("parseDirectoryResult", () => {
  it("parses HermOS standard format with entries array", () => {
    const raw = {
      path: "src/app/api/auth",
      entries: [
        { name: "logout", type: "dir" },
        { name: "me", type: "dir" },
        { name: "[...nextauth]", type: "dir" },
        { name: "route.ts", type: "file", size: 1024 },
        { name: "send-code", type: "dir" },
      ],
      files: 1,
      dirs: 4,
    };
    const parsed = parseDirectoryResult(raw);
    expect(parsed).not.toBeNull();
    expect(parsed?.basePath).toBe("src/app/api/auth");
    expect(parsed?.entries.length).toBe(5);

    // Directories first, sorted A-Z
    const dirNames = parsed?.entries.filter((e) => e.type === "dir").map((e) => e.name);
    expect(dirNames).toEqual(["[...nextauth]", "logout", "me", "send-code"]);

    // Files after directories
    const fileEntries = parsed?.entries.filter((e) => e.type === "file");
    expect(fileEntries?.[0].name).toBe("route.ts");
    expect(fileEntries?.[0].size).toBe(1024);
  });

  it("parses MCP / string array directory listings", () => {
    const raw = [
      "src/components/ide/",
      "src/components/workspace/",
      "src/components/ide-shell.tsx",
    ];
    const parsed = parseDirectoryResult(raw, { DirectoryPath: "src/components" });
    expect(parsed).not.toBeNull();
    expect(parsed?.basePath).toBe("src/components");
    expect(parsed?.entries.length).toBe(3);
    expect(parsed?.entries[0].type).toBe("dir");
    expect(parsed?.entries[1].type).toBe("dir");
    expect(parsed?.entries[2].type).toBe("file");
    expect(parsed?.entries[2].name).toBe("ide-shell.tsx");
  });

  it("parses JSON string encoded directory result", () => {
    const jsonStr = JSON.stringify({
      path: "c:/HermOS IDE/src",
      entries: [
        { name: "app", type: "dir" },
        { name: "components", type: "dir" },
        { name: "index.ts", type: "file" },
      ],
    });
    const parsed = parseDirectoryResult(jsonStr);
    expect(parsed).not.toBeNull();
    expect(parsed?.basePath).toBe("c:/HermOS IDE/src");
    expect(parsed?.entries.length).toBe(3);
  });

  it("returns null for non-directory results", () => {
    expect(parseDirectoryResult(null)).toBeNull();
    expect(parseDirectoryResult(undefined)).toBeNull();
    expect(parseDirectoryResult({ someKey: "value" })).toBeNull();
  });
});

describe("parseGlobResult", () => {
  it("parses object with matches and pattern", () => {
    const raw = {
      matches: ["src/app/page.tsx", "src/app/layout.tsx"],
      pattern: "**/*.tsx",
      path: "src/app",
    };
    const parsed = parseGlobResult(raw);
    expect(parsed).not.toBeNull();
    expect(parsed?.matches).toEqual(["src/app/page.tsx", "src/app/layout.tsx"]);
    expect(parsed?.pattern).toBe("**/*.tsx");
    expect(parsed?.basePath).toBe("src/app");
  });

  it("parses plain array of match paths", () => {
    const raw = ["fileA.ts", "fileB.ts"];
    const parsed = parseGlobResult(raw, { pattern: "*.ts" });
    expect(parsed).not.toBeNull();
    expect(parsed?.matches).toEqual(["fileA.ts", "fileB.ts"]);
    expect(parsed?.pattern).toBe("*.ts");
  });
});

describe("parseGrepResult", () => {
  it("parses grep matches with file, line, text", () => {
    const raw = {
      matches: [
        { file: "src/app/page.tsx", line: 12, text: "export default function Page()" },
        { file: "src/app/layout.tsx", line: 45, text: "export default function RootLayout()" },
      ],
      pattern: "export default function",
    };
    const parsed = parseGrepResult(raw);
    expect(parsed).not.toBeNull();
    expect(parsed?.matches.length).toBe(2);
    expect(parsed?.matches[0].file).toBe("src/app/page.tsx");
    expect(parsed?.matches[0].line).toBe(12);
    expect(parsed?.pattern).toBe("export default function");
  });

  it("parses Antigravity / ripgrep JSON output format", () => {
    const raw = [
      { Filename: "src/lib/utils.ts", LineNumber: 5, LineContent: "export function cn(...inputs)" },
    ];
    const parsed = parseGrepResult(raw, { Query: "export function cn" });
    expect(parsed).not.toBeNull();
    expect(parsed?.matches.length).toBe(1);
    expect(parsed?.matches[0].file).toBe("src/lib/utils.ts");
    expect(parsed?.matches[0].line).toBe(5);
    expect(parsed?.matches[0].text).toBe("export function cn(...inputs)");
    expect(parsed?.pattern).toBe("export function cn");
  });
});

describe("parseWebSearchResult", () => {
  it("parses web search results with title, url, and snippet", () => {
    const raw = {
      query: "HermOS IDE Next.js",
      results: [
        {
          title: "HermOS IDE Documentation",
          url: "https://hermos.dev/docs",
          snippet: "An AI-powered full-stack IDE platform built on Next.js.",
        },
      ],
    };
    const parsed = parseWebSearchResult(raw);
    expect(parsed).not.toBeNull();
    expect(parsed?.query).toBe("HermOS IDE Next.js");
    expect(parsed?.results.length).toBe(1);
    expect(parsed?.results[0].title).toBe("HermOS IDE Documentation");
    expect(parsed?.results[0].url).toBe("https://hermos.dev/docs");
  });
});

describe("parseHttpFetchResult", () => {
  it("parses HTTP fetch response with url, status, and text", () => {
    const raw = {
      url: "https://api.github.com/repos/hermos/ide",
      status: 200,
      text: '{"name": "ide", "stars": 120}',
    };
    const parsed = parseHttpFetchResult(raw);
    expect(parsed).not.toBeNull();
    expect(parsed?.url).toBe("https://api.github.com/repos/hermos/ide");
    expect(parsed?.status).toBe(200);
    expect(parsed?.text).toContain('"name": "ide"');
  });
});

describe("extractFilePath", () => {
  it("extracts path from various argument keys", () => {
    expect(extractFilePath({ path: "src/index.ts" })).toBe("src/index.ts");
    expect(extractFilePath({ DirectoryPath: "src/components" })).toBe("src/components");
    expect(extractFilePath({ TargetFile: "src/lib/db.ts" })).toBe("src/lib/db.ts");
    expect(extractFilePath({ AbsolutePath: "c:/app/file.tsx" })).toBe("c:/app/file.tsx");
    expect(extractFilePath({ file: "readme.md" })).toBe("readme.md");
    expect(extractFilePath({})).toBeNull();
  });
});
