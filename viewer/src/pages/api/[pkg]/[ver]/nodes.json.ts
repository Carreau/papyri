// SSR endpoint: browse unique IR nodes in a bundle.
//
// Returns up to `limit` (max 100) deduplicated nodes from the bundle,
// walking modules first, then narrative docs, then examples. Stops as
// soon as the limit is reached so large bundles are cheap to query.
//
// Query params:
//   nodetype  — optional slug from NODE_CONFIGS ("math" | "code").
//               Omit to collect all known node types.
//   limit     — optional integer, default 100, capped at 100.
//
// Response:
//   { total: number, limit: number,
//     entries: Array<{ type: string, value: string,
//                      pages: Array<{ label: string, href: string }> }> }

import type { APIRoute } from "astro";
import { join } from "node:path";
import {
  listIngestedBundles,
  listModules,
  loadModule,
  loadCbor,
  collectNodes,
  ALL_NODE_TYPES,
  type IRNode,
  type TypedNode,
} from "../../../../lib/ir-reader.ts";
import { listDocs, listExamples } from "../../../../lib/nav.ts";
import { NODE_CONFIGS } from "../../../../lib/node-configs.ts";
import { renderNode } from "../../../../lib/render-node.ts";

export const prerender = false;

interface PageRef {
  label: string;
  href: string;
}

export interface NodeEntry {
  type: string;
  value: string;
  /** Pre-rendered HTML from renderNode; always present in API responses. */
  html?: string;
  pages: PageRef[];
}

export interface NodesResponse {
  total: number;
  limit: number;
  entries: NodeEntry[];
}

function displayValueFor(n: IRNode): string | null {
  for (const cfg of Object.values(NODE_CONFIGS)) {
    if (cfg.types.has((n as TypedNode).__type)) return cfg.displayValue(n);
  }
  return JSON.stringify(n).slice(0, 120);
}

export async function collectBundleNodes(
  bundlePath: string,
  pkg: string,
  ver: string,
  types: ReadonlySet<string>,
  limit: number
): Promise<NodesResponse> {
  const valueMap = new Map<string, NodeEntry>();
  // Parallel map keyed identically to valueMap; stores the first IRNode seen
  // for each unique (type, value) pair so we can render HTML after collection.
  const nodeMap = new Map<string, IRNode>();

  function entryKey(type: string, val: string): string {
    return `${type}\0${val}`;
  }

  function addHits(nodes: IRNode[], page: PageRef): void {
    for (const n of nodes) {
      if (valueMap.size >= limit) return;
      const val = displayValueFor(n);
      if (val === null) continue;
      const type = (n as TypedNode).__type;
      const k = entryKey(type, val);
      const existing = valueMap.get(k);
      if (existing) {
        if (!existing.pages.some((p) => p.href === page.href)) {
          existing.pages.push(page);
        }
      } else {
        valueMap.set(k, { type, value: val, pages: [page] });
        nodeMap.set(k, n);
      }
    }
  }

  // Walk modules first — they're the primary content source.
  const qualnames = await listModules(bundlePath);
  for (const qa of qualnames) {
    if (valueMap.size >= limit) break;
    let doc;
    try {
      doc = await loadModule(bundlePath, qa);
    } catch {
      continue;
    }
    addHits(collectNodes(doc, types), {
      label: qa,
      href: `/${pkg}/${ver}/${qa.replace(/:/g, "$")}/`,
    });
  }

  // Narrative docs second.
  const docPaths = await listDocs(bundlePath);
  for (const docPath of docPaths) {
    if (valueMap.size >= limit) break;
    let section;
    try {
      section = await loadCbor(join(bundlePath, "docs", docPath));
    } catch {
      continue;
    }
    addHits(collectNodes(section, types), {
      label: docPath,
      href: `/${pkg}/${ver}/docs/${docPath.split("/").map(encodeURIComponent).join("/")}/`,
    });
  }

  // Examples last.
  const exPaths = await listExamples(bundlePath);
  for (const exPath of exPaths) {
    if (valueMap.size >= limit) break;
    let section;
    try {
      section = await loadCbor(join(bundlePath, "examples", exPath));
    } catch {
      continue;
    }
    addHits(collectNodes(section, types), {
      label: exPath,
      href: `/${pkg}/${ver}/examples/${exPath.split("/").map(encodeURIComponent).join("/")}/`,
    });
  }

  const entries = [...valueMap.values()].sort((a, b) => {
    if (a.type !== b.type) return a.type.localeCompare(b.type);
    return a.value.length - b.value.length || a.value.localeCompare(b.value);
  });

  // Render HTML for each entry using the original node (no resolveXref: the
  // node browser shows nodes out of context, so CrossRefs render as unresolved).
  await Promise.all(
    entries.map(async (entry) => {
      const k = entryKey(entry.type, entry.value);
      const originalNode = nodeMap.get(k);
      if (originalNode) {
        entry.html = await renderNode(originalNode);
      }
    })
  );

  return { total: valueMap.size, limit, entries };
}

export const GET: APIRoute = async ({ params, url }) => {
  const { pkg, ver } = params;
  const nodetypeSlug = url.searchParams.get("nodetype");
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") || 100)));

  const bundles = await listIngestedBundles();
  const bundle = bundles.find((b) => b.pkg === pkg && b.version === ver);
  if (!bundle) {
    return new Response(JSON.stringify({ error: "Bundle not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const cfg = nodetypeSlug ? NODE_CONFIGS[nodetypeSlug] : undefined;
  const types = cfg?.types ?? ALL_NODE_TYPES;

  const result = await collectBundleNodes(bundle.path, pkg!, ver!, types, limit);

  return new Response(JSON.stringify(result), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
};
