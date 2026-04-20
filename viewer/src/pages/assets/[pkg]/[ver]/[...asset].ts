// Dynamic endpoint that serves bundle assets.
// `linkForRef({kind: "assets"})` renders URLs like /assets/<pkg>/<ver>/<file>.
// Colons in filenames are rewritten to `$` in the URL slug; the store key
// uses the original filename (with the colon reversed here).
import type { APIRoute } from "astro";
import { getStore } from "../../../../lib/storage.ts";

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

/** Reverse the slug rule `:` -> `$` to recover the original asset filename. */
export function unslugifyAssetPath(slug: string): string {
  return slug.replace(/\$/g, ":");
}

/** Apply the slug rule `:` -> `$` for URL generation. */
export function slugifyAssetPath(p: string): string {
  return p.replace(/:/g, "$");
}

export const GET: APIRoute = async ({ params }) => {
  const { pkg, ver, asset } = params;
  const fileName = unslugifyAssetPath(asset ?? "");
  const raw = await getStore().readBytes(pkg!, ver!, `assets/${fileName}`);
  if (!raw) {
    return new Response("Not found", { status: 404 });
  }
  const dot = fileName.lastIndexOf(".");
  const ext = dot >= 0 ? fileName.slice(dot).toLowerCase() : "";
  const mime = MIME[ext] ?? "application/octet-stream";
  return new Response(raw.buffer as ArrayBuffer, { headers: { "content-type": mime } });
};
