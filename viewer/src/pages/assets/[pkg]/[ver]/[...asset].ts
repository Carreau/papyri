// Static endpoint that serves files from a bundle's ingest `assets/` dir.
// `linkForRef({kind: "assets"})` renders URLs like
//   /assets/<pkg>/<ver>/<filename>
// and at build time this endpoint is materialised into
//   dist/assets/<pkg>/<ver>/<filename>
// so the viewer can be hosted by any static file server.
//
// Only `assets/` is exposed. `meta/` / `docs/` / `examples/` / `module/` are
// CBOR blobs decoded by the page routes, not linkable resources.
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { APIRoute } from "astro";
import {
  listIngestedBundles,
  type IngestedBundle,
} from "../../../../lib/ir-reader.ts";
import { listFilesRecursive } from "../../../../lib/nav.ts";

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".pdf": "application/pdf",
};

// papyri writes asset filenames like `fig-papyri.examples:example1-0.png`.
// Colons are legal on disk but unsafe in URLs (Astro rejects them as a
// scheme-prefix during output-path generation), so we mirror the qualname
// slug rule and rewrite `:` -> `$` in the URL-facing param. The endpoint
// still reads the underlying file via the unrewritten `filePath` prop.
export function slugifyAssetPath(p: string): string {
  return p.replace(/:/g, "$");
}

export async function getStaticPaths() {
  const bundles: IngestedBundle[] = await listIngestedBundles();
  const paths: Array<{
    params: { pkg: string; ver: string; asset: string };
    props: { filePath: string };
  }> = [];
  for (const b of bundles) {
    const assetDir = join(b.path, "assets");
    const files = await listFilesRecursive(assetDir);
    for (const f of files) {
      paths.push({
        params: { pkg: b.pkg, ver: b.version, asset: slugifyAssetPath(f) },
        props: { filePath: join(assetDir, f) },
      });
    }
  }
  return paths;
}

export const GET: APIRoute = async ({ props }) => {
  const { filePath } = props as { filePath: string };
  const buf = await readFile(filePath);
  const mime = MIME[extname(filePath).toLowerCase()] ?? "application/octet-stream";
  return new Response(new Uint8Array(buf), {
    headers: { "content-type": mime },
  });
};
