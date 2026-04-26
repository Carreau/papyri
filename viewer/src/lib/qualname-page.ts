// View-model for the qualname page (`pages/[pkg]/[ver]/[...slug].astro`).
//
// Pulls the assembly logic out of the Astro frontmatter so the page itself
// is a flat template over typed data. Three responsibilities:
//
//   1. Decide which `_content` sections to render and in what order.
//   2. Unwrap `example_section_data` (a Section that's separate from
//      `_content["Examples"]`) into a flat children list.
//   3. Resolve and bucket backrefs from the graph store into same-package
//      vs cross-package rows.

import type { IngestedDoc, SectionNode } from "./ir-reader.ts";
import { linkForRef } from "./links.ts";
import type { RefTuple } from "./graph.ts";

export interface RenderSection {
  title: string;
  section: SectionNode;
}

export interface ExampleSection {
  title: string;
  children: SectionNode["children"];
}

export interface BackrefRow {
  url: string;
  label: string;
  key: string;
  /** Package name for cross-package rows; undefined for same-package rows. */
  pkg?: string;
}

export interface QualnamePageView {
  sections: RenderSection[];
  arbitrary: SectionNode[];
  exampleSection: ExampleSection | null;
  internalBackrefs: BackrefRow[];
  externalBackrefs: BackrefRow[];
}

/**
 * Iterate `_content` keys in source order. Prefer `_ordered_sections` (which
 * carries the order discovered at gen time) and append any `_content` keys
 * that didn't make it into the ordered list, just in case.
 */
function renderOrder(doc: IngestedDoc): string[] {
  const ordered = doc._ordered_sections ?? [];
  const contentKeys = Object.keys(doc._content ?? {});
  return [
    ...ordered.filter((k) => contentKeys.includes(k)),
    ...contentKeys.filter((k) => !ordered.includes(k)),
  ];
}

function nonEmptySections(doc: IngestedDoc): RenderSection[] {
  const out: RenderSection[] = [];
  for (const key of renderOrder(doc)) {
    const s = doc._content?.[key] as SectionNode | undefined;
    if (!s) continue;
    if (!Array.isArray(s.children) || s.children.length === 0) continue;
    out.push({ title: key, section: s });
  }
  return out;
}

function unwrapExampleSection(doc: IngestedDoc): ExampleSection | null {
  const es = doc.example_section_data as SectionNode | null | undefined;
  if (!es) return null;
  const kids = Array.isArray(es.children) ? es.children : [];
  if (kids.length === 0) return null;
  return { title: es.title ?? "Examples", children: kids };
}

function bucketBackrefs(
  backrefs: readonly RefTuple[],
  ownPkg: string
): { internal: BackrefRow[]; external: BackrefRow[] } {
  const internal: BackrefRow[] = [];
  const external: BackrefRow[] = [];
  const seen = new Set<string>();
  for (const b of backrefs) {
    const url = linkForRef(b);
    if (!url) continue;
    const key = `${b.pkg}/${b.ver}/${b.kind}/${b.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (b.pkg === ownPkg) {
      internal.push({ url, label: b.path, key });
    } else {
      external.push({ url, label: b.path, key, pkg: b.pkg });
    }
  }
  return { internal, external };
}

export function buildQualnamePageView(
  doc: IngestedDoc,
  backrefs: readonly RefTuple[],
  ownPkg: string
): QualnamePageView {
  const { internal, external } = bucketBackrefs(backrefs, ownPkg);
  return {
    sections: nonEmptySections(doc),
    arbitrary: Array.isArray(doc.arbitrary) ? doc.arbitrary : [],
    exampleSection: unwrapExampleSection(doc),
    internalBackrefs: internal,
    externalBackrefs: external,
  };
}
