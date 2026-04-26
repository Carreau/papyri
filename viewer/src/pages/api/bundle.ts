// SSR endpoint: receive a raw `papyri gen` bundle via HTTP PUT and ingest it
// into the cross-link graph store.
//
// The client tars up a gen bundle directory (the output of `papyri gen`,
// typically `~/.papyri/data/<pkg>_<version>/`) and streams it here. The
// `papyri.json` file inside the archive identifies the package and version,
// so the URL carries no path parameters.
//
// This endpoint is the network-callable replacement for the local
// `papyri-ingest` / `papyri ingest` CLI: it runs the same ingest pipeline
// (the sibling `ingest/` workspace package) directly against the uploaded
// bundle, so maintainers don't need a local ingest step before uploading.
//
// Expected client command:
//   tar czf - -C ~/.papyri/data/numpy_2.3.5 . \
//     | curl -X PUT http://localhost:4321/api/bundle \
//            -H "Content-Type: application/gzip" \
//            --data-binary @-
//
// Responses:
//   201  { ok: true, pkg, version }
//   400  { ok: false, error }   — missing body or bad papyri.json
//   422  { ok: false, error }   — tar extraction or ingest failed
//   500  { ok: false, error }   — filesystem error before ingest started

import type { APIRoute } from "astro";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { Ingester } from "papyri-ingest";
import { ingestDir } from "../../lib/ir-reader.ts";
import { isSafeSegment } from "../../lib/paths.ts";
import { resetGraphDbCache } from "../../lib/graph.ts";

export const prerender = false;

export const PUT: APIRoute = async ({ request }) => {
  if (!request.body) {
    return respond({ ok: false, error: "request body required (tar.gz of gen bundle)" }, 400);
  }

  // Stage inside the ingest root so the temp dir lives next to the final
  // destination (avoids cross-filesystem surprises if the ingest dir is on a
  // separate volume).
  const root = ingestDir();
  const tmpDir = join(root, `.ingest-tmp-${randomUUID()}`);

  try {
    await mkdir(tmpDir, { recursive: true });
  } catch (err) {
    return respond({ ok: false, error: `cannot create staging directory: ${err}` }, 500);
  }

  try {
    await extractTarGz(request.body, tmpDir);
  } catch (err) {
    await rm(tmpDir, { recursive: true, force: true });
    return respond({ ok: false, error: `extraction failed: ${err}` }, 422);
  }

  let pkg: string;
  let version: string;
  try {
    ({ pkg, version } = await readGenMeta(tmpDir));
  } catch (err) {
    await rm(tmpDir, { recursive: true, force: true });
    return respond({ ok: false, error: String(err) }, 400);
  }

  // Run the ingest pipeline. Ingester writes blobs + graph entries directly
  // into the ingest store under `<ingestDir>/<pkg>/<version>/`, so once it
  // returns the staging dir is disposable.
  const ingester = new Ingester({ ingestDir: root });
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

async function readGenMeta(bundleDir: string): Promise<{ pkg: string; version: string }> {
  let raw: string;
  try {
    raw = await readFile(join(bundleDir, "papyri.json"), "utf8");
  } catch (err) {
    throw new Error(`cannot read papyri.json: ${err}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`papyri.json is not valid JSON: ${err}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("papyri.json does not contain an object");
  }

  const meta = parsed as Record<string, unknown>;
  const rawPkg = meta["module"];
  const rawVer = meta["version"];

  if (typeof rawPkg !== "string" || !rawPkg) {
    throw new Error("papyri.json missing 'module' field");
  }
  if (typeof rawVer !== "string" || !rawVer) {
    throw new Error("papyri.json missing 'version' field");
  }
  if (!isSafeSegment(rawPkg)) {
    throw new Error(`unsafe package name in papyri.json: ${JSON.stringify(rawPkg)}`);
  }
  if (!isSafeSegment(rawVer)) {
    throw new Error(`unsafe version in papyri.json: ${JSON.stringify(rawVer)}`);
  }

  return { pkg: rawPkg, version: rawVer };
}

async function extractTarGz(body: ReadableStream<Uint8Array>, dest: string): Promise<void> {
  const child = spawn("tar", ["xz", "--no-same-owner", "-C", dest], {
    stdio: ["pipe", "ignore", "pipe"],
  });

  const stderrChunks: Buffer[] = [];
  child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

  const done = new Promise<void>((resolve, reject) => {
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        const msg = Buffer.concat(stderrChunks).toString().trim();
        reject(new Error(`tar exited with code ${code}: ${msg}`));
      }
    });
    child.on("error", (err) => reject(new Error(`failed to spawn tar: ${err.message}`)));
  });

  // body is a WHATWG ReadableStream; Readable.fromWeb converts it to a Node
  // Readable so pipeline() can handle backpressure correctly.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await pipeline(Readable.fromWeb(body as any), child.stdin!);
  await done;
}
