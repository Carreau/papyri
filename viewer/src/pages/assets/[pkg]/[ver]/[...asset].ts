// SSR endpoint that serves files from a bundle's ingest `assets/` dir.
// `linkForRef({kind: "assets"})` renders URLs like
//   /assets/<pkg>/<ver>/<filename>
//
// This is a hybrid SSR route (`prerender = false`) so it works in both
// `pnpm dev` and when running the built server via the node adapter.
// Static SSG (`getStaticPaths`) would freeze the asset list at build time
// and miss bundles ingested after the server starts, causing 404s in dev.
//
// Only `assets/` is exposed. `meta/` / `docs/` / `examples/` / `module/` are
// CBOR blobs decoded by the page routes, not linkable resources.
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { APIRoute } from "astro";
import { ingestDir } from "../../../../lib/ir-reader.ts";

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
// slug rule and rewrite `:` -> `$` in the URL-facing segment.
// The endpoint reverses the substitution when building the file path.
export function slugifyAssetPath(p: string): string {
  return p.replace(/:/g, "$");
}

export const prerender = false;

export const GET: APIRoute = async ({ params }) => {
  const { pkg, ver, asset } = params;
  if (!pkg || !ver || !asset) {
    return new Response("Not found", { status: 404 });
  }
  // Reverse the URL-safe slug: `$` → `:` to recover the real filename.
  const filename = asset.replace(/\$/g, ":");
  const filePath = join(ingestDir(), pkg, ver, "assets", filename);
  let buf: Buffer;
  try {
    buf = await readFile(filePath);
  } catch {
    return new Response("Not found", { status: 404 });
  }
  const mime = MIME[extname(filePath).toLowerCase()] ?? "application/octet-stream";
  return new Response(new Uint8Array(buf), {
    headers: { "content-type": mime },
  });
};
