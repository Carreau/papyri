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
// pair that the read-side pages use (filesystem + better-sqlite3).
//
// Expected client command:
//   papyri pack ~/.papyri/data/numpy_2.3.5
//   curl -X PUT http://localhost:4321/api/bundle \
//        -H "Content-Type: application/gzip" \
//        --data-binary @numpy-2.3.5.papyri
//
// (or just `papyri upload <bundle_dir-or-.papyri>` which does both steps.)
//
// Response contract:
//   The success path returns 200 with Content-Type application/x-ndjson:
//   a streaming sequence of one JSON object per line. The client must read
//   the body to determine outcome — the final line is either `{"event":
//   "done", "pkg":..., "version":...}` or `{"event":"error","error":...}`.
//   On Cloudflare Workers `console.log` is buffered until the request ends,
//   so this stream is the only way to give the client live progress on
//   long ingests.
//
//   Pre-stream errors that we can resolve before hitting the wire still
//   come back as buffered JSON with the appropriate status code:
//     401  { ok: false, error }   — missing/invalid bearer token
//     400  { ok: false, error }   — missing body or bad Bundle metadata
//     422  { ok: false, error }   — gunzip / cbor decode failed
//     500  { ok: false, error }   — backend setup failed
//   Once the ingest stream opens we return 200 unconditionally; any
//   downstream failure is reported as an `error` event in the body.

import type { APIRoute } from "astro";
import { Ingester, decode, type TypedNode } from "papyri-ingest";
import { isSafeSegment } from "../../lib/paths.ts";
import { getBackends, getUploadToken } from "../../lib/backends.ts";
import { respond, sha256Hex } from "../../lib/api-utils.ts";

export const prerender = false;

// Shared bearer-token gate for both PUT (upload) and GET (existence check).
// When PAPYRI_UPLOAD_TOKEN is unset the check is skipped — intentional for
// local development. Returns a 401 Response when the token is required and
// missing/wrong, or null when the request may proceed.
async function checkAuth(request: Request): Promise<Response | null> {
  const expectedToken = await getUploadToken();
  if (!expectedToken) return null;
  const auth = request.headers.get("Authorization") ?? "";
  if (auth !== `Bearer ${expectedToken}`) {
    return respond({ ok: false, error: "unauthorized" }, 401, { "WWW-Authenticate": "Bearer" });
  }
  return null;
}

// Existence check for `papyri upload`'s dedup step. The client computes the
// SHA-256 of the .papyri artifact it is about to send and asks whether the
// server already holds that exact content for (module, version). When it
// does, the client skips the upload entirely. Failing open (any error → the
// client uploads anyway) is the responsibility of the client.
export const GET: APIRoute = async ({ request, url }) => {
  const authFail = await checkAuth(request);
  if (authFail) return authFail;

  const module = url.searchParams.get("module");
  const version = url.searchParams.get("version");
  const hash = url.searchParams.get("hash");
  if (!module || !version) {
    return respond({ ok: false, error: "module and version query params required" }, 400);
  }

  let backends: Awaited<ReturnType<typeof getBackends>>;
  try {
    backends = await getBackends();
  } catch (err) {
    return respond({ ok: false, error: `failed to open ingest backend: ${err}` }, 500);
  }

  const row = await backends.graphDb.get<{ content_hash: string | null }>(
    "SELECT content_hash FROM bundles WHERE module = ? AND version = ?",
    [module, version]
  );
  const storedHash = row?.content_hash ?? null;
  // With a hash supplied, "exists" means identical content already ingested.
  // Without one, it degrades to "is this (module, version) present at all".
  const exists = hash ? storedHash !== null && storedHash === hash : row !== null;
  return respond({ ok: true, module, version, stored_hash: storedHash, exists });
};

export const PUT: APIRoute = async ({ request }) => {
  // Token auth: if PAPYRI_UPLOAD_TOKEN is configured, every PUT must carry
  // "Authorization: Bearer <token>".  When the env var is absent the check is
  // skipped entirely — that's intentional for local development.
  const authFail = await checkAuth(request);
  if (authFail) return authFail;

  if (!request.body) {
    return respond({ ok: false, error: "request body required (.papyri artifact)" }, 400);
  }

  let ingester: Ingester;
  let backends: Awaited<ReturnType<typeof getBackends>>;
  try {
    backends = await getBackends();
    ingester = new Ingester({ backends });
  } catch (err) {
    return respond({ ok: false, error: `failed to open ingest backend: ${err}` }, 500);
  }

  // Decode the artifact: gunzip → CBOR → Bundle Node. DecompressionStream
  // is in Web Streams (Workers + Node 18+), so this is a single code path.
  // Read the compressed bytes into a buffer first so we can record the
  // on-wire size before decompressing. The raw compressed bytes are kept for
  // archiving to rawStore before ingest runs.
  let bundle: TypedNode;
  let bundleSizeBytes = 0;
  let compressedBytes: Uint8Array;
  try {
    const compressedBuffer = await request.arrayBuffer();
    bundleSizeBytes = compressedBuffer.byteLength;
    compressedBytes = new Uint8Array(compressedBuffer);
    // Use the original ArrayBuffer (not the Uint8Array view) so TypeScript
    // accepts it as a BlobPart — Blob rejects Uint8Array<ArrayBufferLike>.
    const decompressed = new Response(
      new Blob([compressedBuffer]).stream().pipeThrough(new DecompressionStream("gzip"))
    );
    const cborBytes = new Uint8Array(await decompressed.arrayBuffer());
    bundle = decode<TypedNode>(cborBytes);
  } catch (err) {
    return respond({ ok: false, error: `failed to decode .papyri artifact: ${err}` }, 422);
  }

  // Path-traversal guard: validate package/version segments before they
  // become fs paths. A hostile artifact could otherwise set ".." or "/"
  // in `bundle.module` / `bundle.version` and escape the ingest namespace.
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

  // Streaming response: ingest is potentially long-running. Open an NDJSON
  // stream now and emit progress events as the ingest walks the bundle; the
  // client reads line-by-line.
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const send = async (event: Record<string, unknown>) => {
    await writer.write(encoder.encode(JSON.stringify(event) + "\n"));
  };

  // Kick the ingest off without awaiting. The response stream keeps the
  // connection alive; any throw turns into a final `error` event.
  //
  // Note: if the client disconnects mid-stream, writer.close() throws and
  // the ingest continues silently to completion. Client cancellation is NOT
  // server cancellation.
  // Timing decoration: each event is enriched with `elapsed_s` (since the
  // stream opened) and `since_last_ms` (since the previous event) so the
  // client can render live wall-time stats. console.log inside the worker
  // is buffered until request end, so the stream is the only way to
  // surface per-chunk timings during a long ingest.
  const startedAt = Date.now();
  let prevEventAt = startedAt;
  const sendWithTiming = async (event: Record<string, unknown>) => {
    const now = Date.now();
    await send({
      ...event,
      elapsed_s: ((now - startedAt) / 1000).toFixed(2),
      since_last_ms: now - prevEventAt,
    });
    prevEventAt = now;
  };

  (async () => {
    try {
      await sendWithTiming({ event: "start", pkg: rawPkg, version: rawVer });
      // Archive the raw compressed bundle before ingest. Failure is non-fatal:
      // the ingest proceeds and the warning is surfaced in the stream. The raw
      // archive exists solely for future reingest; missing it doesn't corrupt
      // the processed store.
      try {
        await backends.rawStore.put(rawPkg, rawVer, compressedBytes);
      } catch (archiveErr) {
        await sendWithTiming({
          event: "warning",
          message: `raw archive write failed: ${archiveErr}`,
        });
      }
      // Content hash of the artifact as received — stored in the bundles row
      // so a later `papyri upload` of identical bytes can be skipped via the
      // GET existence check above.
      const contentHash = await sha256Hex(compressedBytes);
      const result = await ingester.ingestBundle(
        bundle,
        bundleSizeBytes,
        async (phase, done, total) => {
          await sendWithTiming({ event: "progress", phase, done, total });
        },
        contentHash
      );
      await sendWithTiming({ event: "done", pkg: result.pkg, version: result.version });
    } catch (err) {
      await sendWithTiming({ event: "error", error: `ingest failed: ${err}` });
    } finally {
      try {
        await writer.close();
      } catch {
        /* writer already closed (e.g. client disconnect); nothing to do. */
      }
    }
  })();

  return new Response(readable, {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-store",
      // Disable response buffering on intermediaries that honor it. The
      // worker emits one line per progress event; without this some
      // proxies coalesce until the connection closes.
      "X-Accel-Buffering": "no",
    },
  });
};
