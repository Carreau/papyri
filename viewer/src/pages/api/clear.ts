// SSR endpoint: empty the processed store in preparation for a re-ingest.
//
// Drops every row from the graph DB (nodes, links, bundles) and removes every
// processed blob (per-bundle blob trees + meta.cbor) from the blob store. The
// raw archive (RawStore, `_raw/`) is left untouched — re-ingest replays from
// it.
//
// Method: POST (a trigger, not idempotent PUT)
// Auth:   an admin action — authorized by the session-cookie middleware
//         (the route is not in middleware.ts's PUBLIC_PREFIXES, so only a
//         logged-in admin can reach it).
// Response: JSON { ok, deletedBlobs, elapsed_s } on success.

import type { APIRoute } from "astro";
import { getBackends } from "../../lib/backends.ts";
import { respond } from "../../lib/api-utils.ts";

export const prerender = false;

export const POST: APIRoute = async () => {
  const startedAt = Date.now();
  try {
    const backends = await getBackends();
    await backends.graphDb.clear();
    const deletedBlobs = await backends.blobStore.clear();
    return respond({
      ok: true,
      deletedBlobs,
      elapsed_s: ((Date.now() - startedAt) / 1000).toFixed(2),
    });
  } catch (err) {
    return respond({ ok: false, error: String(err) }, 500);
  }
};
