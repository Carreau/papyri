// SSR endpoint: browse unique IR nodes in a bundle.
//
// Walks modules first, then narrative docs, then examples; returns up to
// `limit` (max 100) deduplicated nodes. Stops as soon as the limit is
// reached so large bundles are cheap to query.
//
// Query params:
//   nodetype  — optional lowercase slug of an IR type name (e.g. "paragraph").
//               Omit to collect all known node types.
//   limit     — optional integer, default 100, capped at 100.

import type { APIRoute } from "astro";
import type { BlobStore } from "papyri-ingest";
import {
  collectNodes,
  ALL_NODE_TYPES,
  resolveVersion,
  type IRNode,
  type TypedNode,
} from "../../../../lib/ir-reader.ts";
import { getBackends } from "../../../../lib/backends.ts";
import { typeFromSlug } from "../../../../lib/ir-types.ts";
import { renderNode } from "../../../../lib/render-node.ts";
import { walkBundle, type PageRef } from "../../../../lib/bundle-walk.ts";
import { respond } from "../../../../lib/api-utils.ts";

export const prerender = false;

export interface NodeEntry {
  type: string;
  value: string;
  html?: string;
  pages: PageRef[];
}

export interface NodesResponse {
  total: number;
  limit: number;
  entries: NodeEntry[];
}

function displayValueFor(n: IRNode): string {
  const v = (n as Record<string, unknown>).value;
  if (typeof v === "string") return v;
  return JSON.stringify(n).slice(0, 120);
}

// Dedup uses full content, not the truncated display value: structural
// nodes (Table, Paragraph, …) have no string `value`, and their first 120
// stringified chars are mostly schema overhead — distinct nodes on the
// same page would collapse onto one entry and lose page references.
function dedupKeyFor(n: IRNode): string {
  const v = (n as Record<string, unknown>).value;
  if (typeof v === "string") return v;
  return JSON.stringify(n);
}

async function collectBundleNodes(
  blobStore: BlobStore,
  pkg: string,
  ver: string,
  types: ReadonlySet<string>,
  limit: number,
  urlVer?: string
): Promise<NodesResponse> {
  const valueMap = new Map<string, NodeEntry>();
  const nodeMap = new Map<string, IRNode>();

  const typesLabel = types === ALL_NODE_TYPES ? "<all>" : [...types].join(",");
  const overallStart = performance.now();
  console.log(`[nodes] scan start pkg=${pkg} ver=${ver} types=${typesLabel} limit=${limit}`);

  function addHits(nodes: IRNode[], page: PageRef): void {
    for (const n of nodes) {
      if (valueMap.size >= limit) return;
      const type = (n as TypedNode).__type;
      const k = `${type}\0${dedupKeyFor(n)}`;
      const existing = valueMap.get(k);
      if (existing) {
        if (!existing.pages.some((p) => p.href === page.href)) {
          existing.pages.push(page);
        }
      } else {
        valueMap.set(k, { type, value: displayValueFor(n), pages: [page] });
        nodeMap.set(k, n);
      }
    }
  }

  await walkBundle(
    blobStore,
    pkg,
    ver,
    (doc, page) => {
      if (valueMap.size >= limit) return false;
      addHits(collectNodes(doc, types), page);
      return valueMap.size < limit;
    },
    urlVer
  );

  const sortedKeys = [...valueMap.keys()].sort((a, b) => {
    const ea = valueMap.get(a)!;
    const eb = valueMap.get(b)!;
    if (ea.type !== eb.type) return ea.type.localeCompare(eb.type);
    return ea.value.length - eb.value.length || ea.value.localeCompare(eb.value);
  });
  const entries = sortedKeys.map((k) => valueMap.get(k)!);

  await Promise.all(
    sortedKeys.map(async (k, i) => {
      const originalNode = nodeMap.get(k);
      if (originalNode) {
        entries[i].html = await renderNode(originalNode);
      }
    })
  );

  console.log(
    `[nodes] scan done pkg=${pkg} ver=${ver} total=${valueMap.size} ` +
      `${(performance.now() - overallStart).toFixed(1)}ms`
  );

  return { total: valueMap.size, limit, entries };
}

export const GET: APIRoute = async ({ params, url }) => {
  const { pkg, ver } = params;
  if (!pkg || !ver) {
    return respond({ error: "Bundle not found" }, 404);
  }
  const nodetypeSlug = url.searchParams.get("nodetype");
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") || 100)));

  let types: ReadonlySet<string> = ALL_NODE_TYPES;
  if (nodetypeSlug) {
    const typeName = typeFromSlug(nodetypeSlug);
    if (!typeName) {
      return respond({ error: "Unknown node type" }, 404);
    }
    types = new Set([typeName]);
  }

  const { blobStore, graphDb } = await getBackends();
  const actualVer = await resolveVersion(graphDb, pkg, ver);
  if (!actualVer) return respond({ error: `Package ${pkg} not found` }, 404);
  const result = await collectBundleNodes(blobStore, pkg, actualVer, types, limit, ver);

  return respond(result, 200, { "Cache-Control": "no-store" });
};
