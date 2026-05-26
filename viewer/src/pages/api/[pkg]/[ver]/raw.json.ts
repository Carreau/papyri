// SSR endpoint: return the decoded IR for a single page blob as JSON.
//
// Backs the "Raw JSON" link on the module / docs / examples pages. Loads
// `<pkg>/<ver>/<kind>/<path>` from the blob store, CBOR-decodes it, and
// serves the IR tree pretty-printed so it is readable in any browser.
//
// Query params:
//   kind  — one of "module", "docs", "examples" (the blob kinds that back
//           a rendered page).
//   path  — the blob path: qualname for module pages, doc/example path
//           (with ":" separators) for docs/examples.

import type { APIRoute } from "astro";
import { decodeCborBytes, resolveVersion } from "../../../../lib/ir-reader.ts";
import { getBackends } from "../../../../lib/backends.ts";
import { respond } from "../../../../lib/api-utils.ts";

export const prerender = false;

const ALLOWED_KINDS = new Set(["module", "docs", "examples"]);

export const GET: APIRoute = async ({ params, url }) => {
  const { pkg, ver } = params;
  const kind = url.searchParams.get("kind");
  const path = url.searchParams.get("path");
  if (!pkg || !ver || !kind || !path) {
    return respond({ error: "Missing pkg, ver, kind, or path" }, 400);
  }
  if (!ALLOWED_KINDS.has(kind)) {
    return respond({ error: `Unsupported kind: ${kind}` }, 400);
  }

  const { blobStore, graphDb } = await getBackends();
  const actualVer = await resolveVersion(graphDb, pkg, ver);
  if (!actualVer) return respond({ error: `Package ${pkg} not found` }, 404);

  // The gen→ingest path writes module/<qualname> without a suffix; older or
  // alternate writers used .cbor. Try both (mirrors loadModule).
  let bytes = await blobStore.get({ module: pkg, version: actualVer, kind, path });
  if (!bytes) {
    bytes = await blobStore.get({ module: pkg, version: actualVer, kind, path: `${path}.cbor` });
  }
  if (!bytes) return respond({ error: `Not found: ${kind}/${path}` }, 404);

  const obj = decodeCborBytes(bytes);
  return new Response(JSON.stringify(obj, null, 2), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
};
