import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "path";
import fs from "fs/promises";
import os from "os";
import {
  generatePpt,
  generateDoc,
  generatePdf,
  readOfficeManifest,
  extractOfficeText,
} from "./generator";
import { resolveOfficeTheme } from "./themes";

describe("Office Generator & Themes Test Suite", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hermos-office-test-"));
  });

  afterEach(async () => {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  describe("Themes", () => {
    it("resolves executive and legacy theme aliases correctly", () => {
      expect(resolveOfficeTheme("executive").name).toBe("Executive Navy");
      expect(resolveOfficeTheme("professional").name).toBe("Executive Navy");
      expect(resolveOfficeTheme("emerald").name).toBe("HermOS Emerald");
      expect(resolveOfficeTheme("modern").name).toBe("HermOS Emerald");
      expect(resolveOfficeTheme("charcoal").name).toBe("Charcoal & Gold");
      expect(resolveOfficeTheme("minimal").name).toBe("Charcoal & Gold");
      expect(resolveOfficeTheme("crimson").name).toBe("Modern Crimson");
      expect(resolveOfficeTheme("nordic").name).toBe("Nordic Frost");
      expect(resolveOfficeTheme("cyberpunk").name).toBe("Cyber Midnight");
      expect(resolveOfficeTheme("unknown-theme").name).toBe("Executive Navy");
    });
  });

  describe("Presentation Generation (.pptx)", () => {
    it("generates a rich multi-layout presentation and saves companion manifest", async () => {
      const pptPath = path.join(tmpDir, "deck.pptx");
      const result = await generatePpt({
        title: "HermOS Architecture Overview",
        subtitle: "Enterprise Autonomous Developer OS",
        theme: "emerald",
        author: "HermOS Team",
        outputPath: pptPath,
        slides: [
          {
            title: "HermOS Architecture Overview",
            subtitle: "Enterprise Autonomous Developer OS",
            layout: "title",
          },
          {
            title: "Core Capabilities & Metrics",
            subtitle: "Production performance numbers",
            layout: "cards",
            cards: [
              { title: "Tokens/sec", value: "140+", description: "Sub-second streaming latency", badge: "Live" },
              { title: "Test Suites", value: "89", description: "1,500+ unit & adversarial tests", badge: "Verified" },
              { title: "Memory", value: "-40%", description: "Batch cache eviction", badge: "Optimized" },
            ],
          },
          {
            title: "Component Comparison",
            layout: "split",
            columns: [
              { heading: "Standard IDE", bullets: ["Basic autocomplete", "Manual file search", "No subagents"] },
              { heading: "HermOS OS", bullets: ["Autonomous subagents", "Native Office Studio", "FullConfinement"] },
            ],
          },
          {
            title: "Implementation Roadmap",
            layout: "timeline",
            steps: [
              { step: "01", title: "Core Engine", description: "Sandbox confinement and workspace safety" },
              { step: "02", title: "Subagents", description: "Autonomous parallel execution" },
              { step: "03", title: "Office Studio", description: "Native presentations & documents" },
            ],
          },
          {
            title: "Benchmark Results",
            layout: "table",
            table: {
              headers: ["Feature", "Baseline", "HermOS 2.0", "Improvement"],
              rows: [
                ["Context Tokenizer", "57.48s", "24.97s", "2.3x Faster"],
                ["Office Rendering", "Manual", "Native Canvas", "10x Productivity"],
              ],
            },
          },
          {
            title: "Vision",
            layout: "quote",
            quote: {
              text: "Building the next generation of developer intelligence.",
              author: "Lead Architect",
              role: "HermOS Core",
            },
          },
          {
            title: "Summary & Next Steps",
            layout: "bullets",
            bullets: ["Ship Office Studio to production", "Collect user feedback", "Expand export formats"],
            notes: "Highlight the 2.3x speedup during presentation.",
          },
        ],
      });

      expect(result.slides).toBe(7);
      expect(result.manifest).toBeDefined();
      expect(result.manifest.title).toBe("HermOS Architecture Overview");
      expect(result.manifest.slides?.length).toBe(7);

      // Verify binary file exists
      const stat = await fs.stat(pptPath);
      expect(stat.size).toBeGreaterThan(5000);

      // Verify companion manifest exists and can be loaded
      const loadedManifest = await readOfficeManifest(pptPath);
      expect(loadedManifest).not.toBeNull();
      expect(loadedManifest?.theme).toBe("emerald");
      expect(loadedManifest?.slides?.[1].layout).toBe("cards");

      // Verify text extraction
      const extracted = await extractOfficeText(pptPath);
      expect(extracted.type).toBe("pptx");
      expect(extracted.text).toContain("HermOS Architecture Overview");
    });
  });

  describe("Word Document Generation (.docx)", () => {
    it("generates an executive Word document with cover, callouts, and tables", async () => {
      const docPath = path.join(tmpDir, "report.docx");
      const result = await generateDoc({
        title: "Q3 Engineering Assessment",
        subtitle: "Autonomous Agent Reliability & Performance",
        author: "DevOps Team",
        organization: "HermOS Technologies",
        theme: "executive",
        outputPath: docPath,
        sections: [
          {
            heading: "Executive Summary",
            subheading: "Key findings from Q3 testing",
            paragraphs: [
              "During Q3, we achieved complete test isolation and introduced the native Office Studio.",
              "All benchmarks surpassed the initial SLA goals by over 200%.",
            ],
            callout: {
              type: "tip",
              title: "Key Achievement",
              text: "Autonomous subagent execution now handles parallel tool invocation with zero race conditions.",
            },
            bullets: [
              "Zero security vulnerabilities reported in fuzz testing",
              "1,545 test cases passing across 89 suites",
            ],
          },
          {
            heading: "Performance Metrics",
            table: {
              headers: ["Subsystem", "Latency P50", "Latency P99"],
              rows: [
                ["Workspace Confinement", "0.2ms", "1.1ms"],
                ["Office Generator", "45ms", "120ms"],
              ],
            },
          },
        ],
      });

      expect(result.sections).toBe(2);
      expect(result.manifest.type).toBe("document");

      const stat = await fs.stat(docPath);
      expect(stat.size).toBeGreaterThan(3000);

      const loaded = await readOfficeManifest(docPath);
      expect(loaded?.title).toBe("Q3 Engineering Assessment");
      expect(loaded?.sections?.[0].callout?.title).toBe("Key Achievement");

      const extracted = await extractOfficeText(docPath);
      expect(extracted.type).toBe("docx");
      expect(extracted.text).toContain("Q3 Engineering Assessment");
    });
  });

  describe("PDF Document Generation (.pdf)", () => {
    it("generates a styled PDF report with banners and callouts", async () => {
      const pdfPath = path.join(tmpDir, "summary.pdf");
      const result = await generatePdf({
        title: "Security & Confinement Audit",
        subtitle: "Formal Verification Report",
        author: "Security Team",
        theme: "crimson",
        outputPath: pdfPath,
        sections: [
          {
            heading: "Audit Scope & Methodology",
            paragraphs: [
              "This report presents the findings of our adversarial security fuzzing across all file operations.",
            ],
            callout: {
              type: "info",
              text: "All paths are checked against symlink traversals and confined to the workspace root.",
            },
            bullets: [
              "SSRF proxy validation active",
              "Unbounded cache protection enforced",
            ],
          },
          {
            heading: "Vulnerability Summary",
            table: {
              headers: ["Category", "Assessed", "Findings"],
              rows: [
                ["Path Traversal", "117 tests", "0 vulnerabilities"],
                ["Command Injection", "45 tests", "0 vulnerabilities"],
              ],
            },
          },
        ],
      });

      expect(result.sections).toBe(2);
      expect(result.manifest.type).toBe("pdf");

      const stat = await fs.stat(pdfPath);
      expect(stat.size).toBeGreaterThan(2000);

      const loaded = await readOfficeManifest(pdfPath);
      expect(loaded?.title).toBe("Security & Confinement Audit");

      const extracted = await extractOfficeText(pdfPath);
      expect(extracted.type).toBe("pdf");
      expect(extracted.text).toContain("Security & Confinement Audit");
    });
  });
});
