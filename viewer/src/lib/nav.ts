import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";
import { Decoder } from "cbor-x";
import { listModules, loadCbor, type TypedNode } from "./ir-reader.ts";

// ---------------------------------------------------------------------------
// Per-bundle view-model. Pages under [pkg]/[ver]/** call `loadBundleNav` to
// get everything the sidebar + bundle identity block need in one shot. Read
// lives here so `ir-reader.ts` stays focused on on-disk decoding primitives.
//
// §0 of viewer/TODO.md makes the ingest store the single source of truth:
// `meta.cbor` carries `{module, version, logo, summary, ...}` and the logo
// file itself is copied into `<bundle>/meta/logo.<ext>`. Older bundles that
// predate the logo copy step still have the logo in `assets/`; we fall back
// there so the viewer works against a mixed ingest.
// ---------------------------------------------------------------------------

export interface BundleMeta {
  module?: string;
  version?: string;
  /** Basename under `meta/` (newer ingest) or `assets/` (older). */
  logo?: string;
  /** Plain-text first paragraph of the module summary. */
  summary?: string;
  homepage?: string;
  docspage?: string;
  pypi?: string;
  github_slug?: string;
  tag?: string;
  [key: string]: unknown;
}

/** Sidebar TocTree node view — title + href + children. No CBOR details. */
export interface TocItem {
  title: string;
  /** Resolved viewer URL, or null if the ref couldn't be shaped. */
  href: string | null;
  children: TocItem[];
}

/** A doc/example entry rendered in the sidebar as a flat link. */
export interface NavEntry {
  /** Path segment under docs/ or examples/ (e.g. "crossrefs" or
   *  "simple_plot.py"). Used both for URL and as a fallback label. */
  name: string;
  /** Resolved viewer URL. */
  href: string;
}

export interface BundleNav {
  pkg: string;
  version: string;
  bundlePath: string;
  meta: BundleMeta;
  /** `data:` URI if we found the logo on disk, else null. */
  logoDataUrl: string | null;
  /** Walked TocTree (root-level entries). Empty if `meta/toc.cbor` is absent. */
  toc: TocItem[];
  docs: NavEntry[];
  tutorials: NavEntry[];
  examples: NavEntry[];
  qualnames: string[];
}

// ---------------------------------------------------------------------------
// Per-build memoisation. Astro calls into these helpers once per page, and
// many pages share the same bundle; caching keeps the CBOR round-trip off
// the hot path. The keys include the bundle path so multiple bundles
// coexist; a fresh Node process gets a clean map.
// ---------------------------------------------------------------------------
const _navCache = new Map<string, Promise<BundleNav>>();

async function readMetaCbor(bundlePath: string): Promise<BundleMeta> {
  try {
    const raw = await readFile(join(bundlePath, "meta.cbor"));
    const dec = new Decoder({ mapsAsObjects: true });
    const decoded = dec.decode(raw);
    if (decoded && typeof decoded === "object") {
      return decoded as BundleMeta;
    }
  } catch {
    // Bundles without meta.cbor get an empty view-model; the sidebar still
    // renders using pkg/version from the URL.
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
  bundlePath: string,
  logoName: string | undefined,
): Promise<string | null> {
  // `meta/logo.*` is what `Ingester._ingest_logo` writes; older ingests
  // didn't do that, so fall back to whatever basename meta.cbor points at
  // under `assets/`.
  const candidates: string[] = [];
  try {
    const metaEntries = await readdir(join(bundlePath, "meta"));
    for (const e of metaEntries) {
      if (e.startsWith("logo.")) candidates.push(join(bundlePath, "meta", e));
    }
  } catch {
    // No meta dir — fine.
  }
  if (logoName) {
    candidates.push(join(bundlePath, "assets", logoName));
  }
  for (const path of candidates) {
    try {
      const buf = await readFile(path);
      const ext = extname(path).toLowerCase();
      const mime = LOGO_MIME[ext] ?? "application/octet-stream";
      return `data:${mime};base64,${buf.toString("base64")}`;
    } catch {
      // Try the next one.
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// TocTree walk. `meta/toc.cbor` is either a single TocTree (tag 4021) or a
// list of TocTree entries (papyri sometimes writes the root as a list). The
// decoder hands us typed nodes courtesy of the shared extensions in
// ir-reader.ts.
// ---------------------------------------------------------------------------
interface RefInfoNode extends TypedNode {
  __type: "RefInfo";
  module: string;
  version: string;
  kind: string;
  path: string;
}

interface TocTreeNode extends TypedNode {
  __type: "TocTree";
  children: TocTreeNode[];
  title: string | null;
  ref: RefInfoNode | null;
  open: boolean;
  current: boolean;
}

function refToHref(ref: RefInfoNode | null): string | null {
  if (!ref) return null;
  const { module, version, kind, path } = ref;
  switch (kind) {
    case "module":
      return `/${module}/${version}/${path.replace(/:/g, "$")}/`;
    case "docs":
      return `/${module}/${version}/docs/${path
        .split("/")
        .map(encodeURIComponent)
        .join("/")}/`;
    case "examples":
      return `/${module}/${version}/examples/${path
        .split("/")
        .map(encodeURIComponent)
        .join("/")}/`;
    default:
      return null;
  }
}

function walkToc(node: TocTreeNode): TocItem {
  const title = node.title ?? node.ref?.path ?? "(untitled)";
  return {
    title,
    href: refToHref(node.ref ?? null),
    children: (node.children ?? []).map(walkToc),
  };
}

async function readToc(bundlePath: string): Promise<TocItem[]> {
  try {
    const raw = await loadCbor(join(bundlePath, "meta", "toc.cbor"));
    if (Array.isArray(raw)) {
      return raw.map((n) => walkToc(n as TocTreeNode));
    }
    if (raw && (raw as TocTreeNode).__type === "TocTree") {
      // Single-root case: unwrap so the sidebar isn't wrapped in an extra
      // layer (unless the root itself carries a title + no children).
      const t = walkToc(raw as TocTreeNode);
      return t.children.length > 0 ? t.children : [t];
    }
  } catch {
    // No toc → empty nav.
  }
  return [];
}

// ---------------------------------------------------------------------------
// File listings for docs/ / examples/ / assets/. Walked recursively so
// nested layouts (docs/tutorials/*, fig-*.png under assets/) come through.
// Each entry is a relative POSIX-style path; URL encoding happens at the
// consumer. Exposed because the assets endpoint (`src/pages/assets/...`)
// reuses the same walker.
// ---------------------------------------------------------------------------
export async function listFilesRecursive(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let ents;
    try {
      ents = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.isFile()) {
        const rel = relative(root, full);
        // Normalise to forward slashes for URL shaping (matters on Windows).
        out.push(rel.split(sep).join("/"));
      }
    }
  }
  await walk(root);
  out.sort();
  return out;
}

/**
 * Tutorials are doc files that begin with `tutorial_` or live under
 * `docs/tutorials/`. Matches the filename convention documented in
 * `docs/IR.md` and TODO §0.
 */
export function isTutorial(docPath: string): boolean {
  const base = docPath.split("/").pop() ?? docPath;
  if (base.startsWith("tutorial_")) return true;
  if (docPath.startsWith("tutorials/")) return true;
  return false;
}

function encodeDocPath(p: string): string {
  return p.split("/").map(encodeURIComponent).join("/");
}

function docsToEntries(
  pkg: string,
  version: string,
  paths: string[],
): { docs: NavEntry[]; tutorials: NavEntry[] } {
  const docs: NavEntry[] = [];
  const tutorials: NavEntry[] = [];
  for (const p of paths) {
    const href = `/${pkg}/${version}/docs/${encodeDocPath(p)}/`;
    const entry: NavEntry = { name: p, href };
    if (isTutorial(p)) tutorials.push(entry);
    else docs.push(entry);
  }
  return { docs, tutorials };
}

function examplesToEntries(
  pkg: string,
  version: string,
  paths: string[],
): NavEntry[] {
  return paths.map((p) => ({
    name: p,
    href: `/${pkg}/${version}/examples/${encodeDocPath(p)}/`,
  }));
}

export async function listDocs(bundlePath: string): Promise<string[]> {
  return listFilesRecursive(join(bundlePath, "docs"));
}

export async function listExamples(bundlePath: string): Promise<string[]> {
  return listFilesRecursive(join(bundlePath, "examples"));
}

async function buildNav(
  pkg: string,
  version: string,
  bundlePath: string,
): Promise<BundleNav> {
  const [meta, toc, docPaths, examplePaths, qualnames] = await Promise.all([
    readMetaCbor(bundlePath),
    readToc(bundlePath),
    listDocs(bundlePath),
    listExamples(bundlePath),
    listModules(bundlePath),
  ]);
  const url = await logoDataUrl(bundlePath, meta.logo);
  const { docs, tutorials } = docsToEntries(pkg, version, docPaths);
  const examples = examplesToEntries(pkg, version, examplePaths);
  return {
    pkg,
    version,
    bundlePath,
    meta,
    logoDataUrl: url,
    toc,
    docs,
    tutorials,
    examples,
    qualnames,
  };
}

export async function loadBundleNav(
  pkg: string,
  version: string,
  bundlePath: string,
): Promise<BundleNav> {
  const cached = _navCache.get(bundlePath);
  if (cached) return cached;
  const p = buildNav(pkg, version, bundlePath);
  _navCache.set(bundlePath, p);
  return p;
}
