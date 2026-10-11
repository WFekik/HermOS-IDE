"use client";

import { create } from "zustand";

export type UpdateUiStatus =
  | "idle"
  | "available"
  | "downloading"
  | "installing"
  | "ready-restart"
  | "failed";

export interface AvailableUpdateInfo {
  currentVersion: string;
  latestVersion: string;
  releaseName?: string;
  releaseNotes?: string;
  releaseUrl?: string;
}

interface UpdateUiState {
  status: UpdateUiStatus;
  currentVersion: string;
  latestVersion: string;
  releaseName?: string;
  releaseNotes?: string;
  releaseUrl?: string;
  downloadedBytes: number;
  totalBytes: number;
  error: string | null;
  /** Version the user explicitly deferred ("Not now") — never re-prompt it. */
  dismissedVersion: string | null;
  markAvailable: (info: AvailableUpdateInfo) => void;
  markDownloading: (downloadedBytes: number, totalBytes: number) => void;
  markInstalling: () => void;
  markReadyRestart: () => void;
  markFailed: (error: string) => void;
  dismiss: () => void;
  reset: () => void;
}

const initial: Pick<
  UpdateUiState,
  | "status"
  | "currentVersion"
  | "latestVersion"
  | "downloadedBytes"
  | "totalBytes"
  | "error"
  | "dismissedVersion"
> = {
  status: "idle",
  currentVersion: "",
  latestVersion: "",
  downloadedBytes: 0,
  totalBytes: 0,
  error: null,
  dismissedVersion: null,
};

/**
 * Persistent update UI state. Unlike the old auto-dismiss toast, this state
 * survives until the user acts: the titlebar download button reads it and
 * stays visible (with tooltip "Update to v{version}") across renders.
 * Downloading/installing progress, ready-restart, and failure all render
 * from here — nothing disappears on a timer.
 */
export const useUpdateStore = create<UpdateUiState>()((set) => ({
  ...initial,
  releaseName: undefined,
  releaseNotes: undefined,
  releaseUrl: undefined,

  markAvailable: (info) =>
    set((s) => {
      // A brand-new version clears a previous dismissal/failure.
      if (info.latestVersion !== s.latestVersion) {
        return {
          ...info,
          status: "available",
          downloadedBytes: 0,
          totalBytes: 0,
          error: null,
          dismissedVersion: null,
        };
      }
      return { ...info, status: "available", error: null };
    }),

  markDownloading: (downloadedBytes, totalBytes) =>
    set({ status: "downloading", downloadedBytes, totalBytes, error: null }),

  markInstalling: () => set({ status: "installing", error: null }),

  markReadyRestart: () => set({ status: "ready-restart", error: null }),

  markFailed: (error) => set({ status: "failed", error }),

  dismiss: () =>
    set((s) => ({
      status: "idle",
      dismissedVersion: s.latestVersion || s.dismissedVersion,
      error: null,
    })),

  reset: () => set({ ...initial, releaseName: undefined, releaseNotes: undefined, releaseUrl: undefined }),
}));

/** True when the titlebar update affordance should be visible. */
export function shouldShowUpdateButton(s: UpdateUiState): boolean {
  if (s.status === "idle") return false;
  if (s.status === "available" && s.dismissedVersion === s.latestVersion) return false;
  return true;
}
