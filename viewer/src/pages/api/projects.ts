// SSR endpoint: project management (a "project" is a package/module name).
//
// GET    /api/projects   — list projects, each with its assigned members.
// POST   /api/projects   — create a project. body: { name }.
// DELETE /api/projects   — delete a project. body: { id }.
//
// Auth: an admin action — gated by the session-cookie middleware (the route is
// in middleware.ts's ADMIN_ONLY_PREFIXES, so only a logged-in admin reaches
// it). Member assignment lives at /api/projects/members.
//
// Membership grants upload rights: a user assigned to project "numpy" may
// `papyri upload` any version of numpy using one of their personal upload
// tokens (see /api/account/tokens). Admins may upload any project regardless.

import type { APIRoute } from "astro";
import { getAuthDb, isValidProjectName, type PublicUser } from "../../lib/auth-db.ts";
import { respond } from "../../lib/api-utils.ts";

export const prerender = false;

export interface ProjectWithMembers {
  id: number;
  name: string;
  created_at: number;
  members: PublicUser[];
}

export const GET: APIRoute = async () => {
  const auth = await getAuthDb();
  const projects: ProjectWithMembers[] = auth.listProjects().map((p) => ({
    ...p,
    members: auth.listMembers(p.id),
  }));
  return respond({ ok: true, projects });
};

export const POST: APIRoute = async ({ request }) => {
  let body: { name?: unknown };
  try {
    body = await request.json();
  } catch {
    return respond({ ok: false, error: "invalid JSON body" }, 400);
  }

  const { name } = body;
  if (!isValidProjectName(name)) {
    return respond({ ok: false, error: "invalid project name" }, 400);
  }

  const auth = await getAuthDb();
  try {
    const project = auth.createProject(name);
    return respond({ ok: true, project: { ...project, members: [] } }, 201);
  } catch (err) {
    // Most likely a UNIQUE violation; log server-side, keep client message generic.
    console.warn(`[auth] createProject failed: ${String(err)}`);
    return respond({ ok: false, error: "could not create project (name may already exist)" }, 409);
  }
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
  const deleted = auth.deleteProject(id);
  if (!deleted) {
    return respond({ ok: false, error: "no such project" }, 404);
  }
  return respond({ ok: true });
};
