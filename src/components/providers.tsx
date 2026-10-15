"use client";

import * as React from "react";
import { ThemeProvider } from "@/components/theme/theme-provider";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppearanceApplier } from "@/components/appearance-applier";
import { toast } from "sonner";

import { setupGlobalLinkInterceptor } from "@/lib/open-external";
import { useUpdateStore } from "@/stores/update-store";
import { useAppStore } from "@/stores/app-store";

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

  // Apply persisted appearance prefs before paint. The store initializes
  // with compiled defaults (matching SSR) so hydration never mismatches;
  // stored values land here synchronously — no flash of default width/theme.
  React.useLayoutEffect(() => {
    useAppStore.getState().hydrateAppearance();
  }, []);

  React.useEffect(() => {
    // Install global click interceptor for all external links across the app
    const cleanupLinks = setupGlobalLinkInterceptor();
    let updaterTimeout: ReturnType<typeof setTimeout> | undefined;
    let idleHandle: number | undefined;

    import("@/lib/updater")
      .then(({ checkForUpdates, consumeStaleUpdate, clearPendingUpdate, releaseTagUrl }) => {
        // Verify-on-launch: if a previous update was staged but we are still
        // on the old version, the installer did not apply — say so loudly
        // with retry + manual fallback instead of failing silently again.
        // (Error notice stays a pinned toast; the *available* prompt lives
        // in the persistent titlebar button instead.)
        try {
          const stale = consumeStaleUpdate();
          if (stale) {
            import("@/lib/open-external").then(({ openExternalUrl }) => {
              import("@/lib/i18n").then(({ t, SUPPORTED_LANGUAGE_CODES, LANGUAGE_STORAGE_KEY }) => {
                let lang = "en";
                try {
                  const raw = window.localStorage.getItem(LANGUAGE_STORAGE_KEY as string);
                  if (raw && (SUPPORTED_LANGUAGE_CODES as readonly string[]).includes(raw)) lang = raw;
                } catch { /* fallback */ }
                toast.warning((t as (k: string, l: string, p?: Record<string, string | number>) => string)("update_didnt_apply", lang, { version: stale.to }), {
                  id: "app-update-stale",
                  duration: Infinity,
                  description: (t as (k: string, l: string) => string)("update_didnt_apply_desc", lang),
                  action: {
                    label: (t as (k: string, l: string) => string)("update_retry_update", lang),
                    onClick: () => {
                      clearPendingUpdate();
                      // Desktop auto-install toasts internally and can throw;
                      // never leave an unhandled rejection from a click handler.
                      checkForUpdates(true).catch(() => {});
                    },
                  },
                  cancel: {
                    label: (t as (k: string, l: string) => string)("update_install_manually", lang),
                    onClick: () => {
                      clearPendingUpdate();
                      void openExternalUrl(releaseTagUrl(stale.to));
                    },
                  },
                });
              }).catch(() => {});
            }).catch(() => {});
          }
        } catch {
          /* boot notice is best-effort */
        }
        // Deferred well past hydrate: the update check (dynamic import +
        // network) must never compete with first paint on a cold boot.
        // An available update goes to the persistent titlebar button
        // (update-store) — no auto-dismiss toast, the user decides.
        updaterTimeout = setTimeout(() => {
          const run = () =>
            checkForUpdates(false).then((result) => {
              if (result.status === "available") {
                useUpdateStore.getState().markAvailable({
                  currentVersion: result.currentVersion,
                  latestVersion: result.latestVersion,
                  releaseName: result.releaseName,
                  releaseNotes: result.releaseNotes,
                  releaseUrl: result.releaseUrl,
                });
              }
            }).catch(() => {});
          if (
            typeof window !== "undefined" &&
            typeof (window as unknown as { requestIdleCallback?: unknown }).requestIdleCallback === "function"
          ) {
            idleHandle = window.requestIdleCallback(() => void run(), { timeout: 5000 });
          } else {
            void run();
          }
        }, 8000);
      })
      .catch(console.error);

    return () => {
      cleanupLinks();
      if (updaterTimeout) clearTimeout(updaterTimeout);
      if (idleHandle !== undefined) {
        try {
          window.cancelIdleCallback(idleHandle);
        } catch {
          /* older browsers without cancelIdleCallback */
        }
      }
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

