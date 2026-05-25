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
import { resolveRefs, resolveExternalRefs, refKey, type RefTuple } from "./graph.ts";
import { linkForLocalRef, linkForRef } from "./links.ts";
import { collectNodes, type IRNode } from "./ir-reader.ts";

export interface XRefShape {
  value?: string;
  reference?: {
    __type?: string;
    module?: string;
    version?: string;
    kind?: string;
    path?: string;
  } | null;
  kind?: string;
}

export type XRefResolver = (
  raw: unknown
) => { url: string; label: string; external?: boolean } | null;

/** Walk a decoded doc and return every CrossRef ref-tuple it points at. */
export function collectXrefs(node: unknown): RefTuple[] {
  const out: RefTuple[] = [];
  for (const n of collectNodes(node, new Set(["CrossRef"]))) {
    const ref = (n as IRNode as XRefShape).reference;
    if (!ref || !ref.path || !ref.kind) continue;
    // LocalRef carries no (module, version) — it's resolved by the page
    // context (current pkg/ver) without a graph lookup.
    if (ref.__type === "LocalRef" || !ref.module) continue;
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
 *
 * `pkg`/`ver` give the page's bundle context so `LocalRef` references
 * (e.g. toctree entries, `:doc:` roles) can be linked without a graph
 * lookup.
 */
export async function buildXrefResolver(
  graphDb: GraphDb,
  doc: unknown,
  pkg: string,
  ver: string
): Promise<XRefResolver> {
  const refs = collectXrefs(doc);
  const resolved = await resolveRefs(graphDb, refs);
  // Refs that don't resolve to an ingested bundle may still be linkable
  // against an external (intersphinx) inventory — e.g. a ref to numpy when
  // no numpy DocBundle has been uploaded.
  const unresolved = refs.filter((r) => !resolved.has(refKey(r)));
  const external = await resolveExternalRefs(graphDb, unresolved);
  return (raw: unknown) => {
    const n = raw as XRefShape | null;
    if (!n) return null;
    const label = n.value ?? "";
    const ref = n.reference;
    if (!ref || !ref.path || !ref.kind) return null;
    // LocalRef → resolve directly against the page's pkg/ver.
    if (ref.__type === "LocalRef" || !ref.module) {
      const url = linkForLocalRef({ kind: ref.kind, path: ref.path }, pkg, ver);
      if (!url) return null;
      return { url, label };
    }
    if (ref.module === "current-module" || ref.kind === "to-resolve") return null;
    const k = refKey({
      pkg: ref.module,
      ver: ref.version ?? "?",
      kind: ref.kind,
      path: ref.path,
    });
    const r = resolved.get(k);
    if (r) {
      const url = linkForRef(r);
      if (!url) return null;
      return { url, label };
    }
    const ext = external.get(k);
    if (ext) return { url: ext, label, external: true };
    return null;
  };
}
