// SSR endpoint: receive a `.papyri` artifact via HTTP PUT and ingest it
// into the cross-link graph store.
//
// The client (`papyri upload`) produces a `.papyri` artifact via
// `papyri pack` and streams it here. The artifact is a gzipped canonical-CBOR
// `Bundle` Node (tag 4070) that carries the entire DocBundle as typed fields.
// We gunzip + cbor-decode it, materialise its contents back to a per-file
// directory tree (the layout `papyri gen` writes natively), and run the same
// `Ingester` pipeline against that staging dir.
//
// This is the network-callable replacement for the local
// `papyri-ingest` / `papyri ingest` CLI: the ingest pipeline (the sibling
// `ingest/` workspace package) runs server-side, so maintainers don't need a
// local ingest step before uploading.
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
//   500  { ok: false, error }   — filesystem error before ingest started

import type { APIRoute } from "astro";
import { mkdir, rm } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Ingester, decode, explodeBundleToDir, type TypedNode } from "papyri-ingest";
// Embed the canonical schema SQL at build time so the bundled SSR module
// doesn't need to read it from disk at runtime. Vite inlines the file
// contents as a string via the `?raw` query, which means
// `papyri-ingest`'s on-disk `migrations/0000_init.sql` is the single
// source of truth even after bundling rearranges module locations.
import schemaSql from "papyri-ingest/migrations/0000_init.sql?raw";
import { ingestDir } from "../../lib/ir-reader.ts";
import { isSafeSegment } from "../../lib/paths.ts";
import { resetGraphDbCache } from "../../lib/graph.ts";

export const prerender = false;

export const PUT: APIRoute = async ({ request }) => {
  if (!request.body) {
    return respond({ ok: false, error: "request body required (.papyri artifact)" }, 400);
  }

  const root = ingestDir();
  const tmpDir = join(root, `.ingest-tmp-${randomUUID()}`);

  try {
    await mkdir(tmpDir, { recursive: true });
  } catch (err) {
    return respond({ ok: false, error: `cannot create staging directory: ${err}` }, 500);
  }

  // Decode the artifact: gunzip → CBOR → Bundle Node.
  let bundle: TypedNode;
  try {
    const gzipped = new Uint8Array(await request.arrayBuffer());
    const cborBytes = gunzipSync(gzipped);
    bundle = decode<TypedNode>(cborBytes);
  } catch (err) {
    await rm(tmpDir, { recursive: true, force: true });
    return respond({ ok: false, error: `failed to decode .papyri artifact: ${err}` }, 422);
  }

  // Materialise the Bundle to a directory tree the Ingester understands.
  let pkg: string;
  let version: string;
  try {
    await explodeBundleToDir(bundle, tmpDir);
    ({ pkg, version } = readBundleMeta(bundle));
  } catch (err) {
    await rm(tmpDir, { recursive: true, force: true });
    return respond({ ok: false, error: String(err) }, 400);
  }

  // Run the ingest pipeline. Ingester writes blobs + graph entries directly
  // into the ingest store under `<ingestDir>/<pkg>/<version>/`, so once it
  // returns the staging dir is disposable.
  const ingester = new Ingester({ ingestDir: root, schemaSql });
  try {
    ingester.ingest(tmpDir);
  } catch (err) {
    ingester.close();
    await rm(tmpDir, { recursive: true, force: true });
    return respond({ ok: false, error: `ingest failed: ${err}` }, 422);
  }
  ingester.close();
  await rm(tmpDir, { recursive: true, force: true });

  // Invalidate the read-only DB handle the rest of the viewer caches so the
  // next request sees the freshly inserted nodes/links.
  resetGraphDbCache();

  return respond({ ok: true, pkg, version }, 201);
};

// ---------------------------------------------------------------------------

function respond(body: object, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function readBundleMeta(bundle: TypedNode): { pkg: string; version: string } {
  const rawPkg = (bundle as Record<string, unknown>)["module"];
  const rawVer = (bundle as Record<string, unknown>)["version"];

  if (typeof rawPkg !== "string" || !rawPkg) {
    throw new Error("Bundle missing 'module' field");
  }
  if (typeof rawVer !== "string" || !rawVer) {
    throw new Error("Bundle missing 'version' field");
  }
  if (!isSafeSegment(rawPkg)) {
    throw new Error(`unsafe package name in Bundle: ${JSON.stringify(rawPkg)}`);
  }
  if (!isSafeSegment(rawVer)) {
    throw new Error(`unsafe version in Bundle: ${JSON.stringify(rawVer)}`);
  }

  return { pkg: rawPkg, version: rawVer };
}
