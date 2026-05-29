// SSR endpoint: the signed-in user changes their own password.
//
// POST /api/account/password — body: { currentPassword, newPassword }.
//
// Auth: resolves the caller from their session cookie (not an admin action —
// any logged-in user manages their own account). The route is listed in
// middleware.ts's AUTH_REQUIRED_PREFIXES, but we re-check here so the endpoint
// is safe regardless of middleware wiring. The current password is verified
// before the change, and the user's *other* sessions are revoked afterwards so
// a leaked session cannot keep riding the old credentials.

import type { APIRoute } from "astro";
import { getAuthDb, SESSION_COOKIE } from "../../../lib/auth-db.ts";
import { respond } from "../../../lib/api-utils.ts";

export const prerender = false;

export const POST: APIRoute = async ({ request, cookies }) => {
  const token = cookies.get(SESSION_COOKIE)?.value;
  const auth = await getAuthDb();
  const user = token ? auth.resolveSession(token) : null;
  if (!token || !user) {
    return respond({ ok: false, error: "authentication required" }, 401);
  }

  let body: { currentPassword?: unknown; newPassword?: unknown };
  try {
    body = await request.json();
  } catch {
    return respond({ ok: false, error: "invalid JSON body" }, 400);
  }

  const { currentPassword, newPassword } = body;
  if (typeof currentPassword !== "string" || typeof newPassword !== "string") {
    return respond({ ok: false, error: "currentPassword and newPassword are required" }, 400);
  }

  const result = await auth.changePassword(user.id, currentPassword, newPassword);
  if (!result.ok) {
    switch (result.reason) {
      case "wrong-current":
        return respond({ ok: false, error: "current password is incorrect" }, 403);
      case "weak-new":
        return respond({ ok: false, error: "password must be at least 8 characters" }, 400);
      case "no-user":
        // Session resolved to a user that has since vanished — treat as unauthenticated.
        return respond({ ok: false, error: "authentication required" }, 401);
    }
  }

  const revokedSessions = auth.deleteOtherSessions(user.id, token);
  return respond({ ok: true, revokedSessions });
};
