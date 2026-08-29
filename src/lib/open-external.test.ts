// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isAllowedUrlScheme, openExternalUrl, setupGlobalLinkInterceptor } from "./open-external";

describe("open-external", () => {
  describe("isAllowedUrlScheme", () => {
    it("allows valid http and https URLs", () => {
      expect(isAllowedUrlScheme("http://example.com")).toBe(true);
      expect(isAllowedUrlScheme("https://github.com/WFekik/HermOS-IDE")).toBe(true);
      expect(isAllowedUrlScheme("HTTPS://GITHUB.COM")).toBe(true);
    });

    it("allows mailto links", () => {
      expect(isAllowedUrlScheme("mailto:support@hermos.ai")).toBe(true);
    });

    it("rejects javascript:, data:, file:, and other unsafe schemes", () => {
      expect(isAllowedUrlScheme("javascript:alert(1)")).toBe(false);
      expect(isAllowedUrlScheme("data:text/html,<script>alert(1)</script>")).toBe(false);
      expect(isAllowedUrlScheme("file:///etc/passwd")).toBe(false);
      expect(isAllowedUrlScheme("vbscript:msgbox(1)")).toBe(false);
      expect(isAllowedUrlScheme("")).toBe(false);
    });
  });

  describe("openExternalUrl", () => {
    let originalWindowOpen: typeof window.open;

    beforeEach(() => {
      originalWindowOpen = window.open;
      window.open = vi.fn().mockReturnValue({ opener: null });
    });

    afterEach(() => {
      window.open = originalWindowOpen;
      vi.restoreAllMocks();
    });

    it("opens valid web URLs via window.open in web mode", async () => {
      const result = await openExternalUrl("https://example.com");
      expect(result).toBe(true);
      expect(window.open).toHaveBeenCalledWith(
        "https://example.com",
        "_blank",
        "noopener,noreferrer"
      );
    });

    it("blocks malicious or disallowed schemes", async () => {
      const result = await openExternalUrl("javascript:evil()");
      expect(result).toBe(false);
      expect(window.open).not.toHaveBeenCalled();
    });
  });

  describe("setupGlobalLinkInterceptor", () => {
    let cleanup: () => void;

    afterEach(() => {
      cleanup?.();
    });

    it("installs and cleans up event listener without errors", () => {
      cleanup = setupGlobalLinkInterceptor();
      expect(typeof cleanup).toBe("function");
    });
  });
});
