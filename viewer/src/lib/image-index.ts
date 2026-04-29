// Bundle-wide image index: walks every module, narrative doc, and
// example, collects every Figure / Image IR node, and groups by source
// URL. Pulled out of `pages/[pkg]/[ver]/images/index.astro` so the
// page becomes a flat template over the returned entries.
//
// NOTE: this scan structure (walk modules → docs → examples, collect-and-
// dedupe by key) is duplicated in `pages/api/[pkg]/[ver]/nodes.json.ts`.
// The two should likely be unified behind a shared `walkBundle(ctx, visit)`
// helper that takes a per-document visitor; right now they diverge in
// concurrency (this file uses Promise.all, nodes.json uses sequential with
// an early-exit limit) and in the per-document hit shape.

import type { BlobStore } from "papyri-ingest";
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
  blobStore: BlobStore;
  pkg: string;
  ver: string;
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
  const qualnames = await listModules(ctx.blobStore, ctx.pkg, ctx.ver);
  console.log(`[images]  modules: ${qualnames.length} to scan`);
  for (const qa of qualnames) {
    const t0 = performance.now();
    let doc;
    try {
      doc = await loadModule(ctx.blobStore, ctx.pkg, ctx.ver, qa);
    } catch {
      console.log(`[images]   module ${qa} (load failed, skipped)`);
      continue;
    }
    const href = linkForQualname(ctx.pkg, ctx.ver, qa);
    for (const found of collectImages(doc)) addHit(out, found, { label: qa, href });
    console.log(`[images]   module ${qa} ${(performance.now() - t0).toFixed(1)}ms`);
  }
}

async function collectFromDocs(ctx: BundleCtx, out: Map<string, ImgEntry>): Promise<void> {
  const docPaths = await listDocs(ctx.blobStore, ctx.pkg, ctx.ver);
  console.log(`[images]  docs: ${docPaths.length} to scan`);
  for (const docPath of docPaths) {
    const t0 = performance.now();
    let section;
    try {
      section = await loadCbor(ctx.blobStore, ctx.pkg, ctx.ver, "docs", docPath);
    } catch {
      console.log(`[images]   doc ${docPath} (load failed, skipped)`);
      continue;
    }
    const href = linkForDoc(ctx.pkg, ctx.ver, docPath);
    for (const found of collectImages(section)) addHit(out, found, { label: docPath, href });
    console.log(`[images]   doc ${docPath} ${(performance.now() - t0).toFixed(1)}ms`);
  }
}

async function collectFromExamples(ctx: BundleCtx, out: Map<string, ImgEntry>): Promise<void> {
  const exPaths = await listExamples(ctx.blobStore, ctx.pkg, ctx.ver);
  console.log(`[images]  examples: ${exPaths.length} to scan`);
  for (const exPath of exPaths) {
    const t0 = performance.now();
    let section;
    try {
      section = await loadCbor(ctx.blobStore, ctx.pkg, ctx.ver, "examples", exPath);
    } catch {
      console.log(`[images]   example ${exPath} (load failed, skipped)`);
      continue;
    }
    const href = linkForExample(ctx.pkg, ctx.ver, exPath);
    for (const found of collectImages(section)) addHit(out, found, { label: exPath, href });
    console.log(`[images]   example ${exPath} ${(performance.now() - t0).toFixed(1)}ms`);
  }
}

/**
 * Walk every API page, narrative doc, and example in a bundle and return
 * one entry per unique image source, with the list of pages that
 * reference it. Sorted lexicographically by source URL.
 */
export async function collectBundleImages(
  blobStore: BlobStore,
  pkg: string,
  ver: string
): Promise<ImgEntry[]> {
  const ctx: BundleCtx = { blobStore, pkg, ver };
  const map = new Map<string, ImgEntry>();
  const overallStart = performance.now();
  console.log(`[images] scan start pkg=${pkg} ver=${ver}`);
  await collectFromModules(ctx, map);
  await collectFromDocs(ctx, map);
  await collectFromExamples(ctx, map);
  console.log(
    `[images] scan done pkg=${pkg} ver=${ver} unique=${map.size} ` +
      `${(performance.now() - overallStart).toFixed(1)}ms`
  );
  return [...map.values()].sort((a, b) => a.img.src.localeCompare(b.img.src));
}
