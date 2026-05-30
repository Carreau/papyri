// /api/account/passkeys — self-service passkey management for signed-in users.
//
// GET  — list the caller's registered passkeys (public view, no key material).
// DELETE  — revoke a passkey by id (body: { id: number }).
// PATCH — rename a passkey (body: { id: number, name: string }).

import type { APIRoute } from "astro";
import { getAuthDb, SESSION_COOKIE } from "../../../lib/auth-db.ts";
import { respond } from "../../../lib/api-utils.ts";
import type { PublicPasskeyCredential } from "../../../lib/passkey.ts";

export const prerender = false;

async function resolveUser(cookies: Parameters<APIRoute>[0]["cookies"]) {
  const token = cookies.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return (await getAuthDb()).resolveSession(token);
}

function toPublic(c: {
  id: number;
  name: string | null;
  backed_up: boolean;
  transports: string[] | null;
  created_at: number;
  last_used_at: number | null;
}): PublicPasskeyCredential {
  return {
    id: c.id,
    name: c.name,
    backedUp: c.backed_up,
    transports: c.transports,
    created_at: c.created_at,
    last_used_at: c.last_used_at,
  };
}

export const GET: APIRoute = async ({ cookies }) => {
  const auth = await getAuthDb();
  const user = await resolveUser(cookies);
  if (!user) return respond({ error: "authentication required" }, 401);
  const creds = auth.listPasskeyCredentials(user.id).map(toPublic);
  return respond({ passkeys: creds });
};

export const DELETE: APIRoute = async ({ request, cookies }) => {
  const auth = await getAuthDb();
  const user = await resolveUser(cookies);
  if (!user) return respond({ ok: false, error: "authentication required" }, 401);

  let body: { id?: unknown };
  try {
    body = await request.json();
  } catch {
    return respond({ ok: false, error: "invalid JSON body" }, 400);
  }

  const id = typeof body.id === "number" ? body.id : null;
  if (id === null) return respond({ ok: false, error: "id is required" }, 400);

  const deleted = auth.deletePasskeyCredential(id, user.id);
  if (!deleted) return respond({ ok: false, error: "not found" }, 404);
  return respond({ ok: true });
};

export const PATCH: APIRoute = async ({ request, cookies }) => {
  const auth = await getAuthDb();
  const user = await resolveUser(cookies);
  if (!user) return respond({ ok: false, error: "authentication required" }, 401);

  let body: { id?: unknown; name?: unknown };
  try {
    body = await request.json();
  } catch {
    return respond({ ok: false, error: "invalid JSON body" }, 400);
  }

  const id = typeof body.id === "number" ? body.id : null;
  const name = typeof body.name === "string" ? body.name.trim() : null;
  if (id === null) return respond({ ok: false, error: "id is required" }, 400);
  if (name === null) return respond({ ok: false, error: "name is required" }, 400);

  const renamed = auth.renamePasskeyCredential(id, user.id, name);
  if (!renamed) return respond({ ok: false, error: "not found" }, 404);
  return respond({ ok: true });
};
