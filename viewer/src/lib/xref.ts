// CrossRef resolution. The IR shape:
//   { __type: "CrossRef", value: label, reference: RefInfo, kind }
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

export interface DetailedXref {
  value: string;
  ref: RefTuple;
}

/**
 * Walk a decoded doc and return every CrossRef as `{value, ref}`. Includes
 * the display text alongside the ref-tuple so callers can report unresolved
 * refs with a human-readable label.
 */
export function collectXrefsDetailed(node: unknown): DetailedXref[] {
  const out: DetailedXref[] = [];
  for (const n of collectNodes(node, new Set(["CrossRef"]))) {
    const xn = n as IRNode as XRefShape;
    const ref = xn.reference;
    if (!ref || !ref.path || !ref.kind) continue;
    if (ref.__type === "LocalRef" || !ref.module) continue;
    if (ref.module === "current-module" || ref.kind === "to-resolve") continue;
    out.push({
      value: xn.value ?? ref.path,
      ref: { pkg: ref.module, ver: ref.version ?? "?", kind: ref.kind, path: ref.path },
    });
  }
  return out;
}

/** Walk a decoded doc and return every CrossRef ref-tuple it points at. */
export function collectXrefs(node: unknown): RefTuple[] {
  const out: RefTuple[] = [];
  for (const n of collectNodes(node, new Set(["CrossRef"]))) {
    const ref = (n as IRNode as XRefShape).reference;
    if (!ref || !ref.path || !ref.kind) continue;
    // LocalRef carries no (module, version) — it's resolved against the page
    // context (current pkg/ver); see collectLocalRefs.
    if (isLocalRef(ref)) continue;
    if (ref.module === "current-module" || ref.kind === "to-resolve") continue;
    out.push({
      pkg: ref.module!,
      ver: ref.version ?? "?",
      kind: ref.kind,
      path: ref.path,
    });
  }
  return out;
}

/** A CrossRef whose target lives in the page's own bundle. */
function isLocalRef(ref: NonNullable<XRefShape["reference"]>): boolean {
  return ref.__type === "LocalRef" || !ref.module;
}

/**
 * Walk a decoded doc and return every *local* CrossRef as a ref-tuple keyed
 * to the page's own (pkg, ver). LocalRefs were historically rendered as links
 * unconditionally — but gen emits hopeful ones (e.g. `:doc:` targets, or See
 * Also names resolved to same-package objects) that may have no page in this
 * bundle. We resolve them against the graph like any other ref so missing
 * targets degrade to plain text instead of 404 links.
 */
export function collectLocalRefs(node: unknown, pkg: string, ver: string): RefTuple[] {
  const out: RefTuple[] = [];
  for (const n of collectNodes(node, new Set(["CrossRef"]))) {
    const ref = (n as IRNode as XRefShape).reference;
    if (!ref || !ref.path || !ref.kind) continue;
    if (!isLocalRef(ref)) continue;
    out.push({ pkg, ver, kind: ref.kind, path: ref.path });
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
  // LocalRefs resolve against the page's own bundle; batch them alongside the
  // cross-package refs so we can verify the target exists before linking.
  const localRefs = collectLocalRefs(doc, pkg, ver);
  const resolved = await resolveRefs(graphDb, [...refs, ...localRefs]);
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
    // LocalRef → resolve against the page's pkg/ver, but only link when the
    // target actually has a blob in the graph. Gen emits hopeful LocalRefs
    // (`:doc:` targets, same-package See Also names) that may not exist here;
    // those must degrade to plain text rather than render as 404 links.
    if (isLocalRef(ref)) {
      if (!resolved.has(refKey({ pkg, ver, kind: ref.kind, path: ref.path }))) return null;
      const url = linkForLocalRef({ kind: ref.kind, path: ref.path }, pkg, ver);
      if (!url) return null;
      return { url, label };
    }
    if (ref.module === "current-module" || ref.kind === "to-resolve") return null;
    const k = refKey({
      pkg: ref.module!,
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
