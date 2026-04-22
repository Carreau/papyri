// SSR endpoint: live list of ingested bundles.
//
// This is the first route deliberately marked `prerender = false`. It
// demonstrates that the viewer's build now produces a server bundle that
// can answer requests at runtime, reading the ingest store on demand.
//
// Unlike the SSG landing page (`src/pages/index.astro`), which freezes
// the bundle list at build time, this endpoint walks
// `~/.papyri/ingest/` on every hit. Useful for the future hosted
// service, where bundles are added / removed out-of-band.

import type { APIRoute } from "astro";
import { listIngestedBundles } from "../../lib/ir-reader.ts";

export const prerender = false;

export const GET: APIRoute = async () => {
  const bundles = await listIngestedBundles();
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
