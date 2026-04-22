// SSR endpoint: cross-bundle search.
//
// Complements the per-bundle static `search.json` manifests
// (`src/pages/[pkg]/[ver]/search.json.ts`) by answering *global* queries
// at request time. The static manifests stay because they let a bundle
// page work offline / on a pure-SSG deploy; this endpoint is what a
// future hosted service uses to search across every ingested package.
//
// Query params:
//   q      — required, substring to match (case-insensitive)
//   limit  — optional, defaults to 50
//
// Response shape:
//   { hits: Array<{ pkg, version, qualname, href }> }
//
// Deliberately simple: no ranking, no fuzzy, no scoring. Swappable for
// a real index (fts5 over `papyri.db`, or a client-side lunr build) once
// we know the shape of the query load.

import type { APIRoute } from "astro";
import { linkForRef, listIngestedBundles, listModules } from "../../lib/ir-reader.ts";
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

  const bundles = await listIngestedBundles();
  const hits: Array<{ pkg: string; version: string; qualname: string; href: string }> = [];

  for (const b of bundles) {
    if (hits.length >= limit) break;
    const qualnames = await listModules(b.path);
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
