import { db, dbReady } from "@/lib/db";
import type { UserDTO } from "@/lib/types";

export const LOCAL_USER_ID = "desktop-user";
export const LOCAL_USER_EMAIL = "desktop@hermos.local";
export const LOCAL_USER_NAME = "Local Developer";
export const LOCAL_USER_ROLE = "admin";
export const LOCAL_USER_PROVIDER = "local";

export const DEFAULT_LOCAL_USER: UserDTO = {
  id: LOCAL_USER_ID,
  email: LOCAL_USER_EMAIL,
  name: LOCAL_USER_NAME,
  avatar: undefined,
  provider: LOCAL_USER_PROVIDER,
  role: LOCAL_USER_ROLE,
};

/** Converts a database User record to a UserDTO. */
export function toUserDTO(u: {
  id: string;
  email: string;
  name: string | null;
  avatar?: string | null;
  provider: string;
  role: string;
}): UserDTO {
  return {
    id: u.id,
    email: u.email,
    name: u.name ?? undefined,
    avatar: u.avatar ?? undefined,
    provider: u.provider,
    role: u.role,
  };
}

/** Resolves or creates the persistent local developer user. */
export async function getLocalUser(): Promise<UserDTO> {
  try {
    await dbReady;
    let dbUser = await db.user.findUnique({ where: { email: LOCAL_USER_EMAIL } });
    if (!dbUser) {
      dbUser = await db.user.upsert({
        where: { email: LOCAL_USER_EMAIL },
        update: {
          role: LOCAL_USER_ROLE,
          provider: LOCAL_USER_PROVIDER,
        },
        create: {
          id: LOCAL_USER_ID,
          email: LOCAL_USER_EMAIL,
          name: LOCAL_USER_NAME,
          role: LOCAL_USER_ROLE,
          provider: LOCAL_USER_PROVIDER,
        },
      });
    }
    return toUserDTO(dbUser);
  } catch (err) {
    console.error("[SESSION] getLocalUser database error, falling back to static user:", err);
    return DEFAULT_LOCAL_USER;
  }
}

/**
 * Resolves current user for local desktop environment.
 * Unconditionally returns the local developer user.
 */
export async function getCurrentUser(_req?: Request): Promise<UserDTO> {
  return getLocalUser();
}

/**
 * Requires an authenticated user.
 * In local-first desktop mode, unconditionally returns the local developer user.
 */
export async function requireUser(_req?: Request): Promise<UserDTO> {
  return getLocalUser();
}

