// SSR endpoint: full-text search over a bundle's IR Text nodes.
//
// Walks every module, narrative doc, and example in the bundle, concatenates
// text from `Text` nodes, and returns the first `limit` pages whose text
// contains the query (case-insensitive substring). The stop-early path in
// walkBundle keeps this cheap for large bundles once enough hits are found.
//
// Query params:
//   q      — required; empty returns { hits: [] }.
//   limit  — optional integer, default 20, capped at 20.

import type { APIRoute } from "astro";
import type { BlobStore } from "papyri-ingest";
import { collectNodes, type TypedNode } from "../../../../lib/ir-reader.ts";
import { getBackends } from "../../../../lib/backends.ts";
import { walkBundle, type PageRef } from "../../../../lib/bundle-walk.ts";

export const prerender = false;

const TEXT_NODE_TYPES = new Set(["Text"]);
const SNIPPET_RADIUS = 80;

export interface TextHit {
  label: string;
  href: string;
  snippet: string;
}

export interface TextSearchResponse {
  hits: TextHit[];
  query: string;
}

function extractText(doc: unknown): string {
  return collectNodes(doc, TEXT_NODE_TYPES)
    .map((n) => String((n as TypedNode).value ?? ""))
    .join(" ");
}

function makeSnippet(text: string, query: string): string {
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text.slice(0, SNIPPET_RADIUS * 2);
  const start = Math.max(0, idx - SNIPPET_RADIUS);
  const end = Math.min(text.length, idx + query.length + SNIPPET_RADIUS);
  return (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
}

async function searchBundle(
  blobStore: BlobStore,
  pkg: string,
  ver: string,
  query: string,
  limit: number
): Promise<TextHit[]> {
  const hits: TextHit[] = [];
  const q = query.toLowerCase();

  await walkBundle(blobStore, pkg, ver, (doc, page: PageRef) => {
    const text = extractText(doc);
    if (text.toLowerCase().includes(q)) {
      hits.push({ label: page.label, href: page.href, snippet: makeSnippet(text, query) });
    }
    return hits.length < limit;
  });

  return hits;
}

export const GET: APIRoute = async ({ params, url }) => {
  const { pkg, ver } = params;
  if (!pkg || !ver) {
    return new Response(JSON.stringify({ error: "Bundle not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const q = url.searchParams.get("q") ?? "";
  const limit = Math.min(20, Math.max(1, Number(url.searchParams.get("limit") || 20)));

  if (q.trim() === "") {
    return new Response(JSON.stringify({ hits: [], query: q } satisfies TextSearchResponse), {
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }

  const { blobStore } = await getBackends();
  const hits = await searchBundle(blobStore, pkg, ver, q, limit);

  return new Response(JSON.stringify({ hits, query: q } satisfies TextSearchResponse), {
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
};
