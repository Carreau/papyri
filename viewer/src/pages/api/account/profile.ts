// SSR endpoint: the signed-in user updates their profile (currently: GitHub username).
//
// PATCH /api/account/profile — body: { githubUsername: string | null }
//
// Auth: session cookie required. The route falls under AUTH_REQUIRED_PREFIXES
// in middleware.ts, but we re-check here so the endpoint is safe regardless of
// middleware wiring.

import type { APIRoute } from "astro";
import { getAuthDb, SESSION_COOKIE } from "../../../lib/auth-db.ts";
import { respond } from "../../../lib/api-utils.ts";

export const prerender = false;

/** GitHub username rule: alphanumeric + hyphens, 1–39 chars, no leading/trailing hyphen. */
const GITHUB_USERNAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/;

function isValidGithubUsername(v: unknown): v is string {
  return typeof v === "string" && GITHUB_USERNAME_RE.test(v);
}

export const PATCH: APIRoute = async ({ request, cookies }) => {
  const token = cookies.get(SESSION_COOKIE)?.value;
  const auth = await getAuthDb();
  const user = token ? auth.resolveSession(token) : null;
  if (!token || !user) {
    return respond({ ok: false, error: "authentication required" }, 401);
  }

  let body: { githubUsername?: unknown };
  try {
    body = await request.json();
  } catch {
    return respond({ ok: false, error: "invalid JSON body" }, 400);
  }

  const { githubUsername } = body;

  // Accept a valid username string, or null/empty string to unlink.
  let resolved: string | null;
  if (githubUsername === null || githubUsername === "" || githubUsername === undefined) {
    resolved = null;
  } else if (isValidGithubUsername(githubUsername)) {
    resolved = githubUsername;
  } else {
    return respond({ ok: false, error: "invalid GitHub username" }, 400);
  }

  auth.setGithubUsername(user.id, resolved);
  return respond({ ok: true, githubUsername: resolved });
};
