/**
 * End-to-end producer↔consumer contract test.
 *
 * The IR is a contract spanning two languages: `papyri gen` + `papyri pack`
 * (Python) emit a gzipped canonical-CBOR `.papyri` artifact, and the viewer
 * (TypeScript) decodes, ingests, and renders it. Almost every other test on
 * the TS side hand-builds CBOR with literal tag numbers and field orders
 * (e.g. `ir-reader-cbor.test.ts`'s `mkDoc`), so it encodes the *expected*
 * contract by hand and cannot catch Python↔TS drift. This test is the one
 * that exercises the real seam: it drives an actual `papyri pack` artifact
 * through the whole consumer pipeline.
 *
 *   gunzip + decode (encoder.ts)        ← Python CBOR → TS Bundle
 *     → assertBundle (bundle.ts)        ← structural contract check
 *     → generatedDocToIngested + encode ← the ingest transform
 *     → loadModule (ir-reader.ts)       ← the IR shock absorber
 *     → renderNode (render-node.ts)     ← render to HTML
 *     → collectForwardRefs (visitor.ts) ← cross-link edge extraction
 *
 * It deliberately does NOT touch SqliteGraphDb: the graph DB is incidental
 * storage, the contract lives in the CBOR encode/decode seam, and the native
 * better-sqlite3 binary is unavailable on some dev platforms. FsBlobStore is
 * pure-fs and stands in for the blob half of the ingest.
 *
 * Fixture: `fixtures/papyri-0.0.10.papyri` is real `papyri pack` output of
 * papyri's own API (the `papyri` + `papyri.examples` modules, no docs /
 * examples / logo / doctests, so it stays small and deterministic). A stale
 * fixture failing loud is the point — it means the IR moved and the contract
 * needs re-checking. Regenerate with:
 *
 *   cat > /tmp/papyri-fixture.toml <<'EOF'
 *   [global]
 *   module = 'papyri'
 *   submodules = ['examples']
 *   execute_doctests = false
 *   [global.directives]
 *   mydirective = 'papyri.examples:_mydirective_handler'
 *   directive = 'papyri.directives:code_handler'
 *   EOF
 *   papyri gen /tmp/papyri-fixture.toml --no-infer
 *   papyri pack ~/.papyri/data/papyri_0.0.10   # writes papyri-0.0.10.papyri
 *   cp papyri-0.0.10.papyri viewer/tests/fixtures/
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  decode,
  assertBundle,
  generatedDocToIngested,
  encode,
  collectForwardRefs,
  FsBlobStore,
  type TypedNode,
  type Key,
} from "papyri-ingest";
import { renderNode } from "../src/lib/render-node.ts";
import type { IRNode } from "../src/lib/ir-reader.ts";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "papyri-0.0.10.papyri");

// A stable, known object in the fixture. Its docstring carries plain prose and
// CrossRefs to cpython builtins — see papyri/examples.py:example1.
const PKG = "papyri";
const VER = "0.0.10";
const QA = "papyri.examples:example1";

let loadModule: typeof import("../src/lib/ir-reader.ts").loadModule;

beforeAll(async () => {
  ({ loadModule } = await import("../src/lib/ir-reader.ts"));
});

describe("end-to-end gen→pack→ingest→render pipeline", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "papyri-e2e-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("decodes a real .papyri artifact, ingests, renders, and extracts edges", async () => {
    // --- Consumer entry: gunzip → CBOR decode → Bundle (the real seam) ---
    const compressed = await readFile(FIXTURE);
    const cbor = gunzipSync(compressed);
    const bundle = decode<TypedNode>(cbor);

    // Structural producer↔consumer contract: the decoded tree is a Bundle.
    assertBundle(bundle);
    const api = (bundle as { api?: Record<string, TypedNode> }).api ?? {};
    expect(Object.keys(api).length).toBeGreaterThan(0);

    const genDoc = api[QA];
    expect(genDoc, `fixture is missing ${QA}`).toBeDefined();
    expect(genDoc!.__type).toBe("GeneratedDoc");

    // --- Ingest transform + blob write (the blob half of the Ingester) ---
    const ingested = generatedDocToIngested(genDoc as TypedNode, QA);
    const blobStore = new FsBlobStore(dir);
    await blobStore.put(
      { module: PKG, version: VER, kind: "module", path: QA },
      encode(ingested),
    );

    // --- Read back through the IR shock absorber ---
    const doc = await loadModule(blobStore, PKG, VER, QA);
    expect(doc.__type).toBe("IngestedDoc");
    expect(doc.qa).toBe(QA);

    // --- Render the docstring content to HTML ---
    const summary = doc._content?.["Extended Summary"] as { children?: IRNode[] } | undefined;
    expect(summary, "Extended Summary section missing").toBeDefined();
    const parts = await Promise.all(
      (summary!.children ?? []).map((c) => renderNode(c)),
    );
    const html = parts.join("");
    // Plain prose survives the whole round-trip.
    expect(html).toContain("that is positional only");
    // CrossRef to a cpython builtin renders as an (unresolved) xref carrying
    // the RefInfo decoded from the Python-produced CBOR.
    expect(html).toContain('data-ref-path="builtins:int"');

    // --- Forward-ref edges: the cross-link half of ingest, no DB needed ---
    const refs: Key[] = collectForwardRefs(ingested as unknown as IRNode);
    const intRef = refs.find((r) => r.path === "builtins:int");
    expect(intRef, `no forward ref to builtins:int among ${JSON.stringify(refs)}`).toBeDefined();
    expect(intRef!.module).toBe("builtins");
    // gen emits kind "api"; ingest normalizes it to "module".
    expect(intRef!.kind).toBe("module");
  });
});
