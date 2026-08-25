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
  React.useEffect(() => {
    console.error("[Global Error Boundary]:", error);
  }, [error]);

  return (
    <html lang="en">
      <body style={{ margin: 0, backgroundColor: "#09090b", color: "#fafafa" }}>
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
              border: "1px solid #27272a",
              backgroundColor: "#18181b",
              padding: "28px",
              textAlign: "center",
            }}
          >
            <div style={{ fontSize: "36px", lineHeight: 1, marginBottom: "12px" }}>
              ⚠️
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
                color: "#a1a1aa",
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
                  color: "#71717a",
                  margin: "0 0 16px",
                }}
              >
                Error digest: {error.digest}
              </p>
            ) : null}
            <div style={{ display: "flex", gap: "8px", justifyContent: "center" }}>
              <button
                type="button"
                onClick={reset}
                style={{
                  border: "1px solid #3f3f46",
                  backgroundColor: "#fafafa",
                  color: "#09090b",
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
                  border: "1px solid #3f3f46",
                  backgroundColor: "transparent",
                  color: "#fafafa",
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