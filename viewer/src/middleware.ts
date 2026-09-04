import { defineMiddleware } from "astro:middleware";
import type { APIContext } from "astro";
import { getAuthDb, SESSION_COOKIE } from "./lib/auth-db.ts";
import { parsePreviewPath, previewId } from "./lib/preview.ts";
import { previewContext, runInRequestContext } from "./lib/request-context.ts";

// Routes that must remain reachable without a session (login form, auth
// endpoints, bundle upload). Any new pre-auth route needs an entry here.
// `/api/bundle` is the upload endpoint hit by `papyri upload`; it carries
// its own bearer-token check and must stay reachable without a session cookie.
// `/api/preview` (drop / list-own) is authenticated by a GitHub OIDC token
// exactly like the upload endpoint, so it too must bypass the session gate.
const PUBLIC_PREFIXES = ["/login", "/api/auth/", "/api/bundle", "/api/preview"] as const;

// Routes restricted to authenticated users. Everything not listed here (and
// not in PUBLIC_PREFIXES) is accessible to guests so they can browse docs
// without logging in.
//
// Admin-only routes are computationally expensive (full corpus walks), carry
// destructive write operations, or manage accounts / project membership;
// guests and non-admin users have no need for them. These require a session
// whose user has `is_admin` set.
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
  "/api/projects",
] as const;

// Routes any signed-in user may reach but guests may not — self-service
// account management (change password, mint/revoke personal upload tokens).
// These require a session but NOT admin.
const AUTH_REQUIRED_PREFIXES = ["/settings", "/api/account"] as const;

/** True when `pathname` equals `prefix`, `prefix + "/"`, or any deeper path. */
function matchesPrefix(prefix: string, pathname: string): boolean {
  return pathname === prefix || pathname === prefix + "/" || pathname.startsWith(prefix + "/");
}

function matchesAny(prefixes: readonly string[], pathname: string): boolean {
  return prefixes.some((p) => matchesPrefix(p, pathname));
}

/**
 * Auth gate for one (already un-prefixed) pathname. Returns a Response to
 * short-circuit with, or null to let the request through.
 */
async function authGate(context: APIContext, pathname: string): Promise<Response | null> {
  // Public routes bypass all auth checks.
  if (matchesAny(PUBLIC_PREFIXES, pathname)) {
    return null;
  }

  // Admin-only and signed-in-user routes both require an active, unexpired
  // session. We validate the token against the auth store (not just its
  // presence) so a stale, forged, or revoked cookie is rejected.
  const adminOnly = matchesAny(ADMIN_ONLY_PREFIXES, pathname);
  if (adminOnly || matchesAny(AUTH_REQUIRED_PREFIXES, pathname)) {
    const token = context.cookies.get(SESSION_COOKIE)?.value;
    const user = token ? (await getAuthDb()).resolveSession(token) : null;
    const isApi = pathname.startsWith("/api/");
    if (!user) {
      // API callers receive a JSON 403 instead of an HTML redirect.
      if (isApi) {
        return new Response(JSON.stringify({ error: "Authentication required" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        });
      }
      return context.redirect("/login");
    }
    // Admin-only routes additionally require the admin role. A signed-in but
    // non-admin user is forbidden (API) or bounced to the bundle index (page).
    if (adminOnly && !user.is_admin) {
      if (isApi) {
        return new Response(JSON.stringify({ error: "Admin privileges required" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        });
      }
      return context.redirect("/");
    }
  }

  // Everything else (docs, bundle index, text search, …) is open to guests.
  return null;
}

/**
 * Serve one request out of a PR preview namespace.
 *
 * `/preview/<owner>/<repo>/<pr>/<rest>` is rewritten to `<rest>`, so preview
 * pages run the *same* routes as the main store; what changes is the request
 * context, which points `getBackends()` at the preview's own SQLite + blob
 * directory and prefixes every URL `links.ts` builds (see `url-base.ts`).
 *
 * The response body is buffered inside the context so the store is still
 * active while Astro renders, whenever the body is pulled.
 */
async function servePreview(
  context: APIContext,
  parsed: NonNullable<ReturnType<typeof parsePreviewPath>>
): Promise<Response> {
  const record = (await getAuthDb()).getPreview(previewId(parsed.ref));
  if (!record) {
    return new Response("No such preview — it may have been merged, closed, or expired.", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  // A preview is a read-only browse surface. Admin tooling, account pages and
  // the upload/drop endpoints all address the *deployment*, not one preview:
  // reaching them through a preview prefix would point destructive operations
  // (clear graphstore, reingest) at the preview store. They stay global-only.
  if (
    matchesAny(ADMIN_ONLY_PREFIXES, parsed.rest) ||
    matchesAny(AUTH_REQUIRED_PREFIXES, parsed.rest) ||
    matchesAny(PUBLIC_PREFIXES, parsed.rest)
  ) {
    return new Response("Not available inside a preview", { status: 404 });
  }

  const gate = await authGate(context, parsed.rest);
  if (gate) return gate;

  const target = new URL(parsed.rest + context.url.search, context.url);
  // `context.rewrite(request)`, not `next(url)`: a `next()` rewrite renders
  // the target page but does not re-bind route params for endpoint (`.ts`)
  // routes, so `/…/search.json` and the asset endpoint would see
  // `params.pkg === undefined` and 404. Rewriting re-enters this middleware
  // with the un-prefixed path, which no longer matches `/preview/` — the
  // request context set here stays active across that second pass.
  const rewritten = new Request(target, context.request);
  return runInRequestContext(previewContext(parsed.ref), async () => {
    const res = await context.rewrite(rewritten);
    const body = res.status === 204 || res.status === 304 ? null : await res.arrayBuffer();
    return new Response(body, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  });
}

export const onRequest = defineMiddleware(async (context, next) => {
  const { pathname } = context.url;

  if (pathname === "/preview" || pathname.startsWith("/preview/")) {
    const parsed = parsePreviewPath(pathname);
    if (!parsed) return new Response("Malformed preview URL", { status: 404 });
    return servePreview(context, parsed);
  }

  const gate = await authGate(context, pathname);
  return gate ?? next();
});
