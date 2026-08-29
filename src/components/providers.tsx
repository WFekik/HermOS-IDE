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

    const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
    if (isTauri) {
      import("@/lib/updater")
        .then(({ checkForUpdates }) => {
          updaterTimeout = setTimeout(() => {
            checkForUpdates().then((result) => {
              if (result.status === "error") {
                // Make updater failures visible instead of silently swallowing them.
                toast.error(`Updates unavailable: ${result.message}`, {
                  duration: 8000,
                });
              }
            });
          }, 5000);
        })
        .catch(console.error);
    }

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

