// SSR endpoint: trusted publishers (GitHub OIDC) for a project.
//
// GET    /api/projects/publishers — list every registered publisher.
// POST   /api/projects/publishers — trust a repository. body:
//                                   { project, repository, workflow? }.
// DELETE /api/projects/publishers — untrust one. body: { id }.
//
// A publisher says "this GitHub repository, optionally through this workflow
// file, may upload PR previews for this project using an Actions OIDC token"
// — the trusted-publishing model, so fork pull requests (which cannot read
// repository secrets) can still publish a doc preview. See `lib/oidc.ts`.
//
// Auth: admin-only, via the session-cookie middleware (/api/projects is in
// ADMIN_ONLY_PREFIXES, and prefix matching covers this sub-route).
import type { APIRoute } from "astro";
import { getAuthDb } from "../../../lib/auth-db.ts";
import { respond } from "../../../lib/api-utils.ts";

export const prerender = false;

/** `owner/repo`, matching GitHub's own naming limits. */
const REPOSITORY_RE = /^[A-Za-z0-9](?:-?[A-Za-z0-9]){0,38}\/[A-Za-z0-9._-]{1,100}$/;

/**
 * A workflow file path as it appears in a `workflow_ref` claim. Empty means
 * "any workflow in that repository".
 */
const WORKFLOW_RE = /^[A-Za-z0-9._/-]{1,200}$/;

export const GET: APIRoute = async () => {
  return respond({ ok: true, publishers: (await getAuthDb()).listOidcPublishers() });
};

export const POST: APIRoute = async ({ request }) => {
  let body: { project?: unknown; repository?: unknown; workflow?: unknown };
  try {
    body = await request.json();
  } catch {
    return respond({ ok: false, error: "invalid JSON body" }, 400);
  }

  const { project, repository } = body;
  const workflow = body.workflow == null || body.workflow === "" ? "" : body.workflow;
  if (typeof project !== "string" || typeof repository !== "string") {
    return respond({ ok: false, error: "project and repository are required" }, 400);
  }
  if (!REPOSITORY_RE.test(repository)) {
    return respond({ ok: false, error: "repository must look like owner/repo" }, 400);
  }
  if (typeof workflow !== "string" || (workflow !== "" && !WORKFLOW_RE.test(workflow))) {
    return respond(
      { ok: false, error: "workflow must be a path like .github/workflows/docs.yml" },
      400
    );
  }

  const auth = await getAuthDb();
  const row = auth.getProjectByName(project);
  if (!row) return respond({ ok: false, error: `no such project: ${project}` }, 404);
  auth.addOidcPublisher(row.id, repository, workflow);
  return respond({ ok: true, publishers: auth.listOidcPublishers() }, 201);
};

export const DELETE: APIRoute = async ({ request }) => {
  let body: { id?: unknown };
  try {
    body = await request.json();
  } catch {
    return respond({ ok: false, error: "invalid JSON body" }, 400);
  }
  if (typeof body.id !== "number") {
    return respond({ ok: false, error: "id (number) is required" }, 400);
  }
  const auth = await getAuthDb();
  if (!auth.deleteOidcPublisher(body.id)) {
    return respond({ ok: false, error: "no such publisher" }, 404);
  }
  return respond({ ok: true, publishers: auth.listOidcPublishers() });
};
