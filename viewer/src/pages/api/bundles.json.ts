// SSR endpoint: live list of ingested bundles.
//
// Walks the BlobStore on every hit (cached per request via getBackends).
// Used by the future hosted service where bundles are added / removed
// out-of-band — and locally by `wrangler dev`, where uploads land in R2
// during a long-running session.

import type { APIRoute } from "astro";
import { listIngestedBundles } from "../../lib/ir-reader.ts";
import { getBackends } from "../../lib/backends.ts";

export const prerender = false;

export const GET: APIRoute = async () => {
  const { blobStore } = await getBackends();
  const bundles = await listIngestedBundles(blobStore);
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
