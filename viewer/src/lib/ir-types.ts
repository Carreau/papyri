// Static registry of all IR node type names, ordered by CBOR tag.
//
// Kept in a separate file with no Node.js imports so it can be bundled for
// the browser (used by NodesPanel) as well as server-side modules.

// Node types registered with @debug in nodes.py: their schema is in flux and
// they are not yet considered stable IR output. Must stay in sync with
// DEBUG_TYPES in node_base.py.
export const DEBUG_TYPE_NAMES: ReadonlySet<string> = new Set([
  "Directive",
  "InlineRole",
  "Options",
  "SubstitutionDef",
  "SubstitutionRef",
  "Unimplemented",
  "UnimplementedInline",
]);

export const IR_TYPE_NAMES: readonly string[] = [
  "RefInfo",
  "Root",
  "CrossRef",
  "InlineRole",
  "IngestedDoc",
  "GeneratedDoc",
  "NumpydocExample",
  "NumpydocSeeAlso",
  "NumpydocSignature",
  "Section",
  "DocParam",
  "UnimplementedInline",
  "Unimplemented",
  "ThematicBreak",
  "Heading",
  "TocTree",
  "LocalRef",
  "Figure",
  "Parameters",
  "SubstitutionDef",
  "SeeAlsoItem",
  "SignatureNode",
  "SigParam",
  "Empty",
  "DefList",
  "Options",
  "FieldList",
  "FieldListItem",
  "DefListItem",
  "SubstitutionRef",
  "Paragraph",
  "Text",
  "Emphasis",
  "Strong",
  "Link",
  "Code",
  "InlineCode",
  "Directive",
  "BulletList",
  "ListItem",
  "AdmonitionTitle",
  "Admonition",
  "InlineMath",
  "Math",
  "Blockquote",
  "Target",
  "Image",
  "CitationReference",
  "Citation",
  "FootnoteReference",
  "Footnote",
] as const;

/** Lower-cased slug for a type name, e.g. "Paragraph" → "paragraph". */
export function slugFromType(typeName: string): string {
  return typeName.toLowerCase();
}

/** Type name for a slug, or null if not recognised, e.g. "paragraph" → "Paragraph". */
export function typeFromSlug(slug: string): string | null {
  const lower = slug.toLowerCase();
  return IR_TYPE_NAMES.find((t) => t.toLowerCase() === lower) ?? null;
}
