import type { AstroGlobal } from "astro";
import { getAuthDb, SESSION_COOKIE, type PublicUser } from "./auth-db.ts";

/**
 * Resolve the current request's session cookie to its user, or null. Unlike a
 * bare cookie-presence check, this validates the token against the auth store
 * and enforces expiry, so a stale or forged cookie resolves to null.
 */
export async function getSessionUser(astro: AstroGlobal): Promise<PublicUser | null> {
  const token = astro.cookies.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return (await getAuthDb()).resolveSession(token);
}

export async function isAuthenticated(astro: AstroGlobal): Promise<boolean> {
  return (await getSessionUser(astro)) !== null;
}
