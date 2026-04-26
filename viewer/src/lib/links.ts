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

/** Qualname page: `/<pkg>/<ver>/<qa-with-colons-as-dollars>/`. */
export function linkForQualname(pkg: string, ver: string, qualname: string): string {
  return `/${pkg}/${ver}/${qualnameToSlug(qualname)}/`;
}

/**
 * Narrative doc page. Doc keys use ':' as the path separator (gen joins
 * directory components with ':'); we map ':' -> URL '/' so
 * `whatsnew:index` becomes `/<pkg>/<ver>/docs/whatsnew/index/`.
 */
export function linkForDoc(pkg: string, ver: string, docKey: string): string {
  return `/${pkg}/${ver}/docs/${encodeSegments(docKey.split(":"))}/`;
}

/** Example page. Example paths are real filesystem paths (already use '/'). */
export function linkForExample(pkg: string, ver: string, exPath: string): string {
  return `/${pkg}/${ver}/examples/${encodeSegments(exPath.split("/"))}/`;
}

/**
 * Asset URL. Asset filenames may contain ':' (qualnames are baked into
 * figure filenames like `fig-papyri.examples:example1-0.png`); we apply
 * the same `: -> $` slug rule as qualnames so the URL is path-safe. The
 * asset endpoint reverses the substitution when reading from disk.
 */
export function linkForAsset(pkg: string, ver: string, assetPath: string): string {
  return `/assets/${pkg}/${ver}/${qualnameToSlug(assetPath)}`;
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
