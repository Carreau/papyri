import { Decoder, Tag, addExtension } from "cbor-x";
import { getStore } from "./storage.ts";
import { resolveRef } from "./graph.ts";

// ---------------------------------------------------------------------------
// Bundle discovery
// ---------------------------------------------------------------------------

export interface IngestedBundle {
  pkg: string;
  version: string;
}

export async function listIngestedBundles(): Promise<IngestedBundle[]> {
  const raw = await getStore().listBundles();
  return raw.map((b) => ({ pkg: b.pkg, version: b.ver }));
}

/** List qualnames available under a bundle's `module/` directory. */
export async function listModules(pkg: string, ver: string): Promise<string[]> {
  const files = await getStore().listDir(pkg, ver, "module");
  return files
    .map((f) => (f.endsWith(".cbor") ? f.slice(0, -5) : f))
    .sort();
}

// ---------------------------------------------------------------------------
// CBOR tag-based decoder (unchanged from M1)
// ---------------------------------------------------------------------------

export interface TypedNode {
  __type: string;
  __tag: number;
  [k: string]: unknown;
}

export interface UnknownNode {
  __type: "unknown";
  __tag: number;
  value: unknown;
}

export type IRNode = TypedNode | UnknownNode;

const FIELD_ORDER: Record<number, { name: string; fields: string[] }> = {
  4000: { name: "RefInfo", fields: ["module", "version", "kind", "path"] },
  4001: { name: "Root", fields: ["children"] },
  4002: { name: "CrossRef", fields: ["value", "reference", "kind", "anchor"] },
  4003: {
    name: "InlineRole",
    fields: ["value", "domain", "role", "inventory"],
  },
  4010: {
    name: "IngestedDoc",
    fields: [
      "_content",
      "_ordered_sections",
      "item_file",
      "item_line",
      "item_type",
      "aliases",
      "example_section_data",
      "see_also",
      "signature",
      "references",
      "qa",
      "arbitrary",
    ],
  },
  4011: {
    name: "GeneratedDoc",
    fields: [
      "_content",
      "example_section_data",
      "_ordered_sections",
      "item_file",
      "item_line",
      "item_type",
      "aliases",
      "see_also",
      "signature",
      "references",
      "arbitrary",
    ],
  },
  4012: { name: "NumpydocExample", fields: ["value"] },
  4013: { name: "NumpydocSeeAlso", fields: ["value"] },
  4014: { name: "NumpydocSignature", fields: ["value"] },
  4015: { name: "Section", fields: ["children", "title", "level", "target"] },
  4016: { name: "DocParam", fields: ["name", "annotation", "desc"] },
  4017: { name: "UnimplementedInline", fields: ["children"] },
  4018: { name: "Unimplemented", fields: ["placeholder", "value"] },
  4019: { name: "ThematicBreak", fields: [] },
  4020: { name: "Heading", fields: ["depth", "children"] },
  4021: {
    name: "TocTree",
    fields: ["children", "title", "ref", "open", "current"],
  },
  4024: { name: "Figure", fields: ["value"] },
  4026: { name: "Parameters", fields: ["children"] },
  4027: { name: "SubstitutionDef", fields: ["value", "children"] },
  4028: { name: "SeeAlsoItem", fields: ["name", "descriptions", "type"] },
  4029: {
    name: "SignatureNode",
    fields: ["kind", "parameters", "return_annotation", "target_name"],
  },
  4030: {
    name: "SigParam",
    fields: ["name", "annotation", "kind", "default"],
  },
  4031: { name: "Empty", fields: [] },
  4033: { name: "DefList", fields: ["children"] },
  4034: { name: "Options", fields: ["values"] },
  4035: { name: "FieldList", fields: ["children"] },
  4036: { name: "FieldListItem", fields: ["name", "body"] },
  4037: { name: "DefListItem", fields: ["dt", "dd"] },
  4041: { name: "SubstitutionRef", fields: ["value"] },
  4045: { name: "Paragraph", fields: ["children"] },
  4046: { name: "Text", fields: ["value"] },
  4047: { name: "Emphasis", fields: ["children"] },
  4048: { name: "Strong", fields: ["children"] },
  4049: { name: "Link", fields: ["children", "url", "title"] },
  4050: { name: "Code", fields: ["value"] },
  4051: { name: "InlineCode", fields: ["value"] },
  4052: {
    name: "Directive",
    fields: ["name", "args", "options", "value", "children"],
  },
  4053: {
    name: "BulletList",
    fields: ["ordered", "start", "spread", "children"],
  },
  4054: { name: "ListItem", fields: ["spread", "children"] },
  4055: { name: "AdmonitionTitle", fields: ["children"] },
  4056: { name: "Admonition", fields: ["children", "kind"] },
  4057: { name: "InlineMath", fields: ["value"] },
  4058: { name: "Math", fields: ["value"] },
  4059: { name: "Blockquote", fields: ["children"] },
  4060: { name: "Comment", fields: ["value"] },
  4061: { name: "Target", fields: ["label"] },
  4062: { name: "Image", fields: ["url", "alt"] },
  4063: { name: "CitationReference", fields: ["label"] },
};

const TUPLE_TAG = 4444;

function buildTyped(tag: number, value: unknown): IRNode {
  if (tag === TUPLE_TAG) {
    return { __type: "tuple", __tag: tag, value: value } as TypedNode;
  }
  const spec = FIELD_ORDER[tag];
  if (!spec) return { __type: "unknown", __tag: tag, value };
  if (!Array.isArray(value)) return { __type: "unknown", __tag: tag, value };
  const node: TypedNode = { __type: spec.name, __tag: tag };
  spec.fields.forEach((fname, i) => {
    node[fname] = value[i];
  });
  return node;
}

let _extensionsRegistered = false;
function ensureExtensions(): void {
  if (_extensionsRegistered) return;
  _extensionsRegistered = true;
  addExtension({
    Class: Object as unknown as new (...a: unknown[]) => object,
    tag: TUPLE_TAG,
    encode() {
      throw new Error("viewer is read-only; encode not implemented");
    },
    decode(item: unknown) {
      return item;
    },
  });
  for (const tagStr of Object.keys(FIELD_ORDER)) {
    const tag = Number(tagStr);
    addExtension({
      Class: Object as unknown as new (...a: unknown[]) => object,
      tag,
      encode() {
        throw new Error("viewer is read-only; encode not implemented");
      },
      decode(item: unknown) {
        return buildTyped(tag, item);
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Typed shapes
// ---------------------------------------------------------------------------

export interface SectionNode {
  __type: "Section";
  __tag: 4015;
  children: IRNode[];
  title: string | null;
  level: number;
  target: string | null;
}

export interface SigParamT {
  __type: "SigParam";
  __tag: 4030;
  name: string;
  annotation: string | EmptyNode | null;
  kind: string;
  default: string | EmptyNode | null;
}

export interface EmptyNode {
  __type: "Empty";
  __tag: 4031;
}

export interface SignatureNodeT {
  __type: "SignatureNode";
  __tag: 4029;
  kind: string;
  parameters: SigParamT[];
  return_annotation: string | EmptyNode;
  target_name: string;
}

export interface IngestedDoc {
  __type: "IngestedDoc";
  __tag: 4010;
  _content: Record<string, SectionNode>;
  _ordered_sections: string[];
  item_file: string | null;
  item_line: number | null;
  item_type: string | null;
  aliases: string[];
  example_section_data: SectionNode | null;
  see_also: IRNode[];
  signature: SignatureNodeT | null;
  references: string[] | null;
  qa: string;
  arbitrary: SectionNode[];
}

// ---------------------------------------------------------------------------
// Bundle file readers
// ---------------------------------------------------------------------------

function decodeCbor<T>(raw: Uint8Array): T {
  ensureExtensions();
  const dec = new Decoder({ mapsAsObjects: true });
  return dec.decode(raw) as T;
}

/** Read and decode a CBOR blob from a bundle. Key is relative to bundle root. */
export async function loadBundleCbor<T = unknown>(
  pkg: string,
  ver: string,
  key: string,
): Promise<T> {
  const raw = await getStore().readBytes(pkg, ver, key);
  if (!raw) throw new Error(`Bundle file not found: ${pkg}/${ver}/${key}`);
  return decodeCbor<T>(raw);
}

/** Load one module blob (IngestedDoc) from the bundle's `module/` directory. */
export async function loadModule(
  pkg: string,
  ver: string,
  qualname: string,
): Promise<IngestedDoc> {
  ensureExtensions();
  // Try without extension first, then with .cbor suffix.
  let raw = await getStore().readBytes(pkg, ver, `module/${qualname}`);
  if (!raw) raw = await getStore().readBytes(pkg, ver, `module/${qualname}.cbor`);
  if (!raw) {
    throw new Error(`Module not found: ${pkg}/${ver}/module/${qualname}`);
  }
  const dec = new Decoder({ mapsAsObjects: true });
  const obj = dec.decode(raw);
  if (obj && (obj as IRNode).__type === "IngestedDoc") return obj as IngestedDoc;
  if (obj instanceof Tag) {
    throw new Error(
      `expected IngestedDoc (tag 4010), got raw tag ${obj.tag} for ${qualname}`,
    );
  }
  throw new Error(
    `unexpected decode result for ${qualname}: ${typeof obj}`,
  );
}

// ---------------------------------------------------------------------------
// URL slug encoding
// ---------------------------------------------------------------------------

export function qualnameToSlug(qa: string): string {
  return qa.replace(/:/g, "$");
}

export function slugToQualname(slug: string): string {
  return slug.replace(/\$/g, ":");
}

// ---------------------------------------------------------------------------
// URL shaping for a RefInfo-shaped tuple
// ---------------------------------------------------------------------------

export interface LinkRef {
  pkg: string;
  ver: string;
  kind: string;
  path: string;
}

// ---------------------------------------------------------------------------
// Generic IR node collection.
//
// collectNodes walks a decoded IR tree and returns every node whose __type
// is in the given set. Callers can then filter/map the results to extract
// the specific fields they care about.
//
//   collectNodes(doc, new Set(["Math", "InlineMath"]))  → all math nodes
//   collectNodes(doc, new Set(["Code", "InlineCode"]))  → all code nodes
//   collectNodes(doc, new Set(["Figure", "Image"]))     → all image nodes
// ---------------------------------------------------------------------------

/**
 * Walk a decoded IR tree and return every node whose __type is in `types`.
 * Recurses into all array-typed and object-typed field values so nested
 * structures (Section > Paragraph > InlineMath, etc.) are fully traversed.
 */
export function collectNodes(
  node: unknown,
  types: ReadonlySet<string>,
  out: IRNode[] = [],
): IRNode[] {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const item of node) collectNodes(item, types, out);
    return out;
  }
  const n = node as Record<string, unknown>;
  if (typeof n.__type === "string" && types.has(n.__type)) {
    out.push(n as IRNode);
  }
  for (const val of Object.values(n)) {
    if (val && typeof val === "object") collectNodes(val, types, out);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Image collection — domain-specific wrapper around collectNodes that
// resolves Figure RefInfo references to viewer asset URLs.
// ---------------------------------------------------------------------------

export type FoundImgNode =
  | { kind: "Figure"; src: string; assetPath: string }
  | { kind: "Image"; src: string; alt: string };

export function collectImages(node: unknown): FoundImgNode[] {
  const out: FoundImgNode[] = [];
  for (const n of collectNodes(node, new Set(["Figure", "Image"]))) {
    if (n.__type === "Figure") {
      const ref = (n as TypedNode).value as
        | { module?: string; version?: string; kind?: string; path?: string }
        | undefined;
      if (ref?.kind === "assets" && ref.module && ref.version && ref.path) {
        const assetPath = String(ref.path);
        out.push({
          kind: "Figure",
          src: `/assets/${ref.module}/${ref.version}/${assetPath.replace(/:/g, "$")}`,
          assetPath,
        });
      }
    } else if (n.__type === "Image") {
      const url = String((n as TypedNode).url ?? "");
      if (url) out.push({ kind: "Image", src: url, alt: String((n as TypedNode).alt ?? "") });
    }
  }
  return out;
}

export function linkForRef(ref: LinkRef): string | null {
  switch (ref.kind) {
    case "module":
      return `/${ref.pkg}/${ref.ver}/${qualnameToSlug(ref.path)}/`;
    case "docs":
      return `/${ref.pkg}/${ref.ver}/docs/${encodeURIComponent(ref.path)}/`;
    case "examples":
      return `/${ref.pkg}/${ref.ver}/examples/${encodeURIComponent(ref.path)}/`;
    case "assets":
      return `/assets/${ref.pkg}/${ref.ver}/${ref.path.replace(/:/g, "$")}`;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Cross-ref pre-collection (used by pages to batch-resolve before rendering)
// ---------------------------------------------------------------------------

interface CrossRefNode {
  __type: "CrossRef";
  value?: string;
  reference?: {
    module?: string;
    version?: string;
    kind?: string;
    path?: string;
  } | null;
}

/** Walk an IR tree and collect all CrossRef nodes (deduped by ref key). */
export function collectCrossRefs(
  nodes: unknown[],
): Map<string, CrossRefNode> {
  const out = new Map<string, CrossRefNode>();
  function walk(node: unknown): void {
    if (!node || typeof node !== "object") return;
    const n = node as { __type?: string; [k: string]: unknown };
    if (n.__type === "CrossRef") {
      const ref = n.reference as CrossRefNode["reference"];
      if (ref?.module && ref.path && ref.kind) {
        const key = `${ref.module}|${ref.version ?? "?"}|${ref.kind}|${ref.path}`;
        if (!out.has(key)) out.set(key, n as CrossRefNode);
      }
    }
    for (const v of Object.values(n)) {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") walk(v);
    }
  }
  nodes.forEach(walk);
  return out;
}

export type XrefResolver = (node: unknown) => { url: string; label: string } | null;

/**
 * Pre-resolve all CrossRef nodes found in `nodes`. Returns a sync resolver
 * closure suitable for passing to `<IrNode resolveXref={...} />`.
 * Uses the graph singleton so middleware must run first.
 */
export async function buildXrefResolver(nodes: unknown[]): Promise<XrefResolver> {
  const refs = collectCrossRefs(nodes);
  const resolved = new Map<string, { url: string; label: string } | null>();

  await Promise.all(
    [...refs.entries()].map(async ([key, node]) => {
      const ref = node.reference!;
      if (ref.module === "current-module" || ref.kind === "to-resolve") {
        resolved.set(key, null);
        return;
      }
      const r = await resolveRef({
        pkg: ref.module!,
        ver: ref.version ?? "?",
        kind: ref.kind!,
        path: ref.path!,
      });
      if (!r) { resolved.set(key, null); return; }
      const url = linkForRef(r);
      resolved.set(key, url ? { url, label: node.value ?? "" } : null);
    }),
  );

  return (raw: unknown) => {
    const n = raw as CrossRefNode | null;
    if (!n?.reference) return null;
    const ref = n.reference;
    if (!ref.module || !ref.path || !ref.kind) return null;
    const key = `${ref.module}|${ref.version ?? "?"}|${ref.kind}|${ref.path}`;
    return resolved.get(key) ?? null;
  };
}
