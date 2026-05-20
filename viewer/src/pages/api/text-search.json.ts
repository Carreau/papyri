// SSR endpoint: full-text search across every ingested bundle.
//
// Same shape as /api/[pkg]/[ver]/text-search.json, but walks all bundles
// rather than just one. Stops as soon as `limit` hits are collected.
//
// Query params:
//   q      — required; empty returns { hits: [] }.
//   limit  — optional integer, default 20, capped at 20.

import type { APIRoute } from "astro";
import { collectNodes, type TypedNode } from "../../lib/ir-reader.ts";
import { getBackends } from "../../lib/backends.ts";
import { walkAllBundles } from "../../lib/bundle-walk.ts";
import { respond } from "../../lib/api-utils.ts";
import type { TextHit, TextSearchResponse } from "./[pkg]/[ver]/text-search.json.ts";

export const prerender = false;

const TEXT_NODE_TYPES = new Set(["Text"]);
const SNIPPET_RADIUS = 80;

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

export const GET: APIRoute = async ({ url }) => {
  const q = url.searchParams.get("q") ?? "";
  const limit = Math.min(20, Math.max(1, Number(url.searchParams.get("limit") || 20)));

  if (q.trim() === "") {
    return respond({ hits: [], query: q } satisfies TextSearchResponse, 200, {
      "Cache-Control": "no-store",
    });
  }

  const { blobStore, graphDb } = await getBackends();
  const ql = q.toLowerCase();
  const hits: TextHit[] = [];

  await walkAllBundles(blobStore, graphDb, (doc, page) => {
    const text = extractText(doc);
    if (text.toLowerCase().includes(ql)) {
      hits.push({ label: page.label, href: page.href, snippet: makeSnippet(text, q) });
    }
    return hits.length < limit;
  });

  return respond({ hits, query: q } satisfies TextSearchResponse, 200, {
    "Cache-Control": "no-store",
  });
};
