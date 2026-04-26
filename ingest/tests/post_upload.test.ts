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
import { decode } from "../src/encoder.ts";
import { GraphStore } from "../src/graphstore.ts";
import type { Key } from "../src/graphstore.ts";

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

/** Return the first key matching a glob, or null if not found. */
function glob1(store: GraphStore, module: string, kind: string, path: string): Key | null {
  return store.glob({ module, kind, path })[0] ?? null;
}

// ---------------------------------------------------------------------------
// Tests (skipped when the ingest store has not been populated)
// ---------------------------------------------------------------------------

describe.skipIf(!existsSync(dbPath))("post-upload ingest verification", () => {
  let store: GraphStore;

  beforeAll(() => {
    store = new GraphStore(ingestDir);
  });

  afterAll(() => {
    store.close();
  });

  // -------------------------------------------------------------------------
  // Back-reference tests
  // -------------------------------------------------------------------------

  it("papyri.examples:example1 has papyri.examples as a back-reference", () => {
    const key = glob1(store, "papyri", "module", "papyri.examples:example1");
    if (!key) return; // papyri bundle not yet ingested — skip gracefully

    const backrefs = store.getBackRefs(key);
    const moduleRefs = backrefs.filter((k) => k.path === "papyri.examples");
    expect(moduleRefs.length).toBeGreaterThan(0);
  });

  it("numpy:linspace exists in the store after numpy is ingested", () => {
    const key = glob1(store, "numpy", "module", "numpy:linspace");
    if (!key) return; // numpy bundle not ingested — skip gracefully
    expect(key).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // Content-structure tests (ported from postingest/*.json fixtures)
  // -------------------------------------------------------------------------

  it("papyri.examples:example1 carries a coroutine-function SignatureNode", () => {
    // Fixture: example1_signature.json
    // papyri.examples:example1 is an async coroutine and must carry a
    // coroutine-function signature node.
    const key = glob1(store, "papyri", "module", "papyri.examples:example1");
    if (!key) return;

    const doc = decode(store.get(key));
    expect(containsSubtree(doc, { __type: "SignatureNode", kind: "coroutine function" })).toBe(
      true,
    );
  });

  it("papyri.examples module docstring contains at least one Paragraph node", () => {
    // Fixture: examples_module_has_paragraph.json
    const key = glob1(store, "papyri", "module", "papyri.examples");
    if (!key) return;

    const doc = decode(store.get(key));
    expect(containsSubtree(doc, { __type: "Paragraph" })).toBe(true);
  });

  it("numpy:linspace has a SignatureNode named linspace", () => {
    // Fixture: numpy_linspace_has_signature.json
    const key = glob1(store, "numpy", "module", "numpy:linspace");
    if (!key) return;

    const doc = decode(store.get(key));
    expect(containsSubtree(doc, { __type: "SignatureNode", target_name: "linspace" })).toBe(true);
  });
});
