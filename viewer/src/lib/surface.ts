// Two-domain split: admin vs docs.
//
// One Node process serves both, with the request's Host header deciding
// which "surface" it belongs to. Each surface only sees the routes that
// belong to it; cross-surface paths return 404 so the admin URL isn't
// discoverable from the docs host.
//
// The split is opt-in: when neither PAPYRI_DOCS_HOST nor PAPYRI_ADMIN_HOST
// is set, every host serves everything (local-dev behaviour, current
// pre-split state). Setting either var turns on the gating for both.
//
// Threat model: a docstring inside a published bundle can carry arbitrary
// HTML, which we render on the docs surface. Putting admin on a separate
// hostname keeps the admin session cookie out of the docs origin's cookie
// store, so XSS in a bundle cannot steal it or fire authenticated calls
// against /api/admin/clear, /api/admin/reingest, etc.

export type Surface = "docs" | "admin";

/** Every admin-surface route lives under one of these prefixes. Anything
 *  else is the docs surface. The layout is URL-aligned with the source
 *  tree (`pages/admin/*` and `pages/api/admin/*`) so the eventual
 *  two-build split is a `cp -r` of those subtrees. */
export const ADMIN_PREFIXES = ["/admin", "/api/admin"] as const;

/** Admin-surface routes that bypass the session-cookie check:
 *  - `/admin/login` and `/api/admin/auth/*`: the login flow itself.
 *  - `/api/admin/bundle`: the upload endpoint, gated by its own bearer
 *    token (`PAPYRI_UPLOAD_TOKEN`) so external CI can ship bundles
 *    without holding a browser session. */
export const ADMIN_NO_SESSION_PREFIXES = [
  "/admin/login",
  "/api/admin/auth/",
  "/api/admin/bundle",
] as const;

function envHost(name: "PAPYRI_DOCS_HOST" | "PAPYRI_ADMIN_HOST"): string | null {
  const v = process.env[name];
  if (!v) return null;
  const t = v.trim().toLowerCase();
  return t ? t : null;
}

export function getDocsHost(): string | null {
  return envHost("PAPYRI_DOCS_HOST");
}

export function getAdminHost(): string | null {
  return envHost("PAPYRI_ADMIN_HOST");
}

/** True when at least one of the host env vars is set — gating turns on. */
export function splitEnabled(): boolean {
  return getDocsHost() !== null || getAdminHost() !== null;
}

/** True when the request was made over HTTPS, taking into account a
 *  reverse-proxy `x-forwarded-proto` header. Used to decide the `Secure`
 *  flag on the session cookie: marking it `Secure` over an HTTP request
 *  silently breaks login (the browser refuses to send the cookie back),
 *  so the rule has to follow the actual transport, not the host name. */
export function isSecureRequest(request: Request): boolean {
  const xfp = request.headers.get("x-forwarded-proto");
  if (xfp) {
    // Take the first proto if there's a comma-separated chain.
    return xfp.split(",")[0].trim().toLowerCase() === "https";
  }
  try {
    return new URL(request.url).protocol === "https:";
  } catch {
    return false;
  }
}

/** True if the host looks local. */
export function isLocalHost(host: string | null): boolean {
  if (!host) return true;
  const h = host.toLowerCase();
  if (h === "::1") return true;
  // Strip port: bracketed IPv6 form `[::1]:1234`, else simple `host:port`.
  let bare: string;
  if (h.startsWith("[")) {
    const idx = h.indexOf("]");
    bare = idx > 0 ? h.slice(1, idx) : h;
  } else {
    const idx = h.indexOf(":");
    bare = idx >= 0 ? h.slice(0, idx) : h;
  }
  return bare === "localhost" || bare === "127.0.0.1" || bare === "::1";
}

/** Decide which surface a request belongs to.
 *
 *  When the split is disabled, every request gets the docs surface — that
 *  surface is read-only and admin routes still require a session, so this
 *  is the safe fallback. When the split is enabled, the request's Host
 *  (or X-Forwarded-Host behind a proxy) picks the surface; an unknown
 *  host also gets docs so admin remains hidden to anything that bypasses
 *  the reverse proxy. */
export function getSurfaceForHost(host: string | null): Surface {
  if (!splitEnabled()) return "docs";
  const adminHost = getAdminHost();
  const h = (host ?? "").toLowerCase().split(",")[0].trim();
  if (adminHost && h === adminHost) return "admin";
  return "docs";
}

export function getSurface(request: Request): Surface {
  const fwd = request.headers.get("x-forwarded-host");
  return getSurfaceForHost(fwd ?? request.headers.get("host"));
}

function matchesPrefix(prefix: string, pathname: string): boolean {
  // Accept prefixes written with or without a trailing slash — `/api/auth/`
  // and `/api/auth` both mean "the subtree rooted at /api/auth".
  const p = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  return pathname === p || pathname === p + "/" || pathname.startsWith(p + "/");
}
function matchesAny(prefixes: readonly string[], pathname: string): boolean {
  return prefixes.some((p) => matchesPrefix(p, pathname));
}

/** Which surface a route belongs to. */
export function routeSurface(pathname: string): Surface {
  return matchesAny(ADMIN_PREFIXES, pathname) ? "admin" : "docs";
}

/** True when the route requires a session cookie. The no-session list
 *  takes precedence so `/admin/login` and `/api/admin/auth/*` are
 *  reachable without already being logged in. */
export function routeRequiresSession(pathname: string): boolean {
  if (matchesAny(ADMIN_NO_SESSION_PREFIXES, pathname)) return false;
  return matchesAny(ADMIN_PREFIXES, pathname);
}

export type RouteDecision =
  | { kind: "allow" }
  | { kind: "redirect"; to: string }
  | { kind: "deny"; status: 403 | 404 };

/** Pure routing decision. Middleware is a thin wrapper around this. */
export function decideRoute(args: {
  pathname: string;
  surface: Surface;
  hasSession: boolean;
  splitOn: boolean;
}): RouteDecision {
  const { pathname, surface, hasSession, splitOn } = args;
  const target = routeSurface(pathname);

  // Cross-surface paths 404 (don't redirect — that would leak the admin
  // URL to scanners on the docs host). Only enforced when the split is on.
  if (splitOn && surface !== target) {
    return { kind: "deny", status: 404 };
  }

  if (routeRequiresSession(pathname) && !hasSession) {
    if (pathname.startsWith("/api/")) return { kind: "deny", status: 403 };
    return { kind: "redirect", to: "/admin/login" };
  }

  return { kind: "allow" };
}

/** Origin for a configured host. Protocol comes from the current request
 *  when available, otherwise https for non-local hosts. */
export function originForHost(host: string, currentUrl?: URL): string {
  if (currentUrl) return `${currentUrl.protocol}//${host}`;
  return isLocalHost(host) ? `http://${host}` : `https://${host}`;
}
