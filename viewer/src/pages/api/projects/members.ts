// SSR endpoint: assign / unassign users to a project.
//
// POST   /api/projects/members   — assign.   body: { projectId, userId }.
// DELETE /api/projects/members   — unassign. body: { projectId, userId }.
//
// Auth: admin-only — covered by middleware.ts's "/api/projects" prefix (which
// matches this nested route too).

import type { APIRoute } from "astro";
import { getAuthDb } from "../../../lib/auth-db.ts";
import { respond } from "../../../lib/api-utils.ts";

export const prerender = false;

function parseIds(body: {
  projectId?: unknown;
  userId?: unknown;
}): { projectId: number; userId: number } | null {
  const { projectId, userId } = body;
  if (typeof projectId !== "number" || !Number.isInteger(projectId)) return null;
  if (typeof userId !== "number" || !Number.isInteger(userId)) return null;
  return { projectId, userId };
}

export const POST: APIRoute = async ({ request }) => {
  let body: { projectId?: unknown; userId?: unknown };
  try {
    body = await request.json();
  } catch {
    return respond({ ok: false, error: "invalid JSON body" }, 400);
  }
  const ids = parseIds(body);
  if (!ids) {
    return respond({ ok: false, error: "projectId and userId must be integers" }, 400);
  }

  const auth = await getAuthDb();
  if (!auth.listProjects().some((p) => p.id === ids.projectId)) {
    return respond({ ok: false, error: "no such project" }, 404);
  }
  if (!auth.getUser(ids.userId)) {
    return respond({ ok: false, error: "no such user" }, 404);
  }
  auth.addMember(ids.projectId, ids.userId);
  return respond({ ok: true, members: auth.listMembers(ids.projectId) });
};

export const DELETE: APIRoute = async ({ request }) => {
  let body: { projectId?: unknown; userId?: unknown };
  try {
    body = await request.json();
  } catch {
    return respond({ ok: false, error: "invalid JSON body" }, 400);
  }
  const ids = parseIds(body);
  if (!ids) {
    return respond({ ok: false, error: "projectId and userId must be integers" }, 400);
  }

  const auth = await getAuthDb();
  const removed = auth.removeMember(ids.projectId, ids.userId);
  if (!removed) {
    return respond({ ok: false, error: "user was not a member of that project" }, 404);
  }
  return respond({ ok: true, members: auth.listMembers(ids.projectId) });
};
