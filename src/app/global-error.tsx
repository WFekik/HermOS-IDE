"use client";

import * as React from "react";

/**
 * Global error boundary that replaces the root layout when an error escapes
 * the <App> tree (Next.js docs: global-error.tsx). It must contain its own
 * <html> and <body> tags, and must stay dependency-free — no providers, no
 * styling framework imports, no context reads — so it renders even if the
 * styling/app shell itself threw. `reset()` re-renders the subtree.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const attemptsRef = React.useRef(0);
  React.useEffect(() => {
    console.error("[Global Error Boundary]:", error);
  }, [error]);

  const handleReset = React.useCallback(() => {
    attemptsRef.current += 1;
    if (attemptsRef.current > 3) {
      window.location.reload();
      return;
    }
    reset();
  }, [reset]);

  return (
    <html lang="en">
      <body style={{ margin: 0, backgroundColor: "var(--background, #ffffff)", color: "var(--foreground, #09090b)", colorScheme: "light dark" }}>
        <div
          style={{
            minHeight: "100vh",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "24px",
            fontFamily:
              "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
          }}
        >
          <div
            style={{
              maxWidth: "480px",
              width: "100%",
              borderRadius: "12px",
              border: "1px solid var(--border, #e4e4e7)",
              backgroundColor: "var(--card, #ffffff)",
              padding: "28px",
              textAlign: "center",
            }}
          >
            <div style={{ display: "flex", justifyContent: "center", marginBottom: "12px" }}>
              <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
                <path d="M12 9v4" />
                <path d="M12 17h.01" />
              </svg>
            </div>
            <h1
              style={{
                fontSize: "17px",
                fontWeight: 600,
                margin: "0 0 8px",
                letterSpacing: "-0.01em",
              }}
            >
              Something went wrong
            </h1>
            <p
              style={{
                fontSize: "13px",
                lineHeight: 1.6,
                color: "var(--muted-foreground, #71717a)",
                margin: "0 0 16px",
              }}
            >
              An unrecoverable application error occurred. You can try to
              recover by clicking the button below, or reload HermOS to start
              fresh.
            </p>
            {error?.digest ? (
              <p
                style={{
                  fontSize: "11px",
                  fontFamily:
                    "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace",
                  color: "var(--muted-foreground, #71717a)",
                  margin: "0 0 16px",
                }}
              >
                Error digest: {error.digest}
              </p>
            ) : null}
            <div style={{ display: "flex", gap: "8px", justifyContent: "center" }}>
              <button
                type="button"
                onClick={handleReset}
                style={{
                  border: "1px solid var(--border, #d4d4d8)",
                  backgroundColor: "var(--primary, #18181b)",
                  color: "var(--primary-foreground, #fafafa)",
                  borderRadius: "8px",
                  padding: "8px 14px",
                  fontSize: "13px",
                  fontWeight: 500,
                  cursor: "pointer",
                }}
              >
                Try again
              </button>
              <button
                type="button"
                onClick={() => window.location.reload()}
                style={{
                  border: "1px solid var(--border, #d4d4d8)",
                  backgroundColor: "transparent",
                  color: "inherit",
                  borderRadius: "8px",
                  padding: "8px 14px",
                  fontSize: "13px",
                  fontWeight: 500,
                  cursor: "pointer",
                }}
              >
                Reload application
              </button>
            </div>
          </div>
        </div>
      </body>
    </html>
  );
}