import { defineMiddleware } from "astro:middleware";
import { getAuthDb, SESSION_COOKIE } from "./lib/auth-db.ts";

// Routes that must remain reachable without a session (login form, auth
// endpoints, bundle upload). Any new pre-auth route needs an entry here.
// `/api/bundle` is the upload endpoint hit by `papyri upload`; it carries
// its own bearer-token check and must stay reachable without a session cookie.
const PUBLIC_PREFIXES = ["/login", "/api/auth/", "/api/bundle"] as const;

// Routes restricted to authenticated users. Everything not listed here (and
// not in PUBLIC_PREFIXES) is accessible to guests so they can browse docs
// without logging in.
//
// Admin-only routes are computationally expensive (full corpus walks) or
// carry destructive write operations; guests have no need for them.
const ADMIN_ONLY_PREFIXES = [
  "/admin",
  "/nodes",
  "/ir-stats",
  "/api/nodes.json",
  "/api/ir-stats.json",
  "/api/clear",
  "/api/clear-raw",
  "/api/reingest",
  "/api/inventory",
  "/api/stats",
  "/api/users",
] as const;

// Routes any signed-in user may reach but guests may not — self-service
// account management. There is no admin/user role distinction today, so the
// session check below is identical to the admin one; the lists are kept apart
// so the intent stays clear once roles exist.
const AUTH_REQUIRED_PREFIXES = ["/settings", "/api/account"] as const;

/** True when `pathname` equals `prefix`, `prefix + "/"`, or any deeper path. */
function matchesPrefix(prefix: string, pathname: string): boolean {
  return pathname === prefix || pathname === prefix + "/" || pathname.startsWith(prefix + "/");
}

function matchesAny(prefixes: readonly string[], pathname: string): boolean {
  return prefixes.some((p) => matchesPrefix(p, pathname));
}

export const onRequest = defineMiddleware(async (context, next) => {
  const { pathname } = context.url;

  // Public routes bypass all auth checks.
  if (matchesAny(PUBLIC_PREFIXES, pathname)) {
    return next();
  }

  // Admin-only and signed-in-user routes both require an active, unexpired
  // session. We validate the token against the auth store (not just its
  // presence) so a stale, forged, or revoked cookie is rejected.
  if (matchesAny(ADMIN_ONLY_PREFIXES, pathname) || matchesAny(AUTH_REQUIRED_PREFIXES, pathname)) {
    const token = context.cookies.get(SESSION_COOKIE)?.value;
    const user = token ? (await getAuthDb()).resolveSession(token) : null;
    if (!user) {
      // API callers receive a JSON 403 instead of an HTML redirect.
      if (pathname.startsWith("/api/")) {
        return new Response(JSON.stringify({ error: "Authentication required" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        });
      }
      return context.redirect("/login");
    }
  }

  // Everything else (docs, bundle index, text search, …) is open to guests.
  return next();
});
