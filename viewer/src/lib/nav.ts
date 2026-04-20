import { Decoder } from "cbor-x";
import { getStore } from "./storage.ts";
import { listModules, loadBundleCbor, type TypedNode } from "./ir-reader.ts";

// ---------------------------------------------------------------------------
// Per-bundle view-model. Pages under [pkg]/[ver]/** call `loadBundleNav` to
// get everything the sidebar + bundle identity block need in one shot.
// ---------------------------------------------------------------------------

export interface BundleMeta {
  module?: string;
  version?: string;
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
}

// ---------------------------------------------------------------------------
// Per-request memoisation. Key is "<pkg>/<ver>".
// ---------------------------------------------------------------------------
const _navCache = new Map<string, Promise<BundleNav>>();

async function readMetaCbor(pkg: string, ver: string): Promise<BundleMeta> {
  try {
    const raw = await getStore().readBytes(pkg, ver, "meta.cbor");
    if (!raw) return {};
    const dec = new Decoder({ mapsAsObjects: true });
    const decoded = dec.decode(raw);
    if (decoded && typeof decoded === "object") return decoded as BundleMeta;
  } catch {
    // fall through
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
  pkg: string,
  ver: string,
  logoName: string | undefined,
): Promise<string | null> {
  const store = getStore();
  // Try meta/logo.* first (new ingests).
  const metaFiles = await store.listDir(pkg, ver, "meta");
  for (const f of metaFiles) {
    if (!f.startsWith("logo.")) continue;
    const raw = await store.readBytes(pkg, ver, `meta/${f}`);
    if (!raw) continue;
    const ext = f.slice(f.lastIndexOf(".")).toLowerCase();
    const mime = LOGO_MIME[ext] ?? "application/octet-stream";
    return `data:${mime};base64,${Buffer.from(raw).toString("base64")}`;
  }
  // Fall back to assets/<logoName> for older ingests.
  if (logoName) {
    const raw = await store.readBytes(pkg, ver, `assets/${logoName}`);
    if (raw) {
      const ext = logoName
        .slice(logoName.lastIndexOf("."))
        .toLowerCase();
      const mime = LOGO_MIME[ext] ?? "application/octet-stream";
      return `data:${mime};base64,${Buffer.from(raw).toString("base64")}`;
    }
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

async function readToc(pkg: string, ver: string): Promise<TocItem[]> {
  try {
    const raw = await loadBundleCbor(pkg, ver, "meta/toc.cbor");
    if (Array.isArray(raw)) {
      return raw.map((n) => walkToc(n as TocTreeNode));
    }
    if (raw && (raw as TocTreeNode).__type === "TocTree") {
      const t = walkToc(raw as TocTreeNode);
      return t.children.length > 0 ? t.children : [t];
    }
  } catch {
    // No toc → empty nav.
  }
  return [];
}

// ---------------------------------------------------------------------------
// File listings
// ---------------------------------------------------------------------------

/** List all files under a bundle subdir. Returns relative paths. */
export async function listBundleFiles(
  pkg: string,
  ver: string,
  subdir: string,
): Promise<string[]> {
  return getStore().listDir(pkg, ver, subdir);
}

/** Tutorials are doc files that begin with `tutorial_` or live under `tutorials/`. */
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

export async function listDocs(pkg: string, ver: string): Promise<string[]> {
  return getStore().listDir(pkg, ver, "docs");
}

export async function listExamples(
  pkg: string,
  ver: string,
): Promise<string[]> {
  return getStore().listDir(pkg, ver, "examples");
}

async function buildNav(
  pkg: string,
  version: string,
): Promise<BundleNav> {
  const [meta, toc, docPaths, examplePaths, qualnames] = await Promise.all([
    readMetaCbor(pkg, version),
    readToc(pkg, version),
    listDocs(pkg, version),
    listExamples(pkg, version),
    listModules(pkg, version),
  ]);
  const url = await logoDataUrl(pkg, version, meta.logo);
  const { docs, tutorials } = docsToEntries(pkg, version, docPaths);
  const examples = examplesToEntries(pkg, version, examplePaths);
  return {
    pkg,
    version,
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
): Promise<BundleNav> {
  const cacheKey = `${pkg}/${version}`;
  const cached = _navCache.get(cacheKey);
  if (cached) return cached;
  const p = buildNav(pkg, version);
  _navCache.set(cacheKey, p);
  return p;
}

// Kept for the assets endpoint.
export { listBundleFiles as listFilesRecursive };

export function clearNavCache(): void {
  _navCache.clear();
}
