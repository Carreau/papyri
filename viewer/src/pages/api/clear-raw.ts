// SSR endpoint: drop every bundle from the raw archive.
//
// Removes every `_raw/<pkg>/<ver>.papyri.gz` entry from the RawStore. This is
// destructive: once the raw archive is empty, re-ingest can no longer replay
// from local state and maintainers must re-upload bundles. The processed
// store (BlobStore + GraphDb) is left untouched — pair this with
// POST /api/clear to also drop the processed side.
//
// Method: POST (a trigger, not idempotent PUT)
// Auth:   an admin action — authorized by the session-cookie middleware
//         (the route is not in middleware.ts's PUBLIC_PREFIXES, so only a
//         logged-in admin can reach it).
// Response: JSON { ok, deletedBundles, elapsed_s } on success.

import type { APIRoute } from "astro";
import { getBackends } from "../../lib/backends.ts";
import { respond } from "../../lib/api-utils.ts";

export const prerender = false;

export const POST: APIRoute = async () => {
  const startedAt = Date.now();
  try {
    const backends = await getBackends();
    const deletedBundles = await backends.rawStore.clear();
    return respond({
      ok: true,
      deletedBundles,
      elapsed_s: ((Date.now() - startedAt) / 1000).toFixed(2),
    });
  } catch (err) {
    return respond({ ok: false, error: String(err) }, 500);
  }
};
