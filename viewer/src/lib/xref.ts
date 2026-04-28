// CrossRef resolution. The IR shape:
//   { __type: "CrossRef", value: label, reference: RefInfo, kind, anchor }
// where `reference` is a RefInfo tag node with fields
// (module, version, kind, path).
//
// Resolution requires a graph DB query, which is async. Pages can't await
// inside a deeply-nested template loop, so the pattern is:
//
//   1. The page collects every CrossRef in the doc up-front,
//      `await resolveRefs(graphDb, refs)` once,
//      builds an `XRefResolver` (sync) closure over the resolved Map.
//   2. Astro / React components receive that sync closure and call it
//      while rendering.
//
// `to-resolve` and `current-module` are gen-time placeholders that never
// resolve; we treat them as null up-front.

import type { GraphDb } from "papyri-ingest";
import { resolveRefs, refKey, type RefTuple } from "./graph.ts";
import { linkForRef } from "./links.ts";
import { collectNodes, type IRNode } from "./ir-reader.ts";

export interface XRefShape {
  value?: string;
  reference?: {
    module?: string;
    version?: string;
    kind?: string;
    path?: string;
  } | null;
  kind?: string;
}

export type XRefResolver = (raw: unknown) => { url: string; label: string } | null;

/** Walk a decoded doc and return every CrossRef ref-tuple it points at. */
export function collectXrefs(node: unknown): RefTuple[] {
  const out: RefTuple[] = [];
  for (const n of collectNodes(node, new Set(["CrossRef"]))) {
    const ref = (n as IRNode as XRefShape).reference;
    if (!ref || !ref.module || !ref.path || !ref.kind) continue;
    if (ref.module === "current-module" || ref.kind === "to-resolve") continue;
    out.push({
      pkg: ref.module,
      ver: ref.version ?? "?",
      kind: ref.kind,
      path: ref.path,
    });
  }
  return out;
}

/**
 * Build a sync xref resolver for a doc. Runs one batched
 * `resolveRefs(graphDb, …)` and returns a closure that components can
 * call inside the render tree.
 */
export async function buildXrefResolver(
  graphDb: GraphDb,
  doc: unknown,
): Promise<XRefResolver> {
  const refs = collectXrefs(doc);
  const resolved = await resolveRefs(graphDb, refs);
  return (raw: unknown) => {
    const n = raw as XRefShape | null;
    if (!n) return null;
    const label = n.value ?? "";
    const ref = n.reference;
    if (!ref || !ref.module || !ref.path || !ref.kind) return null;
    if (ref.module === "current-module" || ref.kind === "to-resolve") return null;
    const k = refKey({
      pkg: ref.module,
      ver: ref.version ?? "?",
      kind: ref.kind,
      path: ref.path,
    });
    const r = resolved.get(k);
    if (!r) return null;
    const url = linkForRef(r);
    if (!url) return null;
    return { url, label };
  };
}
