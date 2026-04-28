import { extname } from "node:path";
import { Decoder } from "cbor-x";
import type { BlobStore } from "papyri-ingest";
import { listFiles, listModules, loadCbor, type TypedNode } from "./ir-reader.ts";
import { linkForDoc, linkForExample, linkForLocalRef, linkForRef } from "./links.ts";

// ---------------------------------------------------------------------------
// Per-bundle view-model. Pages under [pkg]/[ver]/** call `loadBundleNav` to
// get everything the sidebar + bundle identity block need in one shot.
//
// The store layout is `<pkg>/<ver>/{meta,docs,examples,module,assets}/...`
// — the same shape under both the Node FsBlobStore and the Workers
// R2BlobStore. No fs paths leak out; every read goes through the
// `BlobStore` passed in.
// ---------------------------------------------------------------------------

export interface BundleMeta {
  module?: string;
  version?: string;
  /** Basename under `meta/` (newer ingest) or `assets/` (older). */
  logo?: string;
  summary?: string;
  homepage?: string;
  docspage?: string;
  pypi?: string;
  github_slug?: string;
  tag?: string;
  [key: string]: unknown;
}

export interface TocItem {
  title: string;
  href: string | null;
  children: TocItem[];
}

export interface NavEntry {
  name: string;
  href: string;
}

export interface BundleNav {
  pkg: string;
  version: string;
  meta: BundleMeta;
  logoDataUrl: string | null;
  toc: TocItem[];
  docs: NavEntry[];
  tutorials: NavEntry[];
  examples: NavEntry[];
  qualnames: string[];
  docsIndexHref: string | null;
}

// Per-process memo. Keyed by `<pkg>/<ver>` — the BlobStore singleton is
// stable per request, so caching by bundle id is correct. A fresh worker
// isolate / Node process gets a clean map.
const _navCache = new Map<string, Promise<BundleNav>>();

async function readMetaCbor(blobStore: BlobStore, pkg: string, ver: string): Promise<BundleMeta> {
  try {
    const raw = await blobStore.getMeta(pkg, ver);
    if (!raw) return {};
    const dec = new Decoder({ mapsAsObjects: true });
    const decoded = dec.decode(Buffer.from(raw));
    if (decoded && typeof decoded === "object") {
      return decoded as BundleMeta;
    }
  } catch {
    // empty view-model on decode error
  }
  return {};
}

const LOGO_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

async function logoDataUrl(
  blobStore: BlobStore,
  pkg: string,
  ver: string,
  logoName: string | undefined
): Promise<string | null> {
  // Prefer the canonical `<pkg>/<ver>/meta/logo.<ext>` written by
  // `Ingester._ingest_logo`; fall back to whatever `meta.logo` points at
  // under `assets/` for older bundles.
  const candidates: { kind: "meta" | "assets"; path: string }[] = [];

  const metaKeys = await blobStore.list(`${pkg}/${ver}/meta/`);
  for (const k of metaKeys) {
    const base = k.split("/").pop()!;
    if (base.startsWith("logo.")) candidates.push({ kind: "meta", path: base });
  }
  if (logoName) candidates.push({ kind: "assets", path: logoName });

  for (const c of candidates) {
    const bytes = await blobStore.get({ module: pkg, version: ver, kind: c.kind, path: c.path });
    if (!bytes) continue;
    const ext = extname(c.path).toLowerCase();
    const mime = LOGO_MIME[ext] ?? "application/octet-stream";
    const b64 = Buffer.from(bytes).toString("base64");
    return `data:${mime};base64,${b64}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// TocTree walk
// ---------------------------------------------------------------------------

interface RefInfoNode extends TypedNode {
  __type: "RefInfo";
  module: string;
  version: string;
  kind: string;
  path: string;
}

interface LocalRefNode extends TypedNode {
  __type: "LocalRef";
  kind: string;
  path: string;
}

interface TocTreeNode extends TypedNode {
  __type: "TocTree";
  children: TocTreeNode[];
  title: string | null;
  ref: LocalRefNode | null;
  open: boolean;
  current: boolean;
}

function tocRefHref(
  ref: LocalRefNode | RefInfoNode | null,
  pkg: string,
  version: string
): string | null {
  if (!ref) return null;
  return ref.__type === "RefInfo"
    ? linkForRef({ pkg: ref.module, ver: ref.version, kind: ref.kind, path: ref.path })
    : linkForLocalRef(ref, pkg, version);
}

function walkToc(node: TocTreeNode, pkg: string, version: string): TocItem {
  const title = node.title ?? node.ref?.path ?? "(untitled)";
  return {
    title,
    href: tocRefHref(node.ref ?? null, pkg, version),
    children: (node.children ?? []).map((n) => walkToc(n, pkg, version)),
  };
}

interface ReadTocResult {
  toc: TocItem[];
  rootHref: string | null;
}

async function readToc(blobStore: BlobStore, pkg: string, ver: string): Promise<ReadTocResult> {
  try {
    const raw = await loadCbor(blobStore, pkg, ver, "meta", "toc.cbor");
    if (Array.isArray(raw)) {
      return { toc: raw.map((n) => walkToc(n as TocTreeNode, pkg, ver)), rootHref: null };
    }
    if (raw && (raw as TocTreeNode).__type === "TocTree") {
      const t = walkToc(raw as TocTreeNode, pkg, ver);
      const rootHref = t.href;
      return { toc: t.children.length > 0 ? t.children : [t], rootHref };
    }
  } catch {
    // No toc.cbor → empty nav.
  }
  return { toc: [], rootHref: null };
}

/** Tutorials: doc files starting with `tutorial_` or under `tutorials/`. */
export function isTutorial(docPath: string): boolean {
  const base = docPath.split("/").pop() ?? docPath;
  if (base.startsWith("tutorial_")) return true;
  if (docPath.startsWith("tutorials/")) return true;
  return false;
}

function docsToEntries(
  pkg: string,
  version: string,
  paths: string[]
): { docs: NavEntry[]; tutorials: NavEntry[] } {
  const docs: NavEntry[] = [];
  const tutorials: NavEntry[] = [];
  for (const p of paths) {
    const entry: NavEntry = { name: p, href: linkForDoc(pkg, version, p) };
    if (isTutorial(p)) tutorials.push(entry);
    else docs.push(entry);
  }
  return { docs, tutorials };
}

function examplesToEntries(pkg: string, version: string, paths: string[]): NavEntry[] {
  return paths.map((p) => ({ name: p, href: linkForExample(pkg, version, p) }));
}

export async function listDocs(blobStore: BlobStore, pkg: string, ver: string): Promise<string[]> {
  return listFiles(blobStore, pkg, ver, "docs");
}

export async function listExamples(
  blobStore: BlobStore,
  pkg: string,
  ver: string
): Promise<string[]> {
  return listFiles(blobStore, pkg, ver, "examples");
}

async function buildNav(blobStore: BlobStore, pkg: string, version: string): Promise<BundleNav> {
  const [meta, tocResult, docPaths, examplePaths, qualnames] = await Promise.all([
    readMetaCbor(blobStore, pkg, version),
    readToc(blobStore, pkg, version),
    listDocs(blobStore, pkg, version),
    listExamples(blobStore, pkg, version),
    listModules(blobStore, pkg, version),
  ]);
  const url = await logoDataUrl(blobStore, pkg, version, meta.logo);
  const { docs, tutorials } = docsToEntries(pkg, version, docPaths);
  const examples = examplesToEntries(pkg, version, examplePaths);
  const docsIndexHref = tocResult.rootHref ?? docs.find((e) => e.name === "index")?.href ?? null;
  return {
    pkg,
    version,
    meta,
    logoDataUrl: url,
    toc: tocResult.toc,
    docs,
    tutorials,
    examples,
    qualnames,
    docsIndexHref,
  };
}

export async function loadBundleNav(
  blobStore: BlobStore,
  pkg: string,
  version: string
): Promise<BundleNav> {
  const id = `${pkg}/${version}`;
  const cached = _navCache.get(id);
  if (cached) return cached;
  const p = buildNav(blobStore, pkg, version);
  _navCache.set(id, p);
  return p;
}
