// SSR endpoint: cross-bundle qualname search.
//
// Substring match against every ingested bundle's qualname list.
// Deliberately simple — no ranking, no fuzzy. Swappable for a real index
// (fts5) once we know the query load.
//
// All qualnames are fetched from the SQL graph DB in a single query so the
// handler doesn't fan out to one BlobStore list call per bundle.

import type { APIRoute } from "astro";
import { getBackends } from "../../lib/backends.ts";
import { linkForRef } from "../../lib/links.ts";
import { filterQualnames } from "../../lib/search.ts";
import { respond } from "../../lib/api-utils.ts";

export const prerender = false;

export const GET: APIRoute = async ({ url }) => {
  const q = url.searchParams.get("q") ?? "";
  const limitRaw = url.searchParams.get("limit");
  const limit = Math.max(1, Math.min(500, Number(limitRaw) || 50));

  if (q.trim() === "") {
    return respond({ hits: [] }, 200, { "Cache-Control": "no-store" });
  }

  const { graphDb } = await getBackends();

  // Fetch all ingested qualnames in one query rather than one BlobStore.list()
  // per bundle.  The nodes table is indexed on (package, category, identifier),
  // so this is a single index scan regardless of bundle count.
  const rows = await graphDb.all<{ package: string; version: string; identifier: string }>(
    "SELECT package, version, identifier FROM nodes WHERE category='module' AND has_blob=1 ORDER BY package, version, identifier",
    []
  );

  // Group by (pkg, version) and filter qualnames per bundle, stopping at limit.
  type BundleKey = `${string}/${string}`;
  const byBundle = new Map<BundleKey, { pkg: string; version: string; qualnames: string[] }>();
  for (const r of rows) {
    const key: BundleKey = `${r.package}/${r.version}`;
    let entry = byBundle.get(key);
    if (!entry) {
      entry = { pkg: r.package, version: r.version, qualnames: [] };
      byBundle.set(key, entry);
    }
    entry.qualnames.push(r.identifier);
  }

  const hits: Array<{ pkg: string; version: string; qualname: string; href: string }> = [];
  for (const b of byBundle.values()) {
    if (hits.length >= limit) break;
    const perBundle = filterQualnames(b.qualnames, q, limit - hits.length);
    for (const hit of perBundle) {
      const href = linkForRef({ pkg: b.pkg, ver: b.version, kind: "module", path: hit.qualname });
      if (!href) continue;
      hits.push({ pkg: b.pkg, version: b.version, qualname: hit.qualname, href });
    }
  }

  return respond({ hits }, 200, { "Cache-Control": "no-store" });
};
