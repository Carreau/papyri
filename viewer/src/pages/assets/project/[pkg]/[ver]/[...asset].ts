// SSR endpoint that serves files from a bundle's `assets/` namespace.
//
// URL shape (built by `linkForAsset` in `lib/links.ts`):
//   /assets/project/<pkg>/<ver>/<filename-with-colons-as-dollars>
//
// Reads through the active BlobStore. We map Content-Type by extension
// since the fs backend doesn't infer it.

import { extname } from "node:path";
import type { APIRoute } from "astro";
import { loadAsset } from "../../../../../lib/ir-reader.ts";
import { getBackends } from "../../../../../lib/backends.ts";
import { slugToQualname } from "../../../../../lib/slugs.ts";

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

export const prerender = false;

export const GET: APIRoute = async ({ params }) => {
  const { pkg, ver, asset } = params;
  if (!pkg || !ver || !asset) {
    return new Response("Not found", { status: 404 });
  }
  // Reverse the URL-safe slug (`$` -> `:`).
  const filename = slugToQualname(asset);
  const { blobStore } = await getBackends();
  const bytes = await loadAsset(blobStore, pkg, ver, filename);
  if (!bytes) return new Response("Not found", { status: 404 });
  const mime = MIME[extname(filename).toLowerCase()] ?? "application/octet-stream";
  return new Response(bytes as unknown as BodyInit, { headers: { "content-type": mime } });
};
