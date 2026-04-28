// Async readers over the ingest store, backed by `BlobStore`.
//
// The store layout is `<pkg>/<ver>/<kind>/<path>` — under both the Node
// `FsBlobStore` (~/.papyri/ingest) and the Workers `R2BlobStore` (the
// papyri-viewer-blobs bucket). This file holds the high-level reader
// helpers used by every page; backend selection happens in
// `viewer/src/lib/backends.ts`.
//
// The on-disk encoding is CBOR with papyri's tag-numbered IR. We delegate
// decoding to `papyri-ingest`'s `decode()`, which uses a private cbor-x
// Decoder + post-walk so the global cbor-x extension registry isn't
// shared with the SSR ingest encoder running in the same process.

import { decode as decodeIR, type BlobStore } from "papyri-ingest";
import { IR_TYPE_NAMES } from "./ir-types.ts";
import { linkForAsset } from "./links.ts";
import { qualnameToSlug, slugToQualname } from "./slugs.ts";
export { qualnameToSlug, slugToQualname };

// ---------------------------------------------------------------------------
// Bundle / qualname listings
// ---------------------------------------------------------------------------

export interface IngestedBundle {
  pkg: string;
  version: string;
}

/**
 * Compare two version strings; later version sorts first.
 * Best-effort: numeric segments are compared numerically, the rest
 * falls back to localeCompare. Good enough for typical PEP 440 strings;
 * not a full semver/PEP 440 parser.
 */
export function compareVersionsDesc(a: string, b: string): number {
  const pa = a.split(/[.\-+]/);
  const pb = b.split(/[.\-+]/);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const sa = pa[i] ?? "";
    const sb = pb[i] ?? "";
    const na = /^\d+$/.test(sa) ? Number(sa) : NaN;
    const nb = /^\d+$/.test(sb) ? Number(sb) : NaN;
    if (!Number.isNaN(na) && !Number.isNaN(nb)) {
      if (na !== nb) return nb - na;
      continue;
    }
    const cmp = sa.localeCompare(sb);
    if (cmp !== 0) return -cmp;
  }
  return 0;
}

export interface IngestedPackage {
  pkg: string;
  versions: string[];
  latest: string;
}

/** Distinct packages with their versions, latest first. */
export async function listIngestedPackages(blobStore: BlobStore): Promise<IngestedPackage[]> {
  const bundles = await listIngestedBundles(blobStore);
  const byPkg = new Map<string, string[]>();
  for (const b of bundles) {
    const arr = byPkg.get(b.pkg) ?? [];
    arr.push(b.version);
    byPkg.set(b.pkg, arr);
  }
  const out: IngestedPackage[] = [];
  for (const [pkg, versions] of byPkg) {
    versions.sort(compareVersionsDesc);
    out.push({ pkg, versions, latest: versions[0]! });
  }
  out.sort((a, b) => a.pkg.localeCompare(b.pkg));
  return out;
}

/** Distinct (pkg, version) pairs that have any blob in the store. */
export async function listIngestedBundles(blobStore: BlobStore): Promise<IngestedBundle[]> {
  const keys = await blobStore.list("");
  const seen = new Set<string>();
  const out: IngestedBundle[] = [];
  for (const k of keys) {
    const parts = k.split("/");
    if (parts.length < 3) continue;
    const pkg = parts[0]!;
    const version = parts[1]!;
    const id = `${pkg}/${version}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ pkg, version });
  }
  out.sort((a, b) => `${a.pkg}/${a.version}`.localeCompare(`${b.pkg}/${b.version}`));
  return out;
}

/** Qualnames under `<pkg>/<ver>/module/`. Sorted. */
export async function listModules(
  blobStore: BlobStore,
  pkg: string,
  version: string
): Promise<string[]> {
  const prefix = `${pkg}/${version}/module/`;
  const keys = await blobStore.list(prefix);
  const out: string[] = [];
  for (const k of keys) {
    const rel = k.slice(prefix.length);
    if (!rel || rel.includes("/")) continue;
    out.push(rel.endsWith(".cbor") ? rel.slice(0, -5) : rel);
  }
  out.sort();
  return out;
}

/**
 * Files under `<pkg>/<ver>/<kind>/`, recursive, returned as POSIX-style
 * paths relative to the kind dir (matching the old `listFilesRecursive`
 * shape). Used for docs/, examples/, assets/.
 */
export async function listFiles(
  blobStore: BlobStore,
  pkg: string,
  version: string,
  kind: string
): Promise<string[]> {
  const prefix = `${pkg}/${version}/${kind}/`;
  const keys = await blobStore.list(prefix);
  const rels = keys.map((k) => k.slice(prefix.length)).filter((r) => r.length > 0);
  rels.sort();
  return rels;
}

// ---------------------------------------------------------------------------
// Decoding helpers
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

export const ALL_NODE_TYPES: ReadonlySet<string> = new Set(IR_TYPE_NAMES);

export interface SectionNode {
  __type: "Section";
  __tag: 4015;
  children: IRNode[];
  title: string | null;
  level: number;
  target: string | null;
}

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

/** Decode raw CBOR bytes (re-export of papyri-ingest's decoder). */
export function decodeCborBytes<T = unknown>(bytes: Uint8Array | Buffer): T {
  return decodeIR<T>(bytes);
}

// ---------------------------------------------------------------------------
// Per-key loaders
// ---------------------------------------------------------------------------

/** Load a module-page IngestedDoc by qualname. Throws if absent or wrong type. */
export async function loadModule(
  blobStore: BlobStore,
  pkg: string,
  version: string,
  qualname: string
): Promise<IngestedDoc> {
  // Ingester writes `module/<qualname>` (no .cbor) on the gen→ingest path,
  // but older bundles or alternate writers may have used `.cbor`. Try both.
  let bytes = await blobStore.get({ module: pkg, version, kind: "module", path: qualname });
  if (!bytes) {
    bytes = await blobStore.get({
      module: pkg,
      version,
      kind: "module",
      path: `${qualname}.cbor`,
    });
  }
  if (!bytes) throw new Error(`module not found: ${pkg}/${version}/${qualname}`);
  const obj = decodeIR<IRNode>(bytes);
  if (obj && (obj as IRNode).__type === "IngestedDoc") {
    return obj as unknown as IngestedDoc;
  }
  throw new Error(`unexpected decode result for ${qualname}: ${typeof obj}`);
}

/** Generic loader: read `<pkg>/<ver>/<kind>/<path>` and CBOR-decode it. */
export async function loadCbor<T = unknown>(
  blobStore: BlobStore,
  pkg: string,
  version: string,
  kind: string,
  path: string
): Promise<T> {
  const bytes = await blobStore.get({ module: pkg, version, kind, path });
  if (!bytes) throw new Error(`blob not found: ${pkg}/${version}/${kind}/${path}`);
  return decodeIR<T>(bytes);
}

/** Read raw asset bytes (no decode). Returns null if absent. */
export async function loadAsset(
  blobStore: BlobStore,
  pkg: string,
  version: string,
  path: string
): Promise<Uint8Array | null> {
  return blobStore.get({ module: pkg, version, kind: "assets", path });
}

// ---------------------------------------------------------------------------
// Generic IR node collection
// ---------------------------------------------------------------------------

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
// Image collection
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
          src: linkForAsset(ref.module, ref.version, assetPath),
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
