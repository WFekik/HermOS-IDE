"use client";

/**
 * Shared PrismLight highlighter — single source of truth for syntax highlighting.
 * Full `Prism` bundles ~280 languages; PrismLight registers the ~28 languages
 * this IDE actually edits/views (see REGISTERED_LANGUAGES, pinned by
 * src/lib/prism.test.ts). Add languages here only.
 */
import { PrismLight as SyntaxHighlighter } from "react-syntax-highlighter";
import ts from "react-syntax-highlighter/dist/esm/languages/prism/typescript";
import tsx from "react-syntax-highlighter/dist/esm/languages/prism/tsx";
import js from "react-syntax-highlighter/dist/esm/languages/prism/javascript";
import jsx from "react-syntax-highlighter/dist/esm/languages/prism/jsx";
import bash from "react-syntax-highlighter/dist/esm/languages/prism/bash";
import json from "react-syntax-highlighter/dist/esm/languages/prism/json";
import markdown from "react-syntax-highlighter/dist/esm/languages/prism/markdown";
import python from "react-syntax-highlighter/dist/esm/languages/prism/python";
import yaml from "react-syntax-highlighter/dist/esm/languages/prism/yaml";
import css from "react-syntax-highlighter/dist/esm/languages/prism/css";
import markup from "react-syntax-highlighter/dist/esm/languages/prism/markup";
import rust from "react-syntax-highlighter/dist/esm/languages/prism/rust";
import go from "react-syntax-highlighter/dist/esm/languages/prism/go";
import java from "react-syntax-highlighter/dist/esm/languages/prism/java";
import c from "react-syntax-highlighter/dist/esm/languages/prism/c";
import cpp from "react-syntax-highlighter/dist/esm/languages/prism/cpp";
import csharp from "react-syntax-highlighter/dist/esm/languages/prism/csharp";
import php from "react-syntax-highlighter/dist/esm/languages/prism/php";
import ruby from "react-syntax-highlighter/dist/esm/languages/prism/ruby";
import swift from "react-syntax-highlighter/dist/esm/languages/prism/swift";
import kotlin from "react-syntax-highlighter/dist/esm/languages/prism/kotlin";
import toml from "react-syntax-highlighter/dist/esm/languages/prism/toml";
import docker from "react-syntax-highlighter/dist/esm/languages/prism/docker";
import sql from "react-syntax-highlighter/dist/esm/languages/prism/sql";
import powershell from "react-syntax-highlighter/dist/esm/languages/prism/powershell";
import ini from "react-syntax-highlighter/dist/esm/languages/prism/ini";
import lua from "react-syntax-highlighter/dist/esm/languages/prism/lua";
import batch from "react-syntax-highlighter/dist/esm/languages/prism/batch";

SyntaxHighlighter.registerLanguage("typescript", ts);
SyntaxHighlighter.registerLanguage("tsx", tsx);
SyntaxHighlighter.registerLanguage("javascript", js);
SyntaxHighlighter.registerLanguage("jsx", jsx);
SyntaxHighlighter.registerLanguage("bash", bash);
SyntaxHighlighter.registerLanguage("json", json);
SyntaxHighlighter.registerLanguage("markdown", markdown);
SyntaxHighlighter.registerLanguage("python", python);
SyntaxHighlighter.registerLanguage("yaml", yaml);
SyntaxHighlighter.registerLanguage("css", css);
SyntaxHighlighter.registerLanguage("markup", markup);
SyntaxHighlighter.registerLanguage("rust", rust);
SyntaxHighlighter.registerLanguage("go", go);
SyntaxHighlighter.registerLanguage("java", java);
SyntaxHighlighter.registerLanguage("c", c);
SyntaxHighlighter.registerLanguage("cpp", cpp);
SyntaxHighlighter.registerLanguage("csharp", csharp);
SyntaxHighlighter.registerLanguage("php", php);
SyntaxHighlighter.registerLanguage("ruby", ruby);
SyntaxHighlighter.registerLanguage("swift", swift);
SyntaxHighlighter.registerLanguage("kotlin", kotlin);
SyntaxHighlighter.registerLanguage("toml", toml);
SyntaxHighlighter.registerLanguage("docker", docker);
SyntaxHighlighter.registerLanguage("sql", sql);
SyntaxHighlighter.registerLanguage("powershell", powershell);
SyntaxHighlighter.registerLanguage("ini", ini);
SyntaxHighlighter.registerLanguage("lua", lua);
SyntaxHighlighter.registerLanguage("batch", batch);

/** Every language PrismLight knows (registration above). Pinned by prism.test.ts. */
export const REGISTERED_LANGUAGES = [
  "typescript", "tsx", "javascript", "jsx", "bash", "batch", "json", "markdown",
  "python", "yaml", "css", "markup", "rust", "go", "java", "c", "cpp",
  "csharp", "php", "ruby", "swift", "kotlin", "toml", "docker", "sql",
  "powershell", "ini", "lua",
] as const;

const ALIASES: Record<string, string> = {
  ts: "typescript",
  js: "javascript",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  yml: "yaml",
  md: "markdown",
  html: "markup",
  xml: "markup",
  h: "c",
  hpp: "cpp",
  "c++": "cpp",
  "c#": "csharp",
  cs: "csharp",
  ps1: "powershell",
  pwsh: "powershell",
  cmd: "batch",
  bat: "batch",
  dockerfile: "docker",
  containerfile: "docker",
  text: "text",
  tree: "text",
};

/** Normalize arbitrary language tags to a registered PrismLight language. Unknown → text (plain, never crashes). */
export function normalizePrismLanguage(raw: string | undefined): string {
  const lang = (raw || "text").toLowerCase().trim();
  if (ALIASES[lang]) return ALIASES[lang];
  if ((REGISTERED_LANGUAGES as readonly string[]).includes(lang)) return lang;
  return "text";
}

export { SyntaxHighlighter };
export { oneDark, oneLight } from "react-syntax-highlighter/dist/esm/styles/prism";
