// SSR endpoint: receive a pre-ingested bundle via HTTP PUT.
//
// The client tars up an already-ingested bundle directory (the output of
// `papyri ingest`, not the raw gen output) and streams it here.
// The pkg name and version are read from `meta.cbor` inside the archive,
// so the URL carries no path parameters.
//
// Expected client command:
//   tar czf - -C ~/.papyri/ingest/numpy/2.3.5 . \
//     | curl -X PUT http://localhost:4321/api/bundle \
//            -H "Content-Type: application/gzip" \
//            --data-binary @-
//
// Responses:
//   201  { ok: true,  pkg, version, path }
//   400  { ok: false, error }   — missing body or bad meta.cbor
//   422  { ok: false, error }   — tar extraction failed
//   500  { ok: false, error }   — filesystem error

import type { APIRoute } from "astro";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { Decoder } from "cbor-x";
import { ingestDir } from "../../lib/ir-reader.ts";
import { isSafeSegment } from "../../lib/paths.ts";

export const prerender = false;

export const PUT: APIRoute = async ({ request }) => {
  if (!request.body) {
    return respond({ ok: false, error: "request body required (tar.gz of bundle directory)" }, 400);
  }

  // Stage inside the ingest root so rename() stays on the same filesystem.
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
    ({ pkg, version } = await readBundleMeta(tmpDir));
  } catch (err) {
    await rm(tmpDir, { recursive: true, force: true });
    return respond({ ok: false, error: String(err) }, 400);
  }

  const dest = join(root, pkg, version);
  try {
    await mkdir(join(root, pkg), { recursive: true });
    await rm(dest, { recursive: true, force: true });
    await rename(tmpDir, dest);
  } catch (err) {
    await rm(tmpDir, { recursive: true, force: true });
    return respond({ ok: false, error: `cannot install bundle: ${err}` }, 500);
  }

  return respond({ ok: true, pkg, version, path: dest }, 201);
};

// ---------------------------------------------------------------------------

function respond(body: object, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function readBundleMeta(bundleDir: string): Promise<{ pkg: string; version: string }> {
  let decoded: unknown;
  try {
    const raw = await readFile(join(bundleDir, "meta.cbor"));
    const dec = new Decoder({ mapsAsObjects: true });
    decoded = dec.decode(raw);
  } catch (err) {
    throw new Error(`cannot read meta.cbor: ${err}`);
  }

  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new Error("meta.cbor does not contain a map");
  }

  const meta = decoded as Record<string, unknown>;
  const rawPkg = meta["module"];
  const rawVer = meta["version"];

  if (typeof rawPkg !== "string" || !rawPkg) {
    throw new Error("meta.cbor missing 'module' field");
  }
  if (typeof rawVer !== "string" || !rawVer) {
    throw new Error("meta.cbor missing 'version' field");
  }
  if (!isSafeSegment(rawPkg)) {
    throw new Error(`unsafe package name in meta.cbor: ${JSON.stringify(rawPkg)}`);
  }
  if (!isSafeSegment(rawVer)) {
    throw new Error(`unsafe version in meta.cbor: ${JSON.stringify(rawVer)}`);
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
