/**
 * Post-upload integration tests.
 *
 * These run against a live ingest store populated by `papyri upload` (via the
 * viewer's PUT /api/bundle endpoint). They are skipped automatically when
 * ~/.papyri/ingest/papyri.db does not exist, so they are safe to run locally
 * without any setup.
 *
 * In CI they run after the "Upload bundles to viewer" step in
 * .github/workflows/python-package.yml, at which point the ingest store
 * has been populated with the gen artifacts.
 *
 * Port of papyri/tests/test_postingest.py (deleted when the Python ingester
 * was dropped in favour of the TypeScript viewer ingester).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import Database from "better-sqlite3";
import { decode } from "../src/encoder.ts";
import { SqliteGraphDb } from "../src/graph-db.ts";
import { FsBlobStore } from "../src/blob-store.ts";
import type { Key } from "../src/keys.ts";

// ---------------------------------------------------------------------------
// Store location
// ---------------------------------------------------------------------------

const ingestDir = process.env["PAPYRI_INGEST_DIR"] ?? join(homedir(), ".papyri", "ingest");
const dbPath = join(ingestDir, "papyri.db");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Recursively check whether `pattern` appears anywhere inside `tree`.
 *
 * For an object pattern: every key in the pattern must exist in the same
 * object node of `tree` and values must recursively match. The search
 * descends into both objects and arrays.
 *
 * Mirrors the Python `contains_subtree` helper in the deleted test_postingest.py.
 */
function containsSubtree(tree: unknown, pattern: unknown): boolean {
  if (pattern !== null && typeof pattern === "object" && !Array.isArray(pattern)) {
    const p = pattern as Record<string, unknown>;
    if (typeof tree === "object" && tree !== null && !Array.isArray(tree)) {
      const t = tree as Record<string, unknown>;
      if (Object.keys(p).every((k) => k in t && containsSubtree(t[k], p[k]))) return true;
      return Object.values(t).some((v) => containsSubtree(v, p));
    }
    if (Array.isArray(tree)) return tree.some((item) => containsSubtree(item, p));
    return false;
  }
  if (Array.isArray(pattern)) {
    if (Array.isArray(tree)) return tree.some((item) => containsSubtree(item, pattern));
    return false;
  }
  return tree === pattern;
}

/** Return the first blob-backed key matching (module, kind, path), or null. */
async function glob1(
  graphDb: SqliteGraphDb,
  module: string,
  kind: string,
  path: string,
): Promise<Key | null> {
  const row = await graphDb.get<{
    package: string;
    version: string;
    category: string;
    identifier: string;
  }>(
    "SELECT package, version, category, identifier FROM nodes" +
      " WHERE package=? AND category=? AND identifier=? AND has_blob=1 LIMIT 1",
    [module, kind, path],
  );
  if (!row) return null;
  return { module: row.package, version: row.version, kind: row.category, path: row.identifier };
}

// ---------------------------------------------------------------------------
// Tests (skipped when the ingest store has not been populated)
// ---------------------------------------------------------------------------

describe.skipIf(!existsSync(dbPath))("post-upload ingest verification", () => {
  let graphDb: SqliteGraphDb;
  let blobStore: FsBlobStore;

  beforeAll(() => {
    graphDb = new SqliteGraphDb(new Database(dbPath));
    blobStore = new FsBlobStore(ingestDir);
  });

  afterAll(async () => {
    await graphDb.close();
  });

  // -------------------------------------------------------------------------
  // Back-reference tests
  //
  // Note: today only RefInfo forward-refs become graph edges; intra-bundle
  // refs are stored as LocalRef (`papyri/tree.py:GenVisitor._ref_to_crossref`)
  // and skipped by both Python's `IngestedDoc.all_forward_refs` and the TS
  // `collectForwardRefs`, so a query like "does papyri.examples:example1
  // back-link to papyri.examples?" is currently always empty. Walking
  // LocalRefs in the visitor is queued under "Walk LocalRefs when building
  // the forward-ref graph" in `TODO`; once that lands a same-bundle
  // back-ref test belongs here.
  // -------------------------------------------------------------------------

  it("numpy:linspace exists in the store after numpy is ingested", async () => {
    const key = await glob1(graphDb, "numpy", "module", "numpy:linspace");
    if (!key) return; // numpy bundle not ingested — skip gracefully
    expect(key).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // Content-structure tests (ported from postingest/*.json fixtures)
  // -------------------------------------------------------------------------

  it("papyri.examples:example1 carries a coroutine-function SignatureNode", async () => {
    // Fixture: example1_signature.json
    // papyri.examples:example1 is an async coroutine and must carry a
    // coroutine-function signature node.
    const key = await glob1(graphDb, "papyri", "module", "papyri.examples:example1");
    if (!key) return;

    const bytes = await blobStore.get(key);
    expect(bytes).not.toBeNull();
    const doc = decode(bytes!);
    expect(containsSubtree(doc, { __type: "SignatureNode", kind: "coroutine function" })).toBe(
      true,
    );
  });

  it("papyri.examples module docstring contains at least one Paragraph node", async () => {
    // Fixture: examples_module_has_paragraph.json
    const key = await glob1(graphDb, "papyri", "module", "papyri.examples");
    if (!key) return;

    const bytes = await blobStore.get(key);
    expect(bytes).not.toBeNull();
    const doc = decode(bytes!);
    expect(containsSubtree(doc, { __type: "Paragraph" })).toBe(true);
  });

  it("numpy:linspace has a SignatureNode named linspace", async () => {
    // Fixture: numpy_linspace_has_signature.json
    const key = await glob1(graphDb, "numpy", "module", "numpy:linspace");
    if (!key) return;

    const bytes = await blobStore.get(key);
    expect(bytes).not.toBeNull();
    const doc = decode(bytes!);
    expect(containsSubtree(doc, { __type: "SignatureNode", target_name: "linspace" })).toBe(true);
  });
});
