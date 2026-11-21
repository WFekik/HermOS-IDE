import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isSafeMarkdownImageHref, preprocessContent, getEffectiveAttachments } from "@/components/ide/message-renderer";
import { readFileWs } from "@/lib/workspace";

const rootDir = path.resolve(__dirname, "..", "..");

describe("Git Diff Panel Horizontal Scrolling", () => {
  it("diff-row preserves whitespace-pre without wrapping and uses min-w-full w-max", () => {
    const diffRowFile = fs.readFileSync(path.join(rootDir, "src", "components", "ui", "diff-row.tsx"), "utf-8");
    expect(diffRowFile).toContain("whitespace-pre");
    expect(diffRowFile).toContain("min-w-full w-max");
    expect(diffRowFile).toContain("sticky left-0");
  });

  it("scroll-area includes horizontal scrollbar support", () => {
    const scrollAreaFile = fs.readFileSync(path.join(rootDir, "src", "components", "ui", "scroll-area.tsx"), "utf-8");
    expect(scrollAreaFile).toContain('orientation="horizontal"');
  });

  it("diff-viewer enables horizontal scrolling", () => {
    const diffViewerFile = fs.readFileSync(path.join(rootDir, "src", "components", "ide", "diff-viewer.tsx"), "utf-8");
    expect(diffViewerFile).toContain("overflow-x-auto");
  });

  it("git-diff-view configures full width expansion for file diffs", () => {
    const gitDiffFile = fs.readFileSync(path.join(rootDir, "src", "components", "ide", "git-diff-view.tsx"), "utf-8");
    expect(gitDiffFile).toContain("min-w-full w-max");
  });
});

describe("Chat Panel Real Image (PNG) Rendering", () => {
  it("isSafeMarkdownImageHref accepts Windows image paths and file URIs", () => {
    expect(isSafeMarkdownImageHref("C:/Users/Images/screenshot.png")).toBe("C:/Users/Images/screenshot.png");
    expect(isSafeMarkdownImageHref("file:///C:/Users/Images/diagram.png")).toBe("file:///C:/Users/Images/diagram.png");
    expect(isSafeMarkdownImageHref("data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==")).toBe("data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==");
  });

  it("isSafeMarkdownImageHref rejects non-image schemes and payloads", () => {
    expect(isSafeMarkdownImageHref("javascript:alert(1)")).toBeNull();
    expect(isSafeMarkdownImageHref("data:text/html;base64,PGI+aGk8L2I+")).toBeNull();
    expect(isSafeMarkdownImageHref("//evil.com/pixel.png")).toBeNull();
  });

  it("preprocessContent transforms standalone base64 data URLs into markdown images", () => {
    const rawDataUrl = "data:image/png;base64," + "A".repeat(50);
    const text = `Here is the generated output:\n${rawDataUrl}\nAll done.`;
    const processed = preprocessContent(text);
    expect(processed).toContain(`![Image](${rawDataUrl})`);
  });

  it("getEffectiveAttachments recovers inline image attachments from text", () => {
    const msg = {
      id: "m1",
      conversationId: "c1",
      role: "user" as const,
      content: 'Here is the bug [Attachment: image/png (C:/Users/screenshot.png)] please inspect.',
      createdAt: new Date().toISOString(),
    };
    const atts = getEffectiveAttachments(msg);
    expect(atts.length).toBe(1);
    expect(atts[0].path).toBe("C:/Users/screenshot.png");
    expect(atts[0].type).toBe("image/png");
  });

  it("getEffectiveAttachments extracts a clean mime type from data-URL placeholders", () => {
    const msg = {
      id: "m2",
      conversationId: "c1",
      role: "user" as const,
      content: "[Image: render.png (data:image/jpeg;base64,AAAA)]",
      createdAt: new Date().toISOString(),
    };
    const atts = getEffectiveAttachments(msg);
    expect(atts.length).toBe(1);
    expect(atts[0].type).toBe("image/jpeg");
  });

  it("getEffectiveAttachments skips placeholders with no resolvable path", () => {
    const msg = {
      id: "m3",
      conversationId: "c1",
      role: "user" as const,
      content: "[Image: diagram (data:image/png;base64,AAAA)]",
      createdAt: new Date().toISOString(),
    };
    expect(getEffectiveAttachments(msg).length).toBe(0);
  });

  it("readFileWs returns isImage and mimeType for image files without inlining bytes", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hermos-wsimg-"));
    // 1x1 transparent PNG buffer
    const pngBuffer = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
    fs.writeFileSync(path.join(tmpDir, "test-icon.png"), pngBuffer);
    try {
      const res = await readFileWs("system", "default", "test-icon.png", 1000000, tmpDir);
      expect(res.isImage).toBe(true);
      expect(res.mimeType).toBe("image/png");
      expect(res.content).toContain("[Image: test-icon.png");
      // Image bytes must never ride along in the result (they flow into
      // persisted tool-call JSON and API responses).
      expect(JSON.stringify(res)).not.toContain("base64");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
