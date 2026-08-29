/**
 * Universal external URL opener for HermOS IDE.
 * Works seamlessly in both Tauri desktop mode (opening OS default browser)
 * and web browser mode (window.open with noopener/noreferrer).
 */

export function isAllowedUrlScheme(url: string): boolean {
  if (!url || typeof url !== "string") return false;
  const trimmed = url.trim().toLowerCase();
  return (
    trimmed.startsWith("http://") ||
    trimmed.startsWith("https://") ||
    trimmed.startsWith("mailto:")
  );
}

/**
 * Safely opens an external URL in the user's default system browser.
 */
export async function openExternalUrl(rawUrl: string): Promise<boolean> {
  if (!rawUrl || typeof rawUrl !== "string") return false;
  const trimmed = rawUrl.trim();
  if (!isAllowedUrlScheme(trimmed)) {
    console.warn("[openExternalUrl] Blocked non-http/https URL scheme:", rawUrl);
    return false;
  }

  const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

  if (isTauri) {
    try {
      const res = await fetch("/api/system/open-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: trimmed }),
      });
      if (res.ok) {
        return true;
      }
    } catch (e) {
      console.warn("[openExternalUrl] API open failed, falling back to window.open", e);
    }
  }

  // Web mode or fallback
  try {
    const win = window.open(trimmed, "_blank", "noopener,noreferrer");
    if (win) {
      win.opener = null;
      return true;
    }
  } catch (e) {
    console.error("[openExternalUrl] window.open failed", e);
  }
  return false;
}

/**
 * Installs a global capturing click listener on the document.
 * Any click on an <a> element with an external URL (http/https/mailto)
 * is intercepted and opened in the OS browser.
 */
export function setupGlobalLinkInterceptor(): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return () => {};
  }

  const handleDocumentClick = (e: MouseEvent) => {
    // Only intercept primary left clicks without modifier keys (e.g. Ctrl+Click)
    if (e.button !== 0 || e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) {
      return;
    }

    const target = e.target as HTMLElement | null;
    if (!target) return;

    const anchor = target.closest("a") as HTMLAnchorElement | null;
    if (!anchor) return;

    const href = anchor.getAttribute("href");
    if (!href) return;

    const lower = href.trim().toLowerCase();

    // Check if it's an external web link
    if (lower.startsWith("http://") || lower.startsWith("https://") || lower.startsWith("mailto:")) {
      e.preventDefault();
      e.stopPropagation();
      void openExternalUrl(href);
    }
  };

  document.addEventListener("click", handleDocumentClick, { capture: true });
  return () => {
    document.removeEventListener("click", handleDocumentClick, { capture: true });
  };
}
