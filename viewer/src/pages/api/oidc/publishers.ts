// SSR endpoint: manage a project's trusted publishers (GitHub Actions OIDC).
//
// GET    /api/oidc/publishers            — list publishers the caller may see.
// POST   /api/oidc/publishers            — register one.
//        body: { project, repository, workflowRef, environment? }
// DELETE /api/oidc/publishers            — remove one. body: { id }.
//
// Auth: a session is required (the route sits in middleware.ts's
// AUTH_REQUIRED_PREFIXES) and is re-checked here. Registering a publisher
// grants upload rights on a project, so the caller must already have them: an
// admin, or a member of that project. Non-admins see and manage only the
// publishers of projects they are a member of.
//
// There is no secret in a publisher row — the trust is the OIDC signature
// GitHub puts on the token — so listing is not sensitive beyond revealing
// which repositories publish which project.

import type { APIRoute } from "astro";
import {
  getAuthDb,
  SESSION_COOKIE,
  type AuthDb,
  type PublicUser,
  type PublicOidcPublisher,
} from "../../../lib/auth-db.ts";
import { isValidRepository, normalizeWorkflowRef } from "../../../lib/github-oidc.ts";
import { respond } from "../../../lib/api-utils.ts";

export const prerender = false;

async function requireUser(cookies: { get(name: string): { value: string } | undefined }) {
  const token = cookies.get(SESSION_COOKIE)?.value;
  const auth = await getAuthDb();
  const user = token ? auth.resolveSession(token) : null;
  return { auth, user };
}

/** Projects the caller may register a publisher for. */
function manageableProjects(auth: AuthDb, user: PublicUser): string[] {
  return user.is_admin ? auth.listProjects().map((p) => p.name) : auth.listUserProjects(user.id);
}

function visiblePublishers(auth: AuthDb, user: PublicUser): PublicOidcPublisher[] {
  const all = auth.listOidcPublishers();
  if (user.is_admin) return all;
  const mine = new Set(auth.listUserProjects(user.id));
  return all.filter((pub) => mine.has(pub.project_name));
}

export const GET: APIRoute = async ({ cookies }) => {
  const { auth, user } = await requireUser(cookies);
  if (!user) return respond({ ok: false, error: "authentication required" }, 401);
  return respond({
    ok: true,
    publishers: visiblePublishers(auth, user),
    projects: manageableProjects(auth, user),
  });
};

export const POST: APIRoute = async ({ request, cookies }) => {
  const { auth, user } = await requireUser(cookies);
  if (!user) return respond({ ok: false, error: "authentication required" }, 401);

  let body: {
    project?: unknown;
    repository?: unknown;
    workflowRef?: unknown;
    environment?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return respond({ ok: false, error: "invalid JSON body" }, 400);
  }

  const { project, repository, workflowRef } = body;
  if (typeof project !== "string" || !project) {
    return respond({ ok: false, error: "project is required" }, 400);
  }
  if (!isValidRepository(repository)) {
    return respond({ ok: false, error: 'repository must be of the form "owner/repo"' }, 400);
  }
  const normalizedWorkflow = normalizeWorkflowRef(workflowRef);
  if (!normalizedWorkflow) {
    return respond(
      { ok: false, error: "workflowRef must be a workflow file name, e.g. docs.yml" },
      400
    );
  }
  let environment: string | null = null;
  if (body.environment !== undefined && body.environment !== null) {
    if (typeof body.environment !== "string" || body.environment.length > 255) {
      return respond(
        { ok: false, error: "environment must be a string of at most 255 chars" },
        400
      );
    }
    environment = body.environment.trim() || null;
  }

  const row = auth.getProjectByName(project);
  // Same message for "no such project" and "not yours": a non-member has no
  // business learning which projects exist here.
  if (!row || !manageableProjects(auth, user).includes(project)) {
    return respond({ ok: false, error: `not authorized to manage project "${project}"` }, 403);
  }

  try {
    const publisher = auth.createOidcPublisher(
      row.id,
      repository,
      normalizedWorkflow,
      environment,
      user.id
    );
    return respond({ ok: true, publisher }, 201);
  } catch (err) {
    console.warn(`[oidc] createOidcPublisher failed: ${String(err)}`);
    return respond(
      { ok: false, error: "could not register publisher (it may already exist)" },
      409
    );
  }
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
  if (typeof body.id !== "number" || !Number.isInteger(body.id)) {
    return respond({ ok: false, error: "id must be an integer" }, 400);
  }

  const publisher = auth.getOidcPublisher(body.id);
  if (!publisher) return respond({ ok: false, error: "no such publisher" }, 404);
  if (!manageableProjects(auth, user).includes(publisher.project_name)) {
    return respond(
      { ok: false, error: `not authorized to manage project "${publisher.project_name}"` },
      403
    );
  }
  auth.deleteOidcPublisher(publisher.id);
  return respond({ ok: true });
};
