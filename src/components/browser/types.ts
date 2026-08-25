"use client";

import { apiGet, apiPost, ApiRequestError } from "@/lib/api-client";

/* ------------------------------------------------------------------ *
 * Browser panel — shared types, query keys, and typed API helpers.
 *
 * The backend exposes a Playwright-backed session at
 * /api/browser/*. The panel keeps server state in React Query (snapshot,
 * session) and local state for the URL input + selected ref.
 * ------------------------------------------------------------------ */

export interface BrowserSession {
  id: string;
  url: string;
  title: string;
  createdAt: number;
}

export interface BrowserOpenResponse {
  session: BrowserSession;
  title?: string;
  snapshot: string;
}

export interface BrowserSnapshotResponse {
  snapshot: string;
}

export interface BrowserActionResponse {
  ok: boolean;
  snapshot: string;
}

export interface BrowserScreenshotResponse {
  dataUrl: string;
}

export interface BrowserExtractResponse {
  text: string;
}

export interface BrowserSessionResponse {
  session: BrowserSession | null;
}

export interface BrowserCloseResponse {
  ok: boolean;
}

export type ScrollDirection = "up" | "down" | "left" | "right";

export const browserKeys = {
  all: ["browser"] as const,
  session: ["browser", "session"] as const,
  snapshot: ["browser", "snapshot"] as const,
} as const;

/* ----------------------------- API helpers ----------------------------- */

export async function openBrowser(url: string): Promise<BrowserOpenResponse> {
  // Cold browser spawn can exceed the 30s default.
  return apiPost<BrowserOpenResponse>("/api/browser/open", { url }, { timeoutMs: 2 * 60_000 });
}

export async function fetchSnapshot(
  signal?: AbortSignal,
): Promise<BrowserSnapshotResponse> {
  return apiGet<BrowserSnapshotResponse>("/api/browser/snapshot", {
    signal,
    timeoutMs: 2 * 60_000,
  });
}

export async function clickElement(ref: string): Promise<BrowserActionResponse> {
  return apiPost<BrowserActionResponse>("/api/browser/click", { ref });
}

export async function typeIntoElement(
  ref: string,
  text: string,
): Promise<BrowserActionResponse> {
  return apiPost<BrowserActionResponse>("/api/browser/type", { ref, text });
}

export async function pressKey(key: string): Promise<BrowserActionResponse> {
  return apiPost<BrowserActionResponse>("/api/browser/press", { key });
}

export async function scrollBrowser(
  direction: ScrollDirection,
  px?: number,
): Promise<BrowserActionResponse> {
  return apiPost<BrowserActionResponse>("/api/browser/scroll", {
    direction,
    px,
  });
}

export async function fetchScreenshot(): Promise<BrowserScreenshotResponse> {
  // Screenshots of large pages can take a while.
  return apiGet<BrowserScreenshotResponse>("/api/browser/screenshot", { timeoutMs: 2 * 60_000 });
}

export async function extractText(): Promise<BrowserExtractResponse> {
  return apiGet<BrowserExtractResponse>("/api/browser/extract");
}

export async function fetchSession(
  signal?: AbortSignal,
): Promise<BrowserSessionResponse> {
  return apiGet<BrowserSessionResponse>("/api/browser/session", { signal });
}

export async function closeBrowser(): Promise<BrowserCloseResponse> {
  return apiPost<BrowserCloseResponse>("/api/browser/close", {});
}

/* ----------------------------- URL helpers ----------------------------- */

/**
 * Normalize a user-entered string into a URL the backend can open. If the
 * input looks like a URL (has a scheme or a dot in the host), prepend
 * https:// when missing. Otherwise treat it as a search query.
 */
export function normalizeBrowserUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  // Already has a scheme.
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  // Looks like a domain (something.tld with no spaces).
  if (/^[^\s]+\.[^\s]{2,}(\/[^\s]*)?$/.test(trimmed)) {
    return `https://${trimmed}`;
  }
  // Treat as a search query.
  return `https://duckduckgo.com/?q=${encodeURIComponent(trimmed)}`;
}

/* --------------------------- Snapshot parsing --------------------------- */

/**
 * A single line in the accessibility-tree snapshot. Lines starting with
 * `@eN` are interactive refs; everything else is plain context.
 */
export interface SnapshotLine {
  ref?: string; // @eN
  indent: number; // leading spaces / 2
  raw: string; // original line (trimmed of indent)
  body: string; // raw without the @eN token
  role?: string; // [role] in brackets
  label?: string; // quoted text or name=...
}

const REF_RE = /^(@e\d+)\s*(.*)$/;
const ROLE_RE = /\[([^\]]+)\]/;
const QUOTED_RE = /"([^"]*)"/;
const NAME_EQ_RE = /\bname="([^"]*)"/;
const PLACEHOLDER_RE = /\bplaceholder="([^"]*)"/;

export function parseSnapshot(text: string | undefined | null): SnapshotLine[] {
  if (!text) return [];
  return text.split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return [];
    // Indent count: 2 spaces = 1 level (matches Playwright's default format).
    const indentMatch = line.match(/^( *)/);
    const spaces = indentMatch ? indentMatch[1].length : 0;
    const indent = Math.floor(spaces / 2);
    const content = line.slice(spaces);
    const refMatch = content.match(REF_RE);
    if (!refMatch) {
      return [{ indent, raw: content, body: content } as SnapshotLine];
    }
    const ref = refMatch[1];
    const body = refMatch[2] ?? "";
    const roleMatch = body.match(ROLE_RE);
    const quoted = body.match(QUOTED_RE);
    const nameEq = body.match(NAME_EQ_RE);
    const placeholder = body.match(PLACEHOLDER_RE);
    return [
      {
        ref,
        indent,
        raw: content,
        body,
        role: roleMatch?.[1],
        label:
          quoted?.[1] ?? nameEq?.[1] ?? placeholder?.[1] ?? undefined,
      } as SnapshotLine,
    ];
  });
}

/* ------------------------------- Keys ---------------------------------- */

export const PRESSABLE_KEYS: { value: string; label: string }[] = [
  { value: "Enter", label: "Enter" },
  { value: "Tab", label: "Tab" },
  { value: "Escape", label: "Escape" },
  { value: "Backspace", label: "Backspace" },
  { value: "ArrowUp", label: "Arrow Up" },
  { value: "ArrowDown", label: "Arrow Down" },
  { value: "ArrowLeft", label: "Arrow Left" },
  { value: "ArrowRight", label: "Arrow Right" },
];

/* ------------------------------ Helpers -------------------------------- */

export function isApiError(e: unknown): e is ApiRequestError {
  return e instanceof ApiRequestError;
}

export function toErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
