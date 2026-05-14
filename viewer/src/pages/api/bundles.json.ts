// SSR endpoint: live list of ingested bundles.
//
// Queries the bundles table on every hit (cached per request via getBackends).
// Used by the future hosted service where bundles are added / removed
// out-of-band — and locally by `wrangler dev`, where uploads land in R2
// during a long-running session.

import type { APIRoute } from "astro";
import { listBundlesFromDb } from "../../lib/ir-reader.ts";
import { getBackends } from "../../lib/backends.ts";

export const prerender = false;

export const GET: APIRoute = async () => {
  const { graphDb } = await getBackends();
  const bundles = await listBundlesFromDb(graphDb);
  const body = JSON.stringify({
    bundles: bundles.map((b) => ({ pkg: b.pkg, version: b.version })),
  });
  return new Response(body, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
};
