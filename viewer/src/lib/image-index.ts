// Bundle-wide image index: walks every module, narrative doc, and
// example, collects every Figure / Image IR node, and groups by source
// URL. Pulled out of `pages/[pkg]/[ver]/images/index.astro` so the
// page becomes a flat template over the returned entries.

import { join } from "node:path";
import {
  collectImages,
  listModules,
  loadCbor,
  loadModule,
  type FoundImgNode,
} from "./ir-reader.ts";
import { linkForDoc, linkForExample, linkForQualname } from "./links.ts";
import { listDocs, listExamples } from "./nav.ts";

export interface PageRef {
  label: string;
  href: string;
}

export interface ImgEntry {
  img: FoundImgNode;
  pages: PageRef[];
}

interface BundleCtx {
  pkg: string;
  ver: string;
  bundlePath: string;
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

async function collectFromModules(ctx: BundleCtx, out: Map<string, ImgEntry>): Promise<void> {
  const qualnames = await listModules(ctx.bundlePath);
  await Promise.all(
    qualnames.map(async (qa) => {
      let doc;
      try {
        doc = await loadModule(ctx.bundlePath, qa);
      } catch {
        return;
      }
      const href = linkForQualname(ctx.pkg, ctx.ver, qa);
      for (const found of collectImages(doc)) addHit(out, found, { label: qa, href });
    })
  );
}

async function collectFromDocs(ctx: BundleCtx, out: Map<string, ImgEntry>): Promise<void> {
  const docPaths = await listDocs(ctx.bundlePath);
  await Promise.all(
    docPaths.map(async (docPath) => {
      let section;
      try {
        section = await loadCbor(join(ctx.bundlePath, "docs", docPath));
      } catch {
        return;
      }
      const href = linkForDoc(ctx.pkg, ctx.ver, docPath);
      for (const found of collectImages(section)) addHit(out, found, { label: docPath, href });
    })
  );
}

async function collectFromExamples(ctx: BundleCtx, out: Map<string, ImgEntry>): Promise<void> {
  const exPaths = await listExamples(ctx.bundlePath);
  await Promise.all(
    exPaths.map(async (exPath) => {
      let section;
      try {
        section = await loadCbor(join(ctx.bundlePath, "examples", exPath));
      } catch {
        return;
      }
      const href = linkForExample(ctx.pkg, ctx.ver, exPath);
      for (const found of collectImages(section)) addHit(out, found, { label: exPath, href });
    })
  );
}

/**
 * Walk every API page, narrative doc, and example in a bundle and return
 * one entry per unique image source, with the list of pages that
 * reference it. Sorted lexicographically by source URL.
 */
export async function collectBundleImages(
  pkg: string,
  ver: string,
  bundlePath: string
): Promise<ImgEntry[]> {
  const ctx: BundleCtx = { pkg, ver, bundlePath };
  const map = new Map<string, ImgEntry>();
  await Promise.all([
    collectFromModules(ctx, map),
    collectFromDocs(ctx, map),
    collectFromExamples(ctx, map),
  ]);
  return [...map.values()].sort((a, b) => a.img.src.localeCompare(b.img.src));
}
