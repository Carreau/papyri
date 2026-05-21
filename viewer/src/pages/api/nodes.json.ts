// SSR endpoint: browse unique IR nodes across every ingested bundle.
//
// Same shape as /api/[pkg]/[ver]/nodes.json, but walks all bundles rather
// than one. Stops as soon as `limit` unique node values are collected.
//
// Query params:
//   nodetype  — optional lowercase slug of an IR type name (e.g. "paragraph").
//               Omit to collect all known node types.
//   limit     — optional integer, default 100, capped at 100.

import type { APIRoute } from "astro";
import { collectNodes, ALL_NODE_TYPES, type IRNode, type TypedNode } from "../../lib/ir-reader.ts";
import { getBackends } from "../../lib/backends.ts";
import { typeFromSlug } from "../../lib/ir-types.ts";
import { renderNode } from "../../lib/render-node.ts";
import { walkAllBundles, type PageRef } from "../../lib/bundle-walk.ts";
import { respond } from "../../lib/api-utils.ts";
import type { NodeEntry, NodesResponse } from "./[pkg]/[ver]/nodes.json.ts";

export const prerender = false;

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

export const GET: APIRoute = async ({ url }) => {
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
  const valueMap = new Map<string, NodeEntry>();
  const nodeMap = new Map<string, IRNode>();

  const typesLabel = types === ALL_NODE_TYPES ? "<all>" : [...types].join(",");
  const overallStart = performance.now();
  console.log(`[nodes] scan-all start types=${typesLabel} limit=${limit}`);

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

  await walkAllBundles(blobStore, graphDb, (doc, page) => {
    if (valueMap.size >= limit) return false;
    addHits(collectNodes(doc, types), page);
    return valueMap.size < limit;
  });

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
    `[nodes] scan-all done total=${valueMap.size} ` +
      `${(performance.now() - overallStart).toFixed(1)}ms`
  );

  const result: NodesResponse = { total: valueMap.size, limit, entries };
  return respond(result, 200, { "Cache-Control": "no-store" });
};
