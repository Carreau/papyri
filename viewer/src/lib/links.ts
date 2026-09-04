// URL shaping for every viewer-facing route.
//
// Single source of truth for the path encoding rules; before this module
// existed they were spread across ir-reader.ts (linkForRef), nav.ts
// (refToHref + encodeDocKey + encodeExPath), the asset endpoint
// (slugifyAssetPath), and a handful of inline `qa.replace(/:/g, "$")` /
// `path.split("/").map(encodeURIComponent)` constructions.
//
// All URLs returned here include leading and trailing slashes where
// applicable so callers can drop them straight into `<a href>`.
//
// TypeScript template-literal return types enforce URL shape at compile time:
// a function that expects a BundleHref will reject a QualnameHref or a plain
// string literal, catching mismatched route usage before it reaches the browser.

import { qualnameToSlug } from "./slugs.ts";
import { withBase } from "./url-base.ts";

export interface LinkRef {
  pkg: string;
  ver: string;
  kind: string;
  path: string;
}

// ---------------------------------------------------------------------------
// Typed URL aliases — structural, not branded. Useful as parameter types when
// a function only makes sense for a specific route shape.
// ---------------------------------------------------------------------------

export type PkgHref = `${string}/project/${string}/`;
export type BundleHref = `${string}/project/${string}/${string}/`;
export type QualnameHref = `${string}/project/${string}/${string}/${string}/`;
export type DocHref = `${string}/project/${string}/${string}/docs/${string}/`;
export type ExampleHref = `${string}/project/${string}/${string}/examples/${string}/`;
export type TextSearchHref = `${string}/project/${string}/${string}/text-search/`;
export type ImagesHref = `${string}/project/${string}/${string}/images/`;
export type NodesHref = `${string}/project/${string}/${string}/nodes/`;
export type NodeTypeHref = `${string}/project/${string}/${string}/nodes/${string}/`;
export type DiffHref = `${string}/project/${string}/diff`;

// ---------------------------------------------------------------------------
// Parameter-free (static) viewer routes. Use VIEWER_ROUTES.xxx instead of
// hard-coding strings so a route rename is a single-file change.
// ---------------------------------------------------------------------------

export const VIEWER_ROUTES = {
  home: "/",
  globalNodes: "/nodes/",
  globalTextSearch: "/text-search/",
  irStats: "/ir-stats/",
  admin: "/admin/",
  login: "/login",
} as const;

export type ViewerRoute = (typeof VIEWER_ROUTES)[keyof typeof VIEWER_ROUTES];

/** Static routes that address *a store* and so belong to the active namespace. */
type StoreScopedRoute = "home" | "globalNodes" | "globalTextSearch" | "irStats";

/**
 * A static route, prefixed for the active namespace. Inside a PR preview this
 * keeps store-scoped routes (the bundle index, the node browser, …) within the
 * preview; `/admin` and `/login` stay global and are used raw.
 */
export function viewerRoute(name: StoreScopedRoute): string {
  return withBase(VIEWER_ROUTES[name]);
}

// ---------------------------------------------------------------------------
// Dynamic route helpers — one function per viewer page type.
// ---------------------------------------------------------------------------

/** Encode each path segment for safe use in a URL path. */
function encodeSegments(parts: string[]): string {
  return parts.map(encodeURIComponent).join("/");
}

/** Package overview: `/project/<pkg>/`. */
export function linkForPkg(pkg: string): PkgHref {
  return withBase(`/project/${pkg}/`);
}

/** Bundle home: `/project/<pkg>/<ver>/`. */
export function linkForBundle(pkg: string, ver: string): BundleHref {
  return withBase(`/project/${pkg}/${ver}/`);
}

/** Qualname page: `/project/<pkg>/<ver>/<qa-with-colons-as-dollars>/`. */
export function linkForQualname(pkg: string, ver: string, qualname: string): QualnameHref {
  return withBase(`/project/${pkg}/${ver}/${qualnameToSlug(qualname)}/`);
}

/**
 * Narrative doc page. Doc keys use ':' as the path separator (gen joins
 * directory components with ':'); we map ':' -> URL '/' so
 * `whatsnew:index` becomes `/project/<pkg>/<ver>/docs/whatsnew/index/`.
 */
export function linkForDoc(pkg: string, ver: string, docKey: string): DocHref {
  return withBase(`/project/${pkg}/${ver}/docs/${encodeSegments(docKey.split(":"))}/`);
}

/** Example page. Example paths are real filesystem paths (already use '/'). */
export function linkForExample(pkg: string, ver: string, exPath: string): ExampleHref {
  return withBase(`/project/${pkg}/${ver}/examples/${encodeSegments(exPath.split("/"))}/`);
}

/**
 * Asset URL. Asset filenames may contain ':' (qualnames are baked into
 * figure filenames like `fig-papyri.examples:example1-0.png`); we apply
 * the same `: -> $` slug rule as qualnames so the URL is path-safe. The
 * asset endpoint reverses the substitution when reading from disk.
 */
export function linkForAsset(pkg: string, ver: string, assetPath: string): string {
  return withBase(`/assets/project/${pkg}/${ver}/${qualnameToSlug(assetPath)}`);
}

/** Full-text search page for a bundle. */
export function linkForTextSearch(pkg: string, ver: string): TextSearchHref {
  return withBase(`/project/${pkg}/${ver}/text-search/`);
}

/** Image gallery for a bundle. */
export function linkForImages(pkg: string, ver: string): ImagesHref {
  return withBase(`/project/${pkg}/${ver}/images/`);
}

/** Node browser root for a bundle. */
export function linkForNodes(pkg: string, ver: string): NodesHref {
  return withBase(`/project/${pkg}/${ver}/nodes/`);
}

/** Node browser filtered to a specific IR node type within a bundle. */
export function linkForNodeType(pkg: string, ver: string, nodeType: string): NodeTypeHref {
  return withBase(`/project/${pkg}/${ver}/nodes/${nodeType}/`);
}

/** Version diff page for a package. */
export function linkForDiff(pkg: string): DiffHref {
  return withBase(`/project/${pkg}/diff`);
}

/** Unresolved-outgoing-refs diagnostic page for a bundle. */
export function linkForValidate(
  pkg: string,
  ver: string
): `${string}/project/${string}/${string}/validate` {
  return withBase(`/project/${pkg}/${ver}/validate`);
}

/** Broken back-references diagnostic page for a bundle. */
export function linkForBackrefValidate(
  pkg: string,
  ver: string
): `${string}/project/${string}/${string}/backref-validate` {
  return withBase(`/project/${pkg}/${ver}/backref-validate`);
}

/** Per-bundle search index (API endpoint). */
export function linkForSearchJson(
  pkg: string,
  ver: string
): `${string}/project/${string}/${string}/search.json` {
  return withBase(`/project/${pkg}/${ver}/search.json`);
}

/**
 * Dispatch a `RefInfo`-shaped tuple to the right `linkFor*` helper. Returns
 * null for kinds that don't have a viewer URL (e.g. `meta`).
 */
export function linkForRef(ref: LinkRef): string | null {
  switch (ref.kind) {
    case "module":
      return linkForQualname(ref.pkg, ref.ver, ref.path);
    case "docs":
      return linkForDoc(ref.pkg, ref.ver, ref.path);
    case "examples":
      return linkForExample(ref.pkg, ref.ver, ref.path);
    case "assets":
      return linkForAsset(ref.pkg, ref.ver, ref.path);
    default:
      return null;
  }
}

/**
 * Like `linkForRef` but for local refs that carry no `(pkg, ver)`; the
 * bundle context supplies them.
 */
export function linkForLocalRef(
  ref: { kind: string; path: string },
  pkg: string,
  ver: string
): string | null {
  return linkForRef({ pkg, ver, kind: ref.kind, path: ref.path });
}
