// SSR endpoint: a signed-in user manages their own personal upload tokens.
//
// GET    /api/account/tokens   — list the caller's tokens (never the secret).
// POST   /api/account/tokens   — mint one. body: { name?, ttlDays? }.
//                                The plaintext secret is returned ONCE here.
// DELETE /api/account/tokens   — revoke one. body: { id }.
//
// Auth: resolves the caller from their session cookie (any logged-in user
// manages their own tokens — not an admin action). The route is in
// middleware.ts's AUTH_REQUIRED_PREFIXES, but we re-check here so the endpoint
// is safe regardless of middleware wiring.
//
// A token authorizes `papyri upload` for any project its owner is a member of
// (admins: any project). Authority is resolved live from membership at upload
// time, so a token does not need re-issuing when assignments change.

import type { APIRoute } from "astro";
import { getAuthDb, SESSION_COOKIE } from "../../../lib/auth-db.ts";
import { respond } from "../../../lib/api-utils.ts";

export const prerender = false;

// Cap on token lifetime requests, mirroring a sane upper bound (5 years).
const MAX_TTL_DAYS = 365 * 5;

async function requireUser(cookies: { get(name: string): { value: string } | undefined }) {
  const token = cookies.get(SESSION_COOKIE)?.value;
  const auth = await getAuthDb();
  const user = token ? auth.resolveSession(token) : null;
  return { auth, user };
}

export const GET: APIRoute = async ({ cookies }) => {
  const { auth, user } = await requireUser(cookies);
  if (!user) return respond({ ok: false, error: "authentication required" }, 401);
  return respond({
    ok: true,
    tokens: auth.listUploadTokens(user.id),
    projects: auth.listUserProjects(user.id),
    is_admin: user.is_admin,
  });
};

export const POST: APIRoute = async ({ request, cookies }) => {
  const { auth, user } = await requireUser(cookies);
  if (!user) return respond({ ok: false, error: "authentication required" }, 401);

  let body: { name?: unknown; ttlDays?: unknown };
  try {
    body = await request.json();
  } catch {
    return respond({ ok: false, error: "invalid JSON body" }, 400);
  }

  let name: string | null = null;
  if (body.name !== undefined && body.name !== null) {
    if (typeof body.name !== "string" || body.name.length > 64) {
      return respond({ ok: false, error: "name must be a string of at most 64 chars" }, 400);
    }
    name = body.name.trim() || null;
  }

  let ttlSeconds: number | null = null;
  if (body.ttlDays !== undefined && body.ttlDays !== null) {
    const d = body.ttlDays;
    if (typeof d !== "number" || !Number.isInteger(d) || d <= 0 || d > MAX_TTL_DAYS) {
      return respond(
        { ok: false, error: `ttlDays must be an integer between 1 and ${MAX_TTL_DAYS}` },
        400
      );
    }
    ttlSeconds = d * 24 * 60 * 60;
  }

  const { token, secret } = auth.createUploadToken(user.id, name, ttlSeconds);
  // `secret` is returned exactly once — the client must store it now.
  return respond({ ok: true, token, secret }, 201);
};

export const DELETE: APIRoute = async ({ request, cookies }) => {
  const { auth, user } = await requireUser(cookies);
  if (!user) return respond({ ok: false, error: "authentication required" }, 401);

  let body: { id?: unknown };
  try {
    body = await request.json();
  } catch {
    return respond({ ok: false, error: "invalid JSON body" }, 400);
  }
  const id = body.id;
  if (typeof id !== "number" || !Number.isInteger(id)) {
    return respond({ ok: false, error: "id must be an integer" }, 400);
  }

  // Scoped to the caller, so a user can only revoke their own tokens.
  const revoked = auth.revokeUploadToken(id, user.id);
  if (!revoked) {
    return respond({ ok: false, error: "no such token" }, 404);
  }
  return respond({ ok: true });
};
