// Per-bundle search manifest.
//
// Emits `/<pkg>/<ver>/search.json` at build time with just the qualname
// labels — deliberately no IR content so the manifest stays small and we
// don't end up duplicating the IR. The `BundleSearch` island fetches one of
// these on mount and does case-insensitive substring matching in the browser.
// Scope is per-bundle, not global: a cross-bundle search would need a
// combined index or a dedicated search page, both out of M5 scope.

import type { APIRoute, GetStaticPaths } from "astro";
import { listIngestedBundles, listModules } from "../../../lib/ir-reader.ts";

export const getStaticPaths: GetStaticPaths = async () => {
  const bundles = await listIngestedBundles();
  return bundles.map((b) => ({
    params: { pkg: b.pkg, ver: b.version },
    props: { bundlePath: b.path },
  }));
};

export const GET: APIRoute = async ({ props }) => {
  const { bundlePath } = props as { bundlePath: string };
  const qualnames = await listModules(bundlePath);
  const body = JSON.stringify({ qualnames });
  return new Response(body, {
    headers: { "Content-Type": "application/json" },
  });
};
