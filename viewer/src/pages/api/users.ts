// SSR endpoint: user account management.
//
// GET    /api/users   — list users (id, username, is_admin, created_at).
// POST   /api/users   — create a user. body: { username, password, isAdmin? }.
// PATCH  /api/users   — toggle admin. body: { id, isAdmin }.
// DELETE /api/users   — delete a user. body: { id }.
//
// Auth: an admin action — gated by the session-cookie middleware (the route is
// listed in middleware.ts's ADMIN_ONLY_PREFIXES, so only a logged-in admin can
// reach it). Passwords are hashed with Argon2id in the auth store; this endpoint
// never returns a password hash.

import type { APIRoute } from "astro";
import { getAuthDb, isValidUsername } from "../../lib/auth-db.ts";
import { respond } from "../../lib/api-utils.ts";

export const prerender = false;

export const GET: APIRoute = async () => {
  const auth = await getAuthDb();
  return respond({ ok: true, users: auth.listUsers() });
};

export const POST: APIRoute = async ({ request }) => {
  let body: { username?: unknown; password?: unknown; isAdmin?: unknown };
  try {
    body = await request.json();
  } catch {
    return respond({ ok: false, error: "invalid JSON body" }, 400);
  }

  const { username, password, isAdmin } = body;
  if (!isValidUsername(username)) {
    return respond({ ok: false, error: "invalid username" }, 400);
  }
  if (typeof password !== "string" || password.length < 8) {
    return respond({ ok: false, error: "password must be at least 8 characters" }, 400);
  }
  if (isAdmin !== undefined && typeof isAdmin !== "boolean") {
    return respond({ ok: false, error: "isAdmin must be a boolean" }, 400);
  }

  const auth = await getAuthDb();
  try {
    const user = await auth.createUser(username, password, isAdmin === true);
    return respond({ ok: true, user }, 201);
  } catch (err) {
    // Most likely a UNIQUE violation on username; log server-side, keep the
    // client message generic.
    console.warn(`[auth] createUser failed: ${String(err)}`);
    return respond({ ok: false, error: "could not create user (username may already exist)" }, 409);
  }
};

export const PATCH: APIRoute = async ({ request }) => {
  let body: { id?: unknown; isAdmin?: unknown };
  try {
    body = await request.json();
  } catch {
    return respond({ ok: false, error: "invalid JSON body" }, 400);
  }

  const { id, isAdmin } = body;
  if (typeof id !== "number" || !Number.isInteger(id)) {
    return respond({ ok: false, error: "id must be an integer" }, 400);
  }
  if (typeof isAdmin !== "boolean") {
    return respond({ ok: false, error: "isAdmin must be a boolean" }, 400);
  }

  const auth = await getAuthDb();
  const result = auth.setAdmin(id, isAdmin);
  if (!result.ok) {
    if (result.reason === "no-user") {
      return respond({ ok: false, error: "no such user" }, 404);
    }
    // last-admin
    return respond({ ok: false, error: "cannot demote the last remaining admin" }, 409);
  }
  return respond({ ok: true, user: auth.getUser(id) });
};

export const DELETE: APIRoute = async ({ request }) => {
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

  const auth = await getAuthDb();

  // Refuse to delete the last remaining user — that would lock everyone out
  // (fail-closed login means no env fallback to recover with).
  if (auth.userCount() <= 1) {
    return respond({ ok: false, error: "cannot delete the last remaining user" }, 409);
  }
  // Likewise refuse to delete the last admin: a site with only non-admin users
  // can never reach the admin tools again.
  const target = auth.getUser(id);
  if (target?.is_admin && auth.adminCount() <= 1) {
    return respond({ ok: false, error: "cannot delete the last remaining admin" }, 409);
  }

  const deleted = auth.deleteUser(id);
  if (!deleted) {
    return respond({ ok: false, error: "no such user" }, 404);
  }
  return respond({ ok: true });
};
