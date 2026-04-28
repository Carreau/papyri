// SSR endpoint: cross-bundle qualname search.
//
// Substring match against every ingested bundle's qualname list.
// Deliberately simple — no ranking, no fuzzy. Swappable for a real index
// (fts5 / D1 fts) once we know the query load.

import type { APIRoute } from "astro";
import { listIngestedBundles, listModules } from "../../lib/ir-reader.ts";
import { getBackends } from "../../lib/backends.ts";
import { linkForRef } from "../../lib/links.ts";
import { filterQualnames } from "../../lib/search.ts";

export const prerender = false;

export const GET: APIRoute = async ({ url }) => {
  const q = url.searchParams.get("q") ?? "";
  const limitRaw = url.searchParams.get("limit");
  const limit = Math.max(1, Math.min(500, Number(limitRaw) || 50));

  if (q.trim() === "") {
    return new Response(JSON.stringify({ hits: [] }), {
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }

  const { blobStore } = await getBackends();
  const bundles = await listIngestedBundles(blobStore);
  const hits: Array<{ pkg: string; version: string; qualname: string; href: string }> = [];

  for (const b of bundles) {
    if (hits.length >= limit) break;
    const qualnames = await listModules(blobStore, b.pkg, b.version);
    const perBundle = filterQualnames(qualnames, q, limit - hits.length);
    for (const hit of perBundle) {
      const href = linkForRef({
        pkg: b.pkg,
        ver: b.version,
        kind: "module",
        path: hit.qualname,
      });
      if (!href) continue;
      hits.push({ pkg: b.pkg, version: b.version, qualname: hit.qualname, href });
    }
  }

  return new Response(JSON.stringify({ hits }), {
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
};
