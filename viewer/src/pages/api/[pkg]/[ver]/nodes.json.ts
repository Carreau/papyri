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
  listModules,
  loadModule,
  loadCbor,
  collectNodes,
  ALL_NODE_TYPES,
  type IRNode,
  type TypedNode,
} from "../../../../lib/ir-reader.ts";
import { listDocs, listExamples } from "../../../../lib/nav.ts";
import { getBackends } from "../../../../lib/backends.ts";
import { typeFromSlug } from "../../../../lib/ir-types.ts";
import { linkForDoc, linkForExample, linkForQualname } from "../../../../lib/links.ts";
import { renderNode } from "../../../../lib/render-node.ts";

export const prerender = false;

interface PageRef {
  label: string;
  href: string;
}

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

async function collectBundleNodes(
  blobStore: BlobStore,
  pkg: string,
  ver: string,
  types: ReadonlySet<string>,
  limit: number,
): Promise<NodesResponse> {
  const valueMap = new Map<string, NodeEntry>();
  const nodeMap = new Map<string, IRNode>();

  function entryKey(type: string, val: string): string {
    return `${type}\0${val}`;
  }

  function addHits(nodes: IRNode[], page: PageRef): void {
    for (const n of nodes) {
      if (valueMap.size >= limit) return;
      const val = displayValueFor(n);
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

  const qualnames = await listModules(blobStore, pkg, ver);
  for (const qa of qualnames) {
    if (valueMap.size >= limit) break;
    let doc;
    try {
      doc = await loadModule(blobStore, pkg, ver, qa);
    } catch {
      continue;
    }
    addHits(collectNodes(doc, types), { label: qa, href: linkForQualname(pkg, ver, qa) });
  }

  const docPaths = await listDocs(blobStore, pkg, ver);
  for (const docPath of docPaths) {
    if (valueMap.size >= limit) break;
    let section;
    try {
      section = await loadCbor(blobStore, pkg, ver, "docs", docPath);
    } catch {
      continue;
    }
    addHits(collectNodes(section, types), {
      label: docPath,
      href: linkForDoc(pkg, ver, docPath),
    });
  }

  const exPaths = await listExamples(blobStore, pkg, ver);
  for (const exPath of exPaths) {
    if (valueMap.size >= limit) break;
    let section;
    try {
      section = await loadCbor(blobStore, pkg, ver, "examples", exPath);
    } catch {
      continue;
    }
    addHits(collectNodes(section, types), {
      label: exPath,
      href: linkForExample(pkg, ver, exPath),
    });
  }

  const entries = [...valueMap.values()].sort((a, b) => {
    if (a.type !== b.type) return a.type.localeCompare(b.type);
    return a.value.length - b.value.length || a.value.localeCompare(b.value);
  });

  await Promise.all(
    entries.map(async (entry) => {
      const k = entryKey(entry.type, entry.value);
      const originalNode = nodeMap.get(k);
      if (originalNode) {
        entry.html = await renderNode(originalNode);
      }
    }),
  );

  return { total: valueMap.size, limit, entries };
}

export const GET: APIRoute = async ({ params, url }) => {
  const { pkg, ver } = params;
  if (!pkg || !ver) {
    return new Response(JSON.stringify({ error: "Bundle not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
  const nodetypeSlug = url.searchParams.get("nodetype");
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") || 100)));

  let types: ReadonlySet<string> = ALL_NODE_TYPES;
  if (nodetypeSlug) {
    const typeName = typeFromSlug(nodetypeSlug);
    if (!typeName) {
      return new Response(JSON.stringify({ error: "Unknown node type" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    types = new Set([typeName]);
  }

  const { blobStore } = await getBackends();
  const result = await collectBundleNodes(blobStore, pkg, ver, types, limit);

  return new Response(JSON.stringify(result), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
};
