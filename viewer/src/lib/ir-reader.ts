import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { decode as decodeIR } from "papyri-ingest";
import { IR_TYPE_NAMES } from "./ir-types.ts";
import { qualnameToSlug, slugToQualname } from "./slugs.ts";
export { qualnameToSlug, slugToQualname };

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

export async function listIngestedBundles(root: string = ingestDir()): Promise<IngestedBundle[]> {
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

// Decoding is delegated to `papyri-ingest`'s `decode()`, which uses a private
// cbor-x Decoder + post-walk (no global `addExtension` calls). This avoids
// contaminating the shared cbor-x extension registry — the SSR `/api/bundle`
// PUT handler runs the ingest encoder in the same process, and a global
// Object-keyed encode handler would break every CBOR encode in that path.
// FIELD_ORDER (the source of truth) lives in `papyri-ingest/src/encoder.ts`.

/** All IR node type names known to this decoder. */
export const ALL_NODE_TYPES: ReadonlySet<string> = new Set(IR_TYPE_NAMES);

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

/** Safely return the children of a SectionNode, guarding against malformed CBOR. */
export function sectionChildren(s: SectionNode): IRNode[] {
  return Array.isArray(s.children) ? s.children : [];
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
export async function loadModule(bundlePath: string, qualname: string): Promise<IngestedDoc> {
  const primary = join(bundlePath, "module", qualname);
  let raw: Buffer;
  try {
    raw = await readFile(primary);
  } catch {
    raw = await readFile(primary + ".cbor");
  }
  const obj = decodeIR<IRNode>(raw);
  if (obj && (obj as IRNode).__type === "IngestedDoc") {
    return obj as unknown as IngestedDoc;
  }
  throw new Error(`unexpected decode result for ${qualname}: ${typeof obj}`);
}

/**
 * Generic CBOR loader. Returns the decoded value as-is; callers cast to the
 * shape they expect (IngestedDoc, Section, TocTree, or a plain-object meta
 * dict).
 */
export async function loadCbor<T = unknown>(path: string): Promise<T> {
  const raw = await readFile(path);
  return decodeIR<T>(raw);
}

/**
 * Decode raw CBOR bytes (same as loadCbor but takes an already-read buffer
 * instead of a path). Used by the ingest pipeline, which reads bytes through
 * a StorageBackend rather than directly from disk.
 */
export function decodeCborBytes<T = unknown>(bytes: Uint8Array | Buffer): T {
  return decodeIR<T>(bytes);
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
  out: IRNode[] = []
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
      return `/${ref.pkg}/${ref.ver}/docs/${ref.path.split(":").map(encodeURIComponent).join("/")}/`;
    case "examples":
      return `/${ref.pkg}/${ref.ver}/examples/${ref.path.split("/").map(encodeURIComponent).join("/")}/`;
    case "assets":
      // Colons are legal on disk but break Astro's URL-based path writer.
      // Same slug rule as qualnames: `:` -> `$`. Kept in sync with the
      // asset endpoint's `slugifyAssetPath`.
      return `/assets/${ref.pkg}/${ref.ver}/${ref.path.replace(/:/g, "$")}`;
    default:
      return null;
  }
}
