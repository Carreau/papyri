// Shared bundle traversal helper.
//
// Both image-index.ts and nodes.json.ts need to walk every module, narrative
// doc, and example in a bundle. They diverge only in what they collect and
// whether they stop early. This module owns the common list-then-load pattern
// so neither caller has to repeat it.
//
// The natural next step (PLAN.md M9.2 / cleanup) is to precompute a
// nodes_by_type table at ingest time so endpoints query instead of scan;
// this helper is the right place to hang that optimisation once it lands.

import type { BlobStore } from "papyri-ingest";
import { listModules, loadModule, loadCbor } from "./ir-reader.ts";
import { listDocs, listExamples } from "./nav.ts";
import { linkForDoc, linkForExample, linkForQualname } from "./links.ts";

export interface PageRef {
  label: string;
  href: string;
}

/**
 * Called for each document in the bundle in order: modules, docs, examples.
 * Return false to stop iteration early.
 */
export type BundleVisitor = (doc: unknown, page: PageRef) => boolean;

/**
 * Walk every API page, narrative doc, and example in a bundle, calling
 * `visitor` for each successfully loaded document.  The walk stops as soon
 * as `visitor` returns `false`, allowing callers to implement result limits.
 */
export async function walkBundle(
  blobStore: BlobStore,
  pkg: string,
  ver: string,
  visitor: BundleVisitor
): Promise<void> {
  const qualnames = await listModules(blobStore, pkg, ver);
  for (const qa of qualnames) {
    let doc;
    try {
      doc = await loadModule(blobStore, pkg, ver, qa);
    } catch {
      continue;
    }
    if (!visitor(doc, { label: qa, href: linkForQualname(pkg, ver, qa) })) return;
  }

  const docPaths = await listDocs(blobStore, pkg, ver);
  for (const docPath of docPaths) {
    let section;
    try {
      section = await loadCbor(blobStore, pkg, ver, "docs", docPath);
    } catch {
      continue;
    }
    if (!visitor(section, { label: docPath, href: linkForDoc(pkg, ver, docPath) })) return;
  }

  const exPaths = await listExamples(blobStore, pkg, ver);
  for (const exPath of exPaths) {
    let section;
    try {
      section = await loadCbor(blobStore, pkg, ver, "examples", exPath);
    } catch {
      continue;
    }
    if (!visitor(section, { label: exPath, href: linkForExample(pkg, ver, exPath) })) return;
  }
}
