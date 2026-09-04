"use client";

import * as React from "react";
import { ThemeProvider } from "@/components/theme/theme-provider";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppearanceApplier } from "@/components/appearance-applier";
import { toast } from "sonner";

import { setupGlobalLinkInterceptor } from "@/lib/open-external";

export function Providers({ children }: { children: React.ReactNode }) {
  // Single shared QueryClient for the whole app. Created once per browser
  // session so cache persists across navigations. Components that previously
  // created their own local client (workspace-panel, browser-panel) still
  // work — they just share this one via context.
  const [queryClient] = React.useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            retry: 3,
            retryDelay: (attempt) =>
              Math.min(1000 * 2 ** attempt, 8000),
            refetchOnWindowFocus: false,
            refetchOnReconnect: true,
            networkMode: "offlineFirst",
          },
          mutations: {
            retry: 0,
            networkMode: "offlineFirst",
          },
        },
      }),
  );

  React.useEffect(() => {
    // Install global click interceptor for all external links across the app
    const cleanupLinks = setupGlobalLinkInterceptor();
    let updaterTimeout: ReturnType<typeof setTimeout> | undefined;

    import("@/lib/updater")
      .then(({ checkForUpdates, consumeStaleUpdate, clearPendingUpdate, releaseTagUrl }) => {
        // Verify-on-launch: if a previous update was staged but we are still
        // on the old version, the installer did not apply — say so loudly
        // with retry + manual fallback instead of failing silently again.
        try {
          const stale = consumeStaleUpdate();
          if (stale) {
            import("@/lib/open-external").then(({ openExternalUrl }) => {
              toast.warning(`Update to v${stale.to} didn't apply.`, {
                id: "app-update-stale",
                duration: Infinity,
                description: "The installer was blocked or interrupted. Retry, or install manually.",
                action: {
                  label: "Retry update",
                  onClick: () => {
                    clearPendingUpdate();
                    checkForUpdates(true);
                  },
                },
                cancel: {
                  label: "Install manually",
                  onClick: () => {
                    clearPendingUpdate();
                    openExternalUrl(releaseTagUrl(stale.to));
                  },
                },
              });
            }).catch(() => {});
          }
        } catch {
          /* boot notice is best-effort */
        }
        updaterTimeout = setTimeout(() => {
          checkForUpdates(false).then((result) => {
            if (result.status === "available") {
              toast.info(`HermOS IDE v${result.latestVersion} is available!`, {
                id: "app-update-available",
                duration: 20000,
                action: {
                  label: result.releaseUrl ? "View Release" : "Update Now",
                  onClick: () => {
                    if (result.releaseUrl) {
                      import("@/lib/open-external").then(({ openExternalUrl }) => {
                        openExternalUrl(result.releaseUrl!);
                      });
                    } else {
                      checkForUpdates(true);
                    }
                  },
                },
              });
            }
          });
        }, 4000);
      })
      .catch(console.error);

    return () => {
      cleanupLinks();
      if (updaterTimeout) clearTimeout(updaterTimeout);
    };
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <AppearanceApplier />
        {children}
      </ThemeProvider>
    </QueryClientProvider>
  );
}

