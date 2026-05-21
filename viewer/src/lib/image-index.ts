// Bundle-wide image index: walks every module, narrative doc, and
// example, collects every Figure / Image IR node, and groups by source
// URL. Pulled out of `pages/[pkg]/[ver]/images/index.astro` so the
// page becomes a flat template over the returned entries.

import type { BlobStore } from "papyri-ingest";
import { collectImages, type FoundImgNode } from "./ir-reader.ts";
import { walkBundle, type PageRef } from "./bundle-walk.ts";

export type { PageRef };

export interface ImgEntry {
  img: FoundImgNode;
  pages: PageRef[];
}

function addHit(map: Map<string, ImgEntry>, found: FoundImgNode, page: PageRef): void {
  const existing = map.get(found.src);
  if (existing) {
    if (!existing.pages.some((p) => p.href === page.href)) {
      existing.pages.push(page);
    }
  } else {
    map.set(found.src, { img: found, pages: [page] });
  }
}

/**
 * Walk every API page, narrative doc, and example in a bundle and return
 * one entry per unique image source, with the list of pages that
 * reference it. Sorted lexicographically by source URL.
 *
 * `ver` is the actual stored version; `urlVer` (optional, defaults to `ver`)
 * is used for page hrefs — pass "latest" when serving the canonical latest URL.
 */
export async function collectBundleImages(
  blobStore: BlobStore,
  pkg: string,
  ver: string,
  urlVer?: string
): Promise<ImgEntry[]> {
  const map = new Map<string, ImgEntry>();
  const t0 = performance.now();
  console.log(`[images] scan start pkg=${pkg} ver=${ver}`);

  await walkBundle(
    blobStore,
    pkg,
    ver,
    (doc, page) => {
      for (const found of collectImages(doc)) addHit(map, found, page);
      return true;
    },
    urlVer
  );

  console.log(
    `[images] scan done pkg=${pkg} ver=${ver} unique=${map.size} ` +
      `${(performance.now() - t0).toFixed(1)}ms`
  );
  return [...map.values()].sort((a, b) => a.img.src.localeCompare(b.img.src));
}
