// SSR endpoint: receive a `.papyri` artifact via HTTP PUT and ingest it
// into the cross-link graph store.
//
// The client (`papyri upload`) produces a `.papyri` artifact via
// `papyri pack` and streams it here. The artifact is a gzipped canonical-CBOR
// `Bundle` Node (tag 4070) that carries the entire DocBundle as typed fields.
// We gunzip + cbor-decode it, then hand the in-memory Bundle to the ingest
// pipeline directly — no temporary directory, no fs round-trip.
//
// Two backends are supported, picked at request time:
//
//   • Cloudflare Workers (`wrangler dev` / deployed). The Astro Cloudflare
//     adapter exposes the bound R2 bucket + D1 database via
//     `locals.runtime.env`; we wrap them in `R2BlobStore` + `D1GraphDb` and
//     hand them to the Ingester. Bundle bytes never touch disk.
//
//   • Node SSR (`astro dev` / `pnpm serve`). No runtime env present; the
//     Ingester falls back to its Node defaults (filesystem under
//     `ingestDir()` + better-sqlite3) — same code path as before this
//     refactor.
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
//   500  { ok: false, error }   — backend setup failed (fs / binding error)

import type { APIRoute } from "astro";
import {
  Ingester,
  decode,
  R2BlobStore,
  D1GraphDb,
  type TypedNode,
  type R2BucketLike,
  type D1DatabaseLike,
} from "papyri-ingest";
// Embed the canonical schema SQL at build time so the bundled SSR module
// doesn't need to read it from disk at runtime. Vite inlines the file
// contents as a string via the `?raw` query, which means
// `papyri-ingest`'s on-disk `migrations/0000_init.sql` is the single
// source of truth even after bundling rearranges module locations.
//
// Only used by the Node default backend; D1 has its schema applied via
// `wrangler d1 migrations apply` against the same migrations dir.
import schemaSql from "papyri-ingest/migrations/0000_init.sql?raw";
import { isSafeSegment } from "../../lib/paths.ts";
import { resetGraphDbCache } from "../../lib/graph.ts";

export const prerender = false;

interface WorkersEnv {
  GRAPH_DB?: D1DatabaseLike;
  BLOBS?: R2BucketLike;
}

/**
 * Resolve Cloudflare bindings via the `cloudflare:workers` virtual module.
 *
 * Astro v6 + @astrojs/cloudflare dropped `Astro.locals.runtime.env`; the
 * canonical access is now `import { env } from "cloudflare:workers"`. That
 * module only exists inside the Workers runtime, so we dynamic-import it
 * with `/* @vite-ignore *​/` to keep the Node SSR build from resolving it
 * at bundle time. Returns null under the Node adapter.
 */
async function loadCfEnv(): Promise<WorkersEnv | null> {
  try {
    const mod = (await import(/* @vite-ignore */ "cloudflare:workers")) as {
      env?: WorkersEnv;
    };
    return mod.env ?? null;
  } catch {
    return null;
  }
}

export const PUT: APIRoute = async ({ request }) => {
  if (!request.body) {
    return respond({ ok: false, error: "request body required (.papyri artifact)" }, 400);
  }

  // Pick the ingest backend. Under the Cloudflare adapter `cloudflare:workers`
  // resolves and `env` carries the bindings; under the Node adapter the
  // import fails and we fall back to the Ingester's fs+sqlite defaults.
  const env = await loadCfEnv();
  let ingester: Ingester;
  try {
    if (env?.GRAPH_DB && env.BLOBS) {
      ingester = new Ingester({
        backends: {
          blobStore: new R2BlobStore(env.BLOBS),
          graphDb: new D1GraphDb(env.GRAPH_DB),
        },
      });
    } else {
      ingester = new Ingester({ schemaSql });
    }
  } catch (err) {
    return respond({ ok: false, error: `failed to open ingest backend: ${err}` }, 500);
  }

  // Decode the artifact: gunzip → CBOR → Bundle Node. DecompressionStream is
  // available in both Workers and Node 18+, so this works under either
  // runtime without conditional code.
  let bundle: TypedNode;
  try {
    const decompressed = new Response(request.body.pipeThrough(new DecompressionStream("gzip")));
    const cborBytes = new Uint8Array(await decompressed.arrayBuffer());
    bundle = decode<TypedNode>(cborBytes);
  } catch (err) {
    await ingester.close();
    return respond({ ok: false, error: `failed to decode .papyri artifact: ${err}` }, 422);
  }

  // Path-traversal guard: validate package/version segments before they
  // become R2 keys or fs paths. A hostile artifact could otherwise set
  // ".." or "/" in `bundle.module` / `bundle.version` and escape the
  // ingest namespace.
  const rawPkg = (bundle as Record<string, unknown>)["module"];
  const rawVer = (bundle as Record<string, unknown>)["version"];
  if (typeof rawPkg !== "string" || !rawPkg || !isSafeSegment(rawPkg)) {
    await ingester.close();
    return respond(
      { ok: false, error: `unsafe or missing package name in Bundle: ${JSON.stringify(rawPkg)}` },
      400
    );
  }
  if (typeof rawVer !== "string" || !rawVer || !isSafeSegment(rawVer)) {
    await ingester.close();
    return respond(
      { ok: false, error: `unsafe or missing version in Bundle: ${JSON.stringify(rawVer)}` },
      400
    );
  }

  // Hand the bundle to the ingest pipeline. `ingestBundle` consumes the
  // decoded Bundle directly and writes to whichever blob/graph backend the
  // Ingester was constructed with.
  let pkg: string;
  let version: string;
  try {
    ({ pkg, version } = await ingester.ingestBundle(bundle));
  } catch (err) {
    await ingester.close();
    return respond({ ok: false, error: `ingest failed: ${err}` }, 422);
  }
  await ingester.close();

  // Invalidate the read-only DB handle the rest of the viewer caches so the
  // next request sees the freshly inserted nodes/links. No-op under Workers
  // (the read path doesn't keep a cached handle).
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
