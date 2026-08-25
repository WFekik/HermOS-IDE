/**
 * Server-side persistence and resolution of user security settings,
 * stored per-user in a reserved Plugin row (`__security__`).
 */
import { db } from "@/lib/db";
import { audit } from "@/app/api/_lib/helpers";
import {
  DEFAULT_SECURITY_SETTINGS,
  type SecuritySettings,
} from "@/lib/security-types";

export const SECURITY_SETTINGS_PLUGIN_NAME = "__security__";

function normalize(parsed: Partial<SecuritySettings>): SecuritySettings {
  return {
    autoScrubSecrets:
      typeof parsed.autoScrubSecrets === "boolean"
        ? parsed.autoScrubSecrets
        : DEFAULT_SECURITY_SETTINGS.autoScrubSecrets,
    customRedactionRegex:
      typeof parsed.customRedactionRegex === "string"
        ? parsed.customRedactionRegex
        : DEFAULT_SECURITY_SETTINGS.customRedactionRegex,
  };
}

/** Resolve a user's security settings. Never throws — returns defaults. */
export async function getSecuritySettings(userId: string): Promise<SecuritySettings> {
  try {
    const row = await db.plugin.findFirst({
      where: { userId, name: SECURITY_SETTINGS_PLUGIN_NAME },
    });
    if (!row || !row.config) return { ...DEFAULT_SECURITY_SETTINGS };
    return normalize(JSON.parse(row.config) as Partial<SecuritySettings>);
  } catch {
    return { ...DEFAULT_SECURITY_SETTINGS };
  }
}

/** Persist validated security settings updates; returns full merged config. */
export async function setSecuritySettings(
  userId: string,
  patch: Partial<SecuritySettings>,
): Promise<SecuritySettings> {
  const current = await getSecuritySettings(userId);
  const merged = normalize({ ...current, ...patch });
  const json = JSON.stringify(merged);
  await db.plugin.upsert({
    where: { userId_name: { userId, name: SECURITY_SETTINGS_PLUGIN_NAME } },
    update: { config: json, type: "plugin" },
    create: {
      userId,
      name: SECURITY_SETTINGS_PLUGIN_NAME,
      description: "Security & privacy settings (auto-managed)",
      type: "plugin",
      source: "system",
      enabled: true,
      config: json,
    },
  });
  try {
    await audit(userId, "security_settings_update", "updated via /api/security/settings");
  } catch {
    /* ignore audit failures */
  }
  return merged;
}