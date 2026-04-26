// View-model for narrative doc pages
// (`pages/[pkg]/[ver]/docs/[...doc].astro`).
//
// Three responsibilities pulled out of the Astro frontmatter:
//
//   1. Assign a stable HTML id to each titled section, preferring the RST
//      target label (`.. _label:`) and falling back to a slugified title
//      with a numeric suffix on collisions.
//   2. Decide what becomes the page <h1> (first section title, falling
//      back to the qualname or the doc path) and whether the first
//      section's <h2> should be suppressed to avoid duplication.
//   3. Walk the section list to produce the on-page mini-TOC with each
//      entry tagged with its level and the id of its enclosing h2 (so
//      the runtime scroll-spy can collapse h3+ entries outside the
//      active section).

import type { IngestedDoc, SectionNode } from "./ir-reader.ts";

export interface TocEntry {
  section: SectionNode;
  /** Stable DOM id; matches the section's `id=` attribute. */
  id: string | undefined;
  /** Section level as encoded in the IR (0 = doc title, 1 = h2, ...). */
  level: number;
  /**
   * Id of the enclosing top-level (level <= 1) section. For h2 entries
   * this is the entry's own id; for h3+ entries it's the previous h2's
   * id, used by the scroll-spy to collapse entries outside the active
   * top-level group.
   */
  parentH2Id: string | undefined;
}

export interface DocPageView {
  sections: SectionNode[];
  /** Stable DOM id per section (only present for sections with a title). */
  sectionIds: ReadonlyMap<SectionNode, string>;
  /** Visible <h1> for the page. */
  displayTitle: string;
  /** Tab title (prefers the qualname over the synthesised display title). */
  pageTitle: string;
  /**
   * True when the first section's title is reused as the page <h1>; the
   * template should suppress that section's <h2> to avoid duplication.
   */
  firstTitleIsH1: boolean;
  /** Sections that contribute to the on-page mini-TOC. */
  tocEntries: TocEntry[];
}

/** Normalise a heading string into a DOM-safe id. */
function slugifyTitle(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9-]/g, "")
      .replace(/^-+|-+$/g, "") || "section"
  );
}

function assignSectionIds(sections: readonly SectionNode[]): Map<SectionNode, string> {
  const ids = new Map<SectionNode, string>();
  const used = new Set<string>();
  for (const s of sections) {
    if (!s.title) continue;
    const base = s.target ?? slugifyTitle(s.title);
    let id = base;
    let n = 2;
    while (used.has(id)) id = `${base}-${n++}`;
    used.add(id);
    ids.set(s, id);
  }
  return ids;
}

export function buildDocPageView(doc: IngestedDoc, docPath: string): DocPageView {
  const sections: SectionNode[] = Array.isArray(doc.arbitrary) ? doc.arbitrary : [];
  const sectionIds = assignSectionIds(sections);

  // Reuse the first section's title as the page <h1>; falling back to
  // doc.qa avoids leaking raw IR keys like "config:details" into the UI.
  const displayTitle = sections[0]?.title || doc.qa || docPath;
  const pageTitle = doc.qa || docPath;
  const firstTitleIsH1 = sections.length > 0 && sections[0].title === displayTitle;

  // TOC entries: any titled section, minus the first when it became the h1.
  const titled = sections.filter((s, i) => s.title && !(i === 0 && firstTitleIsH1));

  let currentH2Id: string | undefined;
  const tocEntries: TocEntry[] = titled.map((s) => {
    const id = sectionIds.get(s);
    const level = s.level ?? 1;
    if (level <= 1) {
      currentH2Id = id;
      return { section: s, id, level, parentH2Id: id };
    }
    return { section: s, id, level, parentH2Id: currentH2Id };
  });

  return { sections, sectionIds, displayTitle, pageTitle, firstTitleIsH1, tocEntries };
}
