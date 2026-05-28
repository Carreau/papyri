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

import { qualnameToSlug } from "./slugs.ts";
import { getAdminHost, getDocsHost, originForHost } from "./surface.ts";

export interface LinkRef {
  pkg: string;
  ver: string;
  kind: string;
  path: string;
}

/** Encode each path segment for safe use in a URL path. */
function encodeSegments(parts: string[]): string {
  return parts.map(encodeURIComponent).join("/");
}

/** Qualname page: `/project/<pkg>/<ver>/<qa-with-colons-as-dollars>/`. */
export function linkForQualname(pkg: string, ver: string, qualname: string): string {
  return `/project/${pkg}/${ver}/${qualnameToSlug(qualname)}/`;
}

/**
 * Narrative doc page. Doc keys use ':' as the path separator (gen joins
 * directory components with ':'); we map ':' -> URL '/' so
 * `whatsnew:index` becomes `/project/<pkg>/<ver>/docs/whatsnew/index/`.
 */
export function linkForDoc(pkg: string, ver: string, docKey: string): string {
  return `/project/${pkg}/${ver}/docs/${encodeSegments(docKey.split(":"))}/`;
}

/** Example page. Example paths are real filesystem paths (already use '/'). */
export function linkForExample(pkg: string, ver: string, exPath: string): string {
  return `/project/${pkg}/${ver}/examples/${encodeSegments(exPath.split("/"))}/`;
}

/**
 * Asset URL. Asset filenames may contain ':' (qualnames are baked into
 * figure filenames like `fig-papyri.examples:example1-0.png`); we apply
 * the same `: -> $` slug rule as qualnames so the URL is path-safe. The
 * asset endpoint reverses the substitution when reading from disk.
 */
export function linkForAsset(pkg: string, ver: string, assetPath: string): string {
  return `/assets/project/${pkg}/${ver}/${qualnameToSlug(assetPath)}`;
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

/**
 * Cross-domain link from the admin surface to the docs surface (or vice
 * versa). Returns a relative path when the split is disabled (env var
 * unset), otherwise an absolute URL into the configured host so the
 * browser navigates across origins. `currentUrl` is used to copy the
 * scheme (http vs https) — pass `Astro.url` from pages.
 */
export function docsHref(path: string, currentUrl?: URL): string {
  const host = getDocsHost();
  if (!host) return path;
  const slash = path.startsWith("/") ? "" : "/";
  return `${originForHost(host, currentUrl)}${slash}${path}`;
}

export function adminHref(path: string, currentUrl?: URL): string {
  const host = getAdminHost();
  if (!host) return path;
  const slash = path.startsWith("/") ? "" : "/";
  return `${originForHost(host, currentUrl)}${slash}${path}`;
}
