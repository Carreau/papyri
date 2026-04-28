// SSR endpoint: receive a `.papyri` artifact via HTTP PUT and ingest it
// into the cross-link graph store.
//
// The client (`papyri upload`) produces a `.papyri` artifact via
// `papyri pack` and streams it here. The artifact is a gzipped canonical-CBOR
// `Bundle` Node (tag 4070) that carries the entire DocBundle as typed fields.
// We gunzip + cbor-decode it, then hand the in-memory Bundle to the ingest
// pipeline directly — no temporary directory, no fs round-trip.
//
// Backend selection happens in `lib/backends.ts`: same {blobStore, graphDb}
// pair that the read-side pages use, so both halves of the round trip
// agree on where data lives. Under Cloudflare that's R2 + D1; under Node
// it's filesystem + better-sqlite3.
//
// Expected client command:
//   papyri pack ~/.papyri/data/numpy_2.3.5
//   curl -X PUT http://localhost:4321/api/bundle \
//        -H "Content-Type: application/gzip" \
//        --data-binary @numpy-2.3.5.papyri
//
// (or just `papyri upload <bundle_dir-or-.papyri>` which does both steps.)
//
// Responses:
//   201  { ok: true, pkg, version }
//   400  { ok: false, error }   — missing body or bad Bundle metadata
//   422  { ok: false, error }   — gunzip / decode / ingest failed
//   500  { ok: false, error }   — backend setup failed

import type { APIRoute } from "astro";
import { Ingester, decode, type TypedNode } from "papyri-ingest";
import { isSafeSegment } from "../../lib/paths.ts";
import { getBackends } from "../../lib/backends.ts";

export const prerender = false;

export const PUT: APIRoute = async ({ request }) => {
  if (!request.body) {
    return respond({ ok: false, error: "request body required (.papyri artifact)" }, 400);
  }

  let ingester: Ingester;
  try {
    const backends = await getBackends();
    ingester = new Ingester({ backends });
  } catch (err) {
    return respond({ ok: false, error: `failed to open ingest backend: ${err}` }, 500);
  }

  // Decode the artifact: gunzip → CBOR → Bundle Node. DecompressionStream
  // is in Web Streams (Workers + Node 18+), so this is a single code path.
  let bundle: TypedNode;
  try {
    const decompressed = new Response(request.body.pipeThrough(new DecompressionStream("gzip")));
    const cborBytes = new Uint8Array(await decompressed.arrayBuffer());
    bundle = decode<TypedNode>(cborBytes);
  } catch (err) {
    return respond({ ok: false, error: `failed to decode .papyri artifact: ${err}` }, 422);
  }

  // Path-traversal guard: validate package/version segments before they
  // become R2 keys or fs paths. A hostile artifact could otherwise set
  // ".." or "/" in `bundle.module` / `bundle.version` and escape the
  // ingest namespace.
  const rawPkg = (bundle as Record<string, unknown>)["module"];
  const rawVer = (bundle as Record<string, unknown>)["version"];
  if (typeof rawPkg !== "string" || !rawPkg || !isSafeSegment(rawPkg)) {
    return respond(
      { ok: false, error: `unsafe or missing package name in Bundle: ${JSON.stringify(rawPkg)}` },
      400
    );
  }
  if (typeof rawVer !== "string" || !rawVer || !isSafeSegment(rawVer)) {
    return respond(
      { ok: false, error: `unsafe or missing version in Bundle: ${JSON.stringify(rawVer)}` },
      400
    );
  }

  let pkg: string;
  let version: string;
  try {
    ({ pkg, version } = await ingester.ingestBundle(bundle));
  } catch (err) {
    return respond({ ok: false, error: `ingest failed: ${err}` }, 422);
  }
  // Don't close the Ingester — it wraps the shared singleton backends from
  // getBackends() (the SQLite handle in particular is reused by every
  // subsequent read). The Ingester owns no per-request state.

  return respond({ ok: true, pkg, version }, 201);
};

function respond(body: object, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
