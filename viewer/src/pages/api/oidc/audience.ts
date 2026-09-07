// SSR endpoint: the OIDC audience this deployment expects.
//
// GET /api/oidc/audience → { ok: true, audience }
//
// `papyri upload` calls this before asking GitHub Actions for an ID token: the
// token is bound to an audience, and it must be the one this instance checks
// (see `getOidcAudience`). Public by design — the audience is not a secret,
// it is the deployment's own name, and a caller must know it before it can
// even attempt an upload. Mirrors PyPI's `/_/oidc/audience`.

import type { APIRoute } from "astro";
import { getOidcAudience } from "../../../lib/github-oidc.ts";
import { respond } from "../../../lib/api-utils.ts";

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  return respond({ ok: true, audience: getOidcAudience(request.url) });
};
