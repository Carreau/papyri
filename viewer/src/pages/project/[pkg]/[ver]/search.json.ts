// Per-bundle search manifest.
//
// Returns just the qualname labels for a bundle — deliberately no IR
// content so the manifest stays small. The `BundleSearch` island fetches
// one of these on mount and does case-insensitive substring matching in
// the browser. Scope is per-bundle, not global; cross-bundle search lives
// at `/api/search.json`.

import type { APIRoute } from "astro";
import { listModules, resolveVersion } from "../../../../lib/ir-reader.ts";
import { getBackends } from "../../../../lib/backends.ts";
import { respond } from "../../../../lib/api-utils.ts";

export const prerender = false;

export const GET: APIRoute = async ({ params }) => {
  const { pkg, ver } = params;
  if (!pkg || !ver) {
    return respond({ error: "Bundle not found" }, 404);
  }
  const { blobStore, graphDb } = await getBackends();
  const actualVer = await resolveVersion(graphDb, pkg, ver);
  if (!actualVer) return respond({ error: `Package ${pkg} not found` }, 404);
  const qualnames = await listModules(blobStore, pkg, actualVer);
  return respond({ qualnames });
};
