/**
 * Ingester — TypeScript equivalent of papyri/crosslink.py's Ingester class.
 *
 * Reads a gen bundle (from `papyri gen`) and writes its contents into the
 * cross-link graph store (~/.papyri/ingest/).
 *
 * What this does vs the Python version
 * -------------------------------------
 * The Python Ingester runs an IngestVisitor pass that resolves unresolved
 * CrossRef nodes against the set of all already-ingested qualnames. This
 * TypeScript version skips that cross-ref resolution pass for now: nodes are
 * stored as-is and the viewer falls back to SQLite graph lookups for any
 * ref that isn't already fully resolved. Forward-ref links are still recorded
 * in the graph so back-references work.
 *
 * This is intentional for the first TypeScript implementation; the resolution
 * pass can be added later without changing the on-disk format.
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { encode as cborEncode } from "cbor-x";
import { decode, encode, generatedDocToIngested } from "./encoder.js";
import type { TypedNode } from "./encoder.js";
import { GraphStore } from "./graphstore.js";
import type { Key } from "./graphstore.js";
import { collectForwardRefs, collectForwardRefsFromSection } from "./visitor.js";

// ---------------------------------------------------------------------------
// Bundle metadata (papyri.json)
// ---------------------------------------------------------------------------

interface PapyriMeta {
  module: string;
  version: string;
  logo?: string | null;
  tag?: string;
  aliases?: Record<string, string>;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Ingester
// ---------------------------------------------------------------------------

export interface IngestOptions {
  /** Mirror Python's --check: skip qualnames that don't pass normalise_ref. */
  check?: boolean;
  /** Custom ingest directory (defaults to ~/.papyri/ingest). */
  ingestDir?: string;
}

function defaultIngestDir(): string {
  const override = process.env["PAPYRI_INGEST_DIR"];
  if (override) return override;
  return join(process.env["HOME"] ?? "/root", ".papyri", "ingest");
}

/**
 * Mirror Python's `normalise_ref`: accept only identifiers whose first
 * component starts with a letter/underscore and whose parts are valid Python
 * identifiers (allowing dots and colons as separators).
 *
 * A simplified version: reject empty strings, strings starting with digits,
 * or strings containing characters outside [A-Za-z0-9_.:].
 */
function normaliseRef(qa: string): string {
  // Strip trailing .cbor if present (should already be stripped by caller).
  return qa;
}

function isValidQa(qa: string): boolean {
  if (!qa) return false;
  // Reject if the first character is a digit.
  if (/^\d/.test(qa)) return false;
  // Allow letters, digits, underscores, dots, colons (method qualifiers).
  return /^[A-Za-z_][A-Za-z0-9_.:<>]*$/.test(qa);
}

export class Ingester {
  private gstore: GraphStore;
  private ingestDir: string;

  constructor(opts: IngestOptions = {}) {
    this.ingestDir = opts.ingestDir ?? defaultIngestDir();
    this.gstore = new GraphStore(this.ingestDir);
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Ingest a single gen bundle directory into the graph store. */
  ingest(bundlePath: string, opts: IngestOptions = {}): void {
    const check = opts.check ?? false;

    // Read bundle metadata.
    const metaPath = join(bundlePath, "papyri.json");
    if (!existsSync(metaPath)) {
      throw new Error(`papyri.json not found in ${bundlePath}`);
    }
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as PapyriMeta;
    const { module: root, version } = meta;
    const aliases: Record<string, string> = meta.aliases ?? {};

    // Strip aliases from the meta dict that gets stored (mirrors Python).
    const metaForStore: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(meta)) {
      if (k !== "aliases") metaForStore[k] = v;
    }

    console.log(`Ingesting ${basename(bundlePath)} (${root} ${version})...`);

    this._ingestExamples(bundlePath, root, version);
    this._ingestAssets(bundlePath, root, version, aliases);
    const storedLogoName = this._ingestLogo(bundlePath, root, version, meta.logo ?? null);
    if (storedLogoName !== null) metaForStore["logo"] = storedLogoName;

    this._ingestNarrativeDocs(bundlePath, root, version);
    this._ingestApiDocs(bundlePath, root, version, check);

    // Write per-bundle meta.cbor.
    this.gstore.putMeta(root, version, cborEncode(metaForStore) as Uint8Array);

    console.log(`Done ingesting ${basename(bundlePath)}.`);
  }

  close(): void {
    this.gstore.close();
  }

  // -------------------------------------------------------------------------
  // Private per-section ingest helpers
  // -------------------------------------------------------------------------

  private _ingestExamples(bundlePath: string, root: string, version: string): void {
    const examplesDir = join(bundlePath, "examples");
    if (!existsSync(examplesDir)) return;

    const files = readdirSync(examplesDir, { withFileTypes: true }).filter((e) => e.isFile());
    let count = 0;
    for (const f of files) {
      const filePath = join(examplesDir, f.name);
      const raw = readFileSync(filePath);
      const section = decode<TypedNode>(raw);
      const forwardRefs = collectForwardRefsFromSection(section);
      const key: Key = { module: root, version, kind: "examples", path: f.name };
      // Re-encode to ensure canonical form (consistent digest).
      this.gstore.put(key, encode(section), forwardRefs);
      count++;
    }
    if (count > 0) console.log(`  examples: ${count} files`);
  }

  private _ingestAssets(
    bundlePath: string,
    root: string,
    version: string,
    aliases: Record<string, string>,
  ): void {
    const assetsDir = join(bundlePath, "assets");
    if (!existsSync(assetsDir)) return;

    const files = readdirSync(assetsDir, { withFileTypes: true }).filter((e) => e.isFile());
    let count = 0;
    for (const f of files) {
      const raw = readFileSync(join(assetsDir, f.name));
      const key: Key = { module: root, version, kind: "assets", path: f.name };
      this.gstore.put(key, raw, []);
      count++;
    }
    if (count > 0) console.log(`  assets: ${count} files`);

    // Store aliases.cbor under meta/.
    const aliasBytes = cborEncode(aliases) as Uint8Array;
    const aliasKey: Key = { module: root, version, kind: "meta", path: "aliases.cbor" };
    this.gstore.put(aliasKey, aliasBytes, []);
  }

  /**
   * Copy the bundle logo (if any) into meta/logo.<ext> so the viewer can
   * fetch it at a stable URL. Returns the stored basename or null.
   */
  private _ingestLogo(
    bundlePath: string,
    root: string,
    version: string,
    logoName: string | null,
  ): string | null {
    if (!logoName) return null;
    const src = join(bundlePath, "assets", logoName);
    if (!existsSync(src)) return null;

    const ext = extname(logoName);
    const destName = ext ? `logo${ext}` : "logo";
    const raw = readFileSync(src);
    const key: Key = { module: root, version, kind: "meta", path: destName };
    this.gstore.put(key, raw, []);
    return destName;
  }

  private _ingestNarrativeDocs(bundlePath: string, root: string, version: string): void {
    const docsDir = join(bundlePath, "docs");
    if (!existsSync(docsDir)) return;

    const files = readdirSync(docsDir, { withFileTypes: true }).filter((e) => e.isFile());
    let count = 0;
    for (const f of files) {
      const filePath = join(docsDir, f.name);
      const raw = readFileSync(filePath);

      let genDoc: TypedNode;
      try {
        genDoc = decode<TypedNode>(raw);
      } catch (e) {
        console.warn(`  docs: skipping ${f.name} (decode error: ${e})`);
        continue;
      }

      if (genDoc.__type !== "GeneratedDoc") {
        console.warn(`  docs: skipping ${f.name} (unexpected type ${genDoc.__type})`);
        continue;
      }

      // qa for narrative docs is the filename (no extension, matches Python).
      const qa = f.name;
      const ingestedDoc = generatedDocToIngested(genDoc, qa);
      const forwardRefs = collectForwardRefs(ingestedDoc);
      const key: Key = { module: root, version, kind: "docs", path: qa };
      this.gstore.put(key, encode(ingestedDoc), forwardRefs);
      count++;
    }
    if (count > 0) console.log(`  docs: ${count} pages`);

    // Copy toc.cbor if present.
    const tocPath = join(bundlePath, "toc.cbor");
    if (existsSync(tocPath)) {
      const tocRaw = readFileSync(tocPath);
      const tocKey: Key = { module: root, version, kind: "meta", path: "toc.cbor" };
      this.gstore.put(tocKey, tocRaw, []);
    }
  }

  private _ingestApiDocs(bundlePath: string, root: string, version: string, check: boolean): void {
    const moduleDir = join(bundlePath, "module");
    if (!existsSync(moduleDir)) return;

    const files = readdirSync(moduleDir, { withFileTypes: true }).filter(
      (e) => e.isFile() && (e.name.endsWith(".cbor") || !e.name.includes(".")),
    );

    const docs: { qa: string; ingestedDoc: TypedNode }[] = [];
    let skipped = 0;

    for (const f of files) {
      // Strip .cbor extension to get the qualname.
      const qa = f.name.endsWith(".cbor") ? f.name.slice(0, -5) : f.name;

      if (check && !isValidQa(normaliseRef(qa))) {
        skipped++;
        continue;
      }

      // Verify the qualname's root module matches the bundle root. Qualnames
      // are `module.path:attr` for nested modules and `module:attr` for
      // top-level attributes, so split on either delimiter.
      const modRoot = qa.split(/[.:]/, 1)[0];
      if (modRoot !== root) {
        console.warn(`  module: skipping ${qa} (root ${modRoot} != bundle root ${root})`);
        continue;
      }

      const raw = readFileSync(join(moduleDir, f.name));
      let genDoc: TypedNode;
      try {
        genDoc = decode<TypedNode>(raw);
      } catch (e) {
        console.warn(`  module: skipping ${qa} (decode error: ${e})`);
        continue;
      }

      if (genDoc.__type !== "GeneratedDoc") {
        console.warn(`  module: skipping ${qa} (unexpected type ${genDoc.__type})`);
        continue;
      }

      const ingestedDoc = generatedDocToIngested(genDoc, qa);
      docs.push({ qa, ingestedDoc });
    }

    // Validate + write.
    let count = 0;
    for (const { qa, ingestedDoc } of docs) {
      const forwardRefs = collectForwardRefs(ingestedDoc);
      // Strip method qualifier (e.g. "numpy.foo:classmethod") for the Key path.
      const keyQa = qa.includes(":") ? qa.split(":")[0]! : qa;
      const modRoot = keyQa.split(".")[0] ?? root;
      const key: Key = { module: modRoot, version, kind: "module", path: qa };
      this.gstore.put(key, encode(ingestedDoc), forwardRefs);
      count++;
    }

    if (skipped > 0) console.log(`  module: skipped ${skipped} (normalise_ref check)`);
    if (count > 0) console.log(`  module: ${count} pages`);
  }
}
