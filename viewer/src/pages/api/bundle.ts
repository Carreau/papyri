// SSR endpoint: receive a `.papyri` artifact via HTTP PUT and ingest it
// into the cross-link graph store.
//
// The client (`papyri upload`) produces a `.papyri` artifact via
// `papyri pack` and streams it here. The artifact is a gzipped msgpack
// `Bundle` Node (tag 4070) that carries the entire DocBundle as typed fields.
// We gunzip + msgpack-decode it, then hand the in-memory Bundle to the ingest
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
//     422  { ok: false, error }   — gunzip / msgpack decode failed
//     500  { ok: false, error }   — backend setup failed
//   Once the ingest stream opens we return 200 unconditionally; any
//   downstream failure is reported as an `error` event in the body.

import type { APIRoute } from "astro";
import { Ingester, decode, type TypedNode } from "papyri-ingest";
import { isSafeSegment } from "../../lib/paths.ts";
import { getBackends, getUploadToken } from "../../lib/backends.ts";
import { respond } from "../../lib/api-utils.ts";

export const prerender = false;

export const PUT: APIRoute = async ({ request }) => {
  // Token auth: if PAPYRI_UPLOAD_TOKEN is configured, every PUT must carry
  // "Authorization: Bearer <token>".  When the env var is absent the check is
  // skipped entirely — that's intentional for local development.
  const expectedToken = await getUploadToken();
  if (expectedToken) {
    const auth = request.headers.get("Authorization") ?? "";
    if (auth !== `Bearer ${expectedToken}`) {
      return respond({ ok: false, error: "unauthorized" }, 401, { "WWW-Authenticate": "Bearer" });
    }
  }

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
  // Read the compressed bytes into a buffer first so we can record the
  // on-wire size before decompressing.
  let bundle: TypedNode;
  let bundleSizeBytes = 0;
  try {
    const compressedBuffer = await request.arrayBuffer();
    bundleSizeBytes = compressedBuffer.byteLength;
    const decompressed = new Response(
      new Blob([compressedBuffer]).stream().pipeThrough(new DecompressionStream("gzip"))
    );
    const msgpackBytes = new Uint8Array(await decompressed.arrayBuffer());
    bundle = decode<TypedNode>(msgpackBytes);
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

  // Streaming response: ingest is potentially long-running (D1 / R2 round-
  // trips dominate). Open an NDJSON stream now and emit progress events as
  // the ingest walks the bundle; the client reads line-by-line. This
  // bypasses the Workers per-request console.log buffer, which only flushes
  // when the request ends and therefore makes `wrangler tail` useless for
  // live progress.
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const send = async (event: Record<string, unknown>) => {
    await writer.write(encoder.encode(JSON.stringify(event) + "\n"));
  };

  // Kick the ingest off without awaiting. Workers keeps the worker alive
  // while the response body is being consumed, so this IIFE is allowed to
  // outlive the handler return. Any throw turns into a final `error` event.
  //
  // Note: if the client disconnects mid-stream (Ctrl-C on `papyri upload`,
  // network drop), writer.close() throws and the ingest continues silently
  // to completion. The data still lands consistently — D1 batches stay
  // atomic per `_put`, and the bundles row writes last — but a client
  // cancellation is NOT a server cancellation. If we ever need true
  // cancellation propagation, wire an AbortController through ingestBundle
  // and abort it from the writer's close handler.
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
      const result = await ingester.ingestBundle(
        bundle,
        bundleSizeBytes,
        async (phase, done, total) => {
          await sendWithTiming({ event: "progress", phase, done, total });
        }
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
