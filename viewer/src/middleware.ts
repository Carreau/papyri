import { defineMiddleware } from "astro:middleware";

// Routes that must remain reachable without a session, otherwise users
// can never reach the login form to authenticate. Any new public route
// (e.g. a future signup page) needs an explicit entry here.
const PUBLIC_PREFIXES = ["/login", "/api/auth/"];

function isPublic(pathname: string): boolean {
  return PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p));
}

export const onRequest = defineMiddleware((context, next) => {
  if (isPublic(context.url.pathname)) {
    return next();
  }
  const session = context.cookies.get("papyri_session_token");
  if (!session?.value) {
    return context.redirect("/login");
  }
  return next();
});
