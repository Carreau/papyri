import { defineMiddleware } from "astro:middleware";
import { decideRoute, getSurface, splitEnabled } from "./lib/surface.ts";

// Two-domain split:
//   - "admin" surface owns /admin, /nodes, /ir-stats, /login, /api/auth/*,
//     /api/bundle, and all admin /api/* endpoints. Mutating + authenticated.
//   - "docs" surface owns everything else (bundle index, /project/**, the
//     read-only search/text-search/health/[pkg]/[ver] APIs). Read-only.
//
// When PAPYRI_DOCS_HOST / PAPYRI_ADMIN_HOST are unset the split is off:
// every host serves everything and the behaviour matches the pre-split
// dev flow.
//
// All routing is delegated to `decideRoute` in lib/surface.ts so the
// logic is testable without spinning up Astro.

const SESSION_COOKIE = "papyri_session_token";

/** Security headers applied to every response.
 *
 *  The substantive XSS defence is the domain split itself — putting admin
 *  on a different host keeps the admin session cookie out of the docs
 *  origin's cookie store, so a bundle-injected script on the docs page
 *  cannot steal it or fire authenticated requests against admin
 *  endpoints. These headers are belt-and-braces on top of that:
 *
 *  - default-src/connect-src 'self': a docs-page XSS can't exfiltrate to
 *    an attacker server or fetch admin endpoints (cross-origin + no
 *    cookie anyway).
 *  - object-src 'none' / base-uri 'self' / form-action 'self': close off
 *    the remaining XSS amplification vectors.
 *  - frame-ancestors 'none' + X-Frame-Options DENY: no clickjacking of
 *    the admin login form, and no embedding of docs pages.
 *  - 'unsafe-inline' for script/style is kept for now because Astro
 *    hydration and Shiki/KaTeX styles emit inline tags; nonces are a
 *    future tightening once Astro's CSP integration lands. */
const CSP = [
  "default-src 'self'",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join("; ");

function applySecurityHeaders(response: Response): Response {
  // Headers are the same on both surfaces today — frame-ancestors 'none'
  // applies to docs pages too (nobody legitimately iframes a bundle page).
  response.headers.set("Content-Security-Policy", CSP);
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  return response;
}

export const onRequest = defineMiddleware(async (context, next) => {
  const surface = getSurface(context.request);
  const session = context.cookies.get(SESSION_COOKIE);
  const decision = decideRoute({
    pathname: context.url.pathname,
    surface,
    hasSession: !!session?.value,
    splitOn: splitEnabled(),
  });

  if (decision.kind === "deny") {
    if (decision.status === 403) {
      return new Response(JSON.stringify({ error: "Authentication required" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }
    // 404: don't reveal whether the path exists on the other surface.
    return new Response("Not Found", {
      status: 404,
      headers: { "Content-Type": "text/plain" },
    });
  }

  if (decision.kind === "redirect") {
    return context.redirect(decision.to);
  }

  return applySecurityHeaders(await next());
});
