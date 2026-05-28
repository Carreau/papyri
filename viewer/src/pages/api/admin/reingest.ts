// SSR endpoint: re-ingest one or all bundles from the raw archive.
//
// Every bundle accepted by PUT /api/admin/bundle is archived verbatim in rawStore
// before ingest runs. This endpoint replays those raw bytes through a fresh
// ingest run — useful when the ingest schema changes, a pipeline bug is fixed,
// or the processed store (BlobStore + GraphDb) needs to be rebuilt from
// scratch without asking maintainers to re-upload.
//
// Method: POST (a trigger, not idempotent PUT)
//
// Optional query params:
//   ?pkg=<name>          reingest all versions of one package
//   ?pkg=<name>&ver=<v>  reingest exactly one (pkg, version)
//   (no params)          reingest every archived bundle
//
// Auth: an admin action — authorized by the session-cookie middleware (the
// route is not in middleware.ts's PUBLIC_PREFIXES, so only a logged-in admin
// can reach it).
//
// Response contract: 200 application/x-ndjson stream.
// One JSON object per line. Final line is either:
//   {"event":"done","count":<n>,"total":<n>,...}
// or:
//   {"event":"error","error":...}
// Non-fatal per-bundle failures are emitted as "warning" events so the
// stream continues with remaining bundles.

import type { APIRoute } from "astro";
import { Ingester, decode, type TypedNode } from "papyri-ingest";
import { isSafeSegment } from "../../../lib/paths.ts";
import { getBackends } from "../../../lib/backends.ts";
import { respond, sha256Hex } from "../../../lib/api-utils.ts";

export const prerender = false;

export const POST: APIRoute = async ({ url }) => {
  const pkg = url.searchParams.get("pkg") ?? undefined;
  const ver = url.searchParams.get("ver") ?? undefined;

  if (pkg !== undefined && !isSafeSegment(pkg)) {
    return respond({ ok: false, error: `unsafe pkg query param: ${JSON.stringify(pkg)}` }, 400);
  }
  if (ver !== undefined && !isSafeSegment(ver)) {
    return respond({ ok: false, error: `unsafe ver query param: ${JSON.stringify(ver)}` }, 400);
  }
  if (ver !== undefined && pkg === undefined) {
    return respond({ ok: false, error: "ver requires pkg" }, 400);
  }

  let backends: Awaited<ReturnType<typeof getBackends>>;
  try {
    backends = await getBackends();
  } catch (err) {
    return respond({ ok: false, error: `failed to open backends: ${err}` }, 500);
  }

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const send = async (event: Record<string, unknown>) => {
    await writer.write(encoder.encode(JSON.stringify(event) + "\n"));
  };

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
      let entries = await backends.rawStore.list();

      if (pkg) {
        entries = entries.filter((e) => e.pkg === pkg);
        if (ver) entries = entries.filter((e) => e.ver === ver);
      }

      if (entries.length === 0) {
        await sendWithTiming({
          event: "done",
          count: 0,
          total: 0,
          message: "no matching bundles in raw archive",
        });
        return;
      }

      await sendWithTiming({ event: "start", total: entries.length });

      let doneCount = 0;
      for (const entry of entries) {
        const compressedBytes = await backends.rawStore.get(entry.pkg, entry.ver);
        if (!compressedBytes) {
          await sendWithTiming({
            event: "warning",
            pkg: entry.pkg,
            ver: entry.ver,
            message: "raw archive entry missing",
          });
          continue;
        }

        let bundle: TypedNode;
        try {
          // Copy into a fresh ArrayBuffer so Blob accepts it as BlobPart.
          // RawStore.get() may return a Uint8Array backed by ArrayBufferLike
          // (e.g. a Node Buffer); Blob rejects Uint8Array<ArrayBufferLike>.
          const rawBuf = new ArrayBuffer(compressedBytes.byteLength);
          new Uint8Array(rawBuf).set(compressedBytes);
          const decompressed = new Response(
            new Blob([rawBuf]).stream().pipeThrough(new DecompressionStream("gzip"))
          );
          const cborBytes = new Uint8Array(await decompressed.arrayBuffer());
          bundle = decode<TypedNode>(cborBytes);
        } catch (err) {
          await sendWithTiming({
            event: "warning",
            pkg: entry.pkg,
            ver: entry.ver,
            message: `decode failed: ${err}`,
          });
          continue;
        }

        const ingester = new Ingester({ backends });
        try {
          const result = await ingester.ingestBundle(
            bundle,
            compressedBytes.byteLength,
            async (phase, done, total) => {
              await sendWithTiming({
                event: "progress",
                pkg: entry.pkg,
                ver: entry.ver,
                phase,
                done,
                total,
              });
            },
            await sha256Hex(compressedBytes)
          );
          doneCount++;
          await sendWithTiming({
            event: "ingested",
            pkg: result.pkg,
            version: result.version,
            n: doneCount,
            of: entries.length,
          });
        } catch (err) {
          await sendWithTiming({
            event: "warning",
            pkg: entry.pkg,
            ver: entry.ver,
            message: `ingest failed: ${err}`,
          });
        }
      }

      await sendWithTiming({ event: "done", count: doneCount, total: entries.length });
    } catch (err) {
      await sendWithTiming({ event: "error", error: String(err) });
    } finally {
      try {
        await writer.close();
      } catch {
        /* already closed (client disconnect) */
      }
    }
  })();

  return new Response(readable, {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
};
