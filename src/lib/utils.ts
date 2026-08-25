import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Safe JSON.parse — returns fallback (default undefined) on any parse failure. */
export function safeJsonParse<T = unknown>(str: string | null | undefined, fallback?: T): T | undefined {
  if (str == null) return fallback;
  try {
    return JSON.parse(str) as T;
  } catch {
    return fallback;
  }
}

/** Robustly parses incomplete or streaming JSON, completing missing quotes and braces. */
export function parsePartialJson(jsonStr: string): Record<string, any> {
  jsonStr = jsonStr.trim();
  if (!jsonStr) return {};

  try {
    return JSON.parse(jsonStr) as Record<string, any>;
  } catch {}

  let isInsideString = false;
  let isEscaped = false;
  const stack: ("object" | "array")[] = [];

  for (let i = 0; i < jsonStr.length; i++) {
    const char = jsonStr[i];
    if (isEscaped) {
      isEscaped = false;
      continue;
    }

    if (char === "\\") {
      isEscaped = true;
      continue;
    }

    if (char === '"') {
      isInsideString = !isInsideString;
      continue;
    }

    if (!isInsideString) {
      if (char === "{") {
        stack.push("object");
      } else if (char === "[") {
        stack.push("array");
      } else if (char === "}") {
        if (stack[stack.length - 1] === "object") {
          stack.pop();
        }
      } else if (char === "]") {
        if (stack[stack.length - 1] === "array") {
          stack.pop();
        }
      }
    }
  }

  let fixedJsonStr = jsonStr;
  if (isInsideString) {
    if (isEscaped) {
      fixedJsonStr = fixedJsonStr.slice(0, -1);
    }
    fixedJsonStr += '"';
  }

  let cleaned = fixedJsonStr.trim();
  while (
    cleaned.endsWith(",") ||
    cleaned.endsWith(":") ||
    (cleaned.endsWith("[") && stack[stack.length - 1] === "array") ||
    (cleaned.endsWith("{") && stack[stack.length - 1] === "object")
  ) {
    if (cleaned.endsWith(",") || cleaned.endsWith(":")) {
      cleaned = cleaned.slice(0, -1).trim();
    } else if (cleaned.endsWith("[")) {
      cleaned = cleaned.slice(0, -1).trim();
      stack.pop();
    } else if (cleaned.endsWith("{")) {
      cleaned = cleaned.slice(0, -1).trim();
      stack.pop();
    }
  }
  fixedJsonStr = cleaned;

  while (stack.length > 0) {
    const last = stack.pop();
    if (last === "object") {
      fixedJsonStr += "}";
    } else if (last === "array") {
      fixedJsonStr += "]";
    }
  }

  try {
    return JSON.parse(fixedJsonStr) as Record<string, any>;
  } catch {
    return parseByBacktracking(fixedJsonStr);
  }
}

function parseByBacktracking(str: string): Record<string, any> {
  let isInsideString = false;
  let isEscaped = false;
  let lastCommaIdx = -1;

  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    if (isEscaped) {
      isEscaped = false;
      continue;
    }
    if (char === "\\") {
      isEscaped = true;
      continue;
    }
    if (char === '"') {
      isInsideString = !isInsideString;
      continue;
    }
    if (!isInsideString && char === ",") {
      lastCommaIdx = i;
    }
  }

  if (lastCommaIdx > -1) {
    const sub = str.slice(0, lastCommaIdx).trim() + "}";
    try {
      return JSON.parse(sub) as Record<string, any>;
    } catch {}
  }

  const obj: Record<string, any> = {};
  const regex = /"([^"]+)"\s*:\s*(?:"([^"\\]*(?:\\.[^"\\]*)*)"|([0-9.-]+)|(true|false|null))/g;
  let match;
  while ((match = regex.exec(str)) !== null) {
    const key = match[1];
    if (match[2] !== undefined) {
      try {
        obj[key] = JSON.parse('"' + match[2] + '"');
      } catch {
        obj[key] = match[2];
      }
    } else if (match[3] !== undefined) {
      obj[key] = Number(match[3]);
    } else if (match[4] !== undefined) {
      if (match[4] === "true") obj[key] = true;
      else if (match[4] === "false") obj[key] = false;
      else if (match[4] === "null") obj[key] = null;
    }
  }

  return obj;
}

