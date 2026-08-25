// Tauri v2 API wrappers for frontend

import { invoke } from "@tauri-apps/api/core";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: Record<string, unknown>;
  }
}

/**
 * Check if running in Tauri v2 desktop app
 */
export function isTauri(): boolean {
  return typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;
}

/**
 * Open a native folder picker and return the selected path.
 * The frontend should then call the API to create/open the workspace.
 * Returns the selected folder path on success, null if cancelled or error.
 */
export async function pickFolder(): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    const result = await invoke<string | null>("plugin:dialog|open", {
      options: { directory: true, multiple: false, title: "Select a folder to open as workspace" },
    });
    if (result) return result;
  } catch {
    // fallback to custom pick_folder command
  }
  try {
    return await invoke<string | null>("pick_folder");
  } catch {
    return null;
  }
}

/**
 * Fetch the absolute filesystem path for a workspace via the backend API.
 * Returns the rootDir string, or null on failure.
 */
export async function getWorkspaceRoot(workspaceId: string): Promise<string | null> {
  try {
    const res = await fetch("/api/workspace", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "root", workspaceId }),
    });
    const data = await res.json();
    if (data.ok && data.rootDir) return data.rootDir as string;
    return null;
  } catch {
    return null;
  }
}
