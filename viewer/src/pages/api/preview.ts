// SSR endpoint: inspect and drop PR preview namespaces.
//
//   GET    /api/preview?id=owner/repo%2342   → { ok, exists, expires_at, bundles }
//   DELETE /api/preview?id=owner/repo%2342   → { ok, dropped }
//
// Authentication mirrors the upload path (`/api/bundle`), because dropping a
// preview is the other half of publishing one:
//
//   - a GitHub Actions OIDC token drops the preview of *its own* pull request
//     (the `id` parameter is ignored — the claims decide), which is what the
//     `drop` mode of the papyri action runs when a PR is merged or closed;
//   - the deployment-wide PAPYRI_UPLOAD_TOKEN, or an admin session cookie,
//     may drop any preview by id.
//
// Dropping is a directory removal plus a registry row delete: a preview never
// wrote into the main graph, so there is nothing to unwind.
import type { APIRoute } from "astro";
import { timingSafeEqual } from "node:crypto";
import { respond } from "../../lib/api-utils.ts";
import { getAuthDb, SESSION_COOKIE } from "../../lib/auth-db.ts";
import { getUploadToken } from "../../lib/backends.ts";
import { makePreviewRef, previewBase, previewId, type PreviewRef } from "../../lib/preview.ts";
import { dropPreview, previewBundles } from "../../lib/preview-store.ts";
import {
  looksLikeJwt,
  oidcEnabled,
  OidcError,
  previewRefFromClaims,
  verifyGithubOidcToken,
  workflowFile,
} from "../../lib/oidc.ts";

export const prerender = false;

/** Parse `owner/repo#42` (or `owner/repo/42`) from the `id` query parameter. */
function refFromQuery(url: URL): PreviewRef | null {
  const raw = url.searchParams.get("id");
  if (!raw) return null;
  const m = /^([^/]+)\/([^/#]+)[#/](\d+)$/.exec(raw);
  return m ? makePreviewRef(m[1]!, m[2]!, m[3]!) : null;
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Resolve which preview the caller is allowed to act on, or a Response
 * explaining why they may not act at all.
 */
async function authorizePreview(
  request: Request,
  url: URL,
  cookieToken: string | undefined
): Promise<PreviewRef | Response> {
  const header = request.headers.get("Authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  const globalToken = await getUploadToken();

  if (bearer && looksLikeJwt(bearer)) {
    if (!oidcEnabled()) {
      return respond({ ok: false, error: "OIDC is disabled on this server" }, 403);
    }
    try {
      const claims = await verifyGithubOidcToken(bearer);
      const ref = previewRefFromClaims(claims);
      if (!ref) {
        return respond(
          {
            ok: false,
            error: `token names no pull request (event_name=${claims.event_name}, ref=${claims.ref})`,
          },
          403
        );
      }
      // Same trust check as the upload path: the repository must be a
      // registered publisher, so an arbitrary repository cannot drive this
      // endpoint even for its own PR numbers.
      const projects = (await getAuthDb()).projectsForRepository(
        claims.repository,
        workflowFile(claims)
      );
      if (projects.length === 0) {
        return respond(
          { ok: false, error: `"${claims.repository}" is not a registered trusted publisher` },
          403
        );
      }
      return ref;
    } catch (err) {
      if (err instanceof OidcError) {
        return respond({ ok: false, error: `OIDC token rejected: ${err.message}` }, 401, {
          "WWW-Authenticate": "Bearer",
        });
      }
      console.error("OIDC verification error:", err);
      return respond({ ok: false, error: "could not verify OIDC token" }, 500);
    }
  }

  const privileged =
    (bearer && globalToken && timingSafeEqualStr(bearer, globalToken)) ||
    (cookieToken ? ((await getAuthDb()).resolveSession(cookieToken)?.is_admin ?? false) : false);
  if (!privileged) {
    return respond({ ok: false, error: "unauthorized" }, 401, { "WWW-Authenticate": "Bearer" });
  }

  const ref = refFromQuery(url);
  if (!ref) {
    return respond({ ok: false, error: "id query param required (owner/repo#42)" }, 400);
  }
  return ref;
}

export const GET: APIRoute = async ({ request, url, cookies }) => {
  const ref = await authorizePreview(request, url, cookies.get(SESSION_COOKIE)?.value);
  if (ref instanceof Response) return ref;

  const record = (await getAuthDb()).getPreview(previewId(ref));
  return respond({
    ok: true,
    id: previewId(ref),
    exists: record !== null,
    expires_at: record?.expires_at ?? null,
    base: previewBase(ref),
    bundles: record ? await previewBundles(ref) : [],
  });
};

export const DELETE: APIRoute = async ({ request, url, cookies }) => {
  const ref = await authorizePreview(request, url, cookies.get(SESSION_COOKIE)?.value);
  if (ref instanceof Response) return ref;

  const dropped = await dropPreview(ref);
  return respond({ ok: true, id: previewId(ref), dropped });
};
