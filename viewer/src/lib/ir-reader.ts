import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Decoder, Tag, addExtension } from "cbor-x";

// ---------------------------------------------------------------------------
// Ingest store. Structure: ~/.papyri/ingest/<pkg>/<ver>/{module,docs,...}.
// The viewer only consumes the ingest store; the gen dir (~/.papyri/data/)
// is a `papyri` CLI concern. See `viewer/PLAN.md`.
// ---------------------------------------------------------------------------

export function ingestDir(): string {
  return process.env.PAPYRI_INGEST_DIR ?? join(homedir(), ".papyri", "ingest");
}

export interface IngestedBundle {
  pkg: string;
  version: string;
  /** Absolute path to `<ingestDir>/<pkg>/<version>/`. */
  path: string;
}

export async function listIngestedBundles(
  root: string = ingestDir(),
): Promise<IngestedBundle[]> {
  let pkgs;
  try {
    pkgs = await readdir(root, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const out: IngestedBundle[] = [];
  for (const p of pkgs) {
    if (!p.isDirectory()) continue;
    const pkgPath = join(root, p.name);
    let vers;
    try {
      vers = await readdir(pkgPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const v of vers) {
      if (!v.isDirectory()) continue;
      out.push({ pkg: p.name, version: v.name, path: join(pkgPath, v.name) });
    }
  }
  out.sort((a, b) => `${a.pkg}/${a.version}`.localeCompare(`${b.pkg}/${b.version}`));
  return out;
}

/**
 * List qualnames under a bundle's `module/` directory, without the `.cbor`
 * extension (the ingest store actually doesn't use one; this tolerates both).
 */
export async function listModules(bundlePath: string): Promise<string[]> {
  const modDir = join(bundlePath, "module");
  let ents;
  try {
    ents = await readdir(modDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const names = ents
    .filter((e) => e.isFile())
    .map((e) => (e.name.endsWith(".cbor") ? e.name.slice(0, -5) : e.name));
  names.sort();
  return names;
}

// ---------------------------------------------------------------------------
// CBOR tag-based decoder.
//
// The papyri encoder writes each node as CBORTag(tag, [values...]) where the
// values array is positional, in the order given by `typing.get_type_hints`
// on the node class. Tag numbers come from `docs/IR.md` § "Node type
// registry". We translate the positional array back into a typed object
// here so the rest of the viewer can treat IR nodes as plain TS records.
// Unknown tags are returned as { __type: "unknown", tag, value } so the UI
// can degrade to a JSON dump instead of crashing.
// ---------------------------------------------------------------------------

// A node we recognised.
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

/** Field order per tag, from `get_type_hints(cls)` on the Python side. */
const FIELD_ORDER: Record<number, { name: string; fields: string[] }> = {
  4000: { name: "RefInfo", fields: ["module", "version", "kind", "path"] },
  4001: { name: "Root", fields: ["children"] },
  4002: { name: "CrossRef", fields: ["value", "reference", "kind", "anchor"] },
  4003: { name: "InlineRole", fields: ["value", "domain", "role"] },
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
};

/** Tag 4444: bare Python tuple; treated as a plain array. */
const TUPLE_TAG = 4444;

function buildTyped(tag: number, value: unknown): IRNode {
  if (tag === TUPLE_TAG) {
    // Shouldn't flow through here because we register an extension that
    // returns the raw array, but guard anyway.
    return { __type: "tuple", __tag: tag, value: value } as TypedNode;
  }
  const spec = FIELD_ORDER[tag];
  if (!spec) {
    return { __type: "unknown", __tag: tag, value };
  }
  if (!Array.isArray(value)) {
    // Degenerate: expected a positional array but got something else.
    return { __type: "unknown", __tag: tag, value };
  }
  const node: TypedNode = { __type: spec.name, __tag: tag };
  spec.fields.forEach((fname, i) => {
    node[fname] = value[i];
  });
  return node;
}

// Register a global cbor-x extension for every known tag so the decoder
// hands us typed nodes instead of `Tag` wrappers. cbor-x keys extensions by
// tag number, so re-registering on module reload is fine.
let _extensionsRegistered = false;
function ensureExtensions(): void {
  if (_extensionsRegistered) return;
  _extensionsRegistered = true;

  // Tuple tag → return the raw array (the IR is structure-typed; we don't
  // distinguish list vs tuple on the JS side).
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
// Typed shapes for the node types M1 actually reads. Everything else is
// accessed as a `TypedNode` / `UnknownNode` via `__type`.
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

/** Read one module blob from an ingest bundle dir and decode it. */
export async function loadModule(
  bundlePath: string,
  qualname: string,
): Promise<IngestedDoc> {
  ensureExtensions();
  const primary = join(bundlePath, "module", qualname);
  let raw: Buffer;
  try {
    raw = await readFile(primary);
  } catch {
    raw = await readFile(primary + ".cbor");
  }
  const dec = new Decoder({ mapsAsObjects: true });
  const obj = dec.decode(raw);
  if (obj && (obj as IRNode).__type === "IngestedDoc") {
    return obj as IngestedDoc;
  }
  // Some encoders hand back a raw Tag if our extension wasn't applied — this
  // shouldn't happen in practice, but provide a clear error.
  if (obj instanceof Tag) {
    throw new Error(
      `expected IngestedDoc (tag 4010), got raw tag ${obj.tag} for ${qualname}`,
    );
  }
  throw new Error(`unexpected decode result for ${qualname}: ${typeof obj}`);
}

/**
 * Generic CBOR loader that applies the IR tag extensions. Returns the decoded
 * value as-is; callers cast to the shape they expect (IngestedDoc, Section,
 * TocTree, or a plain-object meta dict).
 */
export async function loadCbor<T = unknown>(path: string): Promise<T> {
  ensureExtensions();
  const raw = await readFile(path);
  const dec = new Decoder({ mapsAsObjects: true });
  return dec.decode(raw) as T;
}

// ---------------------------------------------------------------------------
// URL slug encoding. Qualnames contain ':' (e.g. "papyri.gen:Config.__init__"),
// which is illegal on some filesystems and awkward in URLs. We encode to/from
// using a single "$" separator: "pkg.mod:Class.method" <-> "pkg.mod$Class.method".
// Dots are preserved, so the slug reads naturally in browser URL bars.
// If a qualname itself contained '$' that would collide, but Python qualnames
// never do.
// ---------------------------------------------------------------------------

export function qualnameToSlug(qa: string): string {
  return qa.replace(/:/g, "$");
}

export function slugToQualname(slug: string): string {
  return slug.replace(/\$/g, ":");
}

// ---------------------------------------------------------------------------
// URL shaping for a RefInfo-shaped tuple.
// `module` / `docs` / `examples` get the natural page URLs we render; `assets`
// gets a static path (actual asset serving is deferred to M3). Unknown kinds
// return null so the caller can render an unresolved span.
// ---------------------------------------------------------------------------

export interface LinkRef {
  pkg: string;
  ver: string;
  kind: string;
  path: string;
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
      // Colons are legal on disk but break Astro's URL-based path writer.
      // Same slug rule as qualnames: `:` -> `$`. Kept in sync with the
      // asset endpoint's `slugifyAssetPath`.
      return `/assets/${ref.pkg}/${ref.ver}/${ref.path.replace(/:/g, "$")}`;
    default:
      return null;
  }
}
