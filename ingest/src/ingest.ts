/**
 * Ingester — TypeScript equivalent of papyri/crosslink.py's Ingester class.
 *
 * Accepts either a `papyri gen` bundle directory (`ingest(dirPath)`) or a
 * decoded `Bundle` Node from a `.papyri` artifact (`ingestBundle(node)`),
 * and writes its contents into the cross-link graph store via the
 * `BlobStore` + `GraphDb` abstractions.
 *
 * Two backends are supported:
 *   • Node fs + better-sqlite3 — default. The CLI and the Node-adapter
 *     viewer use this path; the constructor builds them from `ingestDir` /
 *     `schemaSql` for backwards compat.
 *   • Cloudflare R2 + D1 — explicit. The Workers-adapter viewer passes
 *     pre-built backends via the `backends` option so the same Ingester
 *     code runs unchanged.
 *
 * What this does vs the Python version
 * -------------------------------------
 * The Python Ingester runs an IngestVisitor pass that resolves unresolved
 * CrossRef nodes against the set of all already-ingested qualnames. This
 * TypeScript version skips that cross-ref resolution pass for now: nodes are
 * stored as-is and the viewer falls back to graph lookups for any ref that
 * isn't already fully resolved. Forward-ref links are still recorded in the
 * graph so back-references work.
 */

import { readdirSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, basename, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { encode as cborEncode } from "cbor-x";
import { blake2b } from "@noble/hashes/blake2b.js";
import Database from "better-sqlite3";
import { decode, encode, generatedDocToIngested } from "./encoder.js";
import type { TypedNode } from "./encoder.js";
import { assertBundle } from "./bundle.js";
import type { Key } from "./graphstore.js";
import { keyStr } from "./graphstore.js";
import { collectForwardRefs, collectForwardRefsFromSection } from "./visitor.js";
import { FsBlobStore, type BlobStore } from "./blob-store.js";
import { SqliteGraphDb, type GraphDb, type BatchStmt } from "./graph-db.js";

const DIGEST_SIZE = 16;

// Fields that change across rebuilds without reflecting any user-visible
// content change. We strip them before computing the content digest so the
// version-diff "changed" bucket isn't dominated by line-number churn from
// `inspect.getsourcelines()` shifting under unrelated edits.
//
// Currently only `IngestedDoc.item_line` qualifies; add others here if
// the same problem shows up for other IR fields.
const VOLATILE_FIELDS_BY_TYPE: Record<string, ReadonlySet<string>> = {
  IngestedDoc: new Set(["item_line"]),
};

function stripVolatileFields<T>(node: T): T {
  if (!node || typeof node !== "object") return node;
  if (Array.isArray(node)) {
    return node.map((v) => stripVolatileFields(v)) as unknown as T;
  }
  const obj = node as Record<string, unknown>;
  const t = typeof obj.__type === "string" ? obj.__type : null;
  const drop = t ? VOLATILE_FIELDS_BY_TYPE[t] : undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (drop?.has(k)) {
      out[k] = null;
      continue;
    }
    out[k] = stripVolatileFields(v);
  }
  return out as T;
}

// ---------------------------------------------------------------------------
// Schema bootstrap (Node-mode SQLite)
// ---------------------------------------------------------------------------

const PRAGMAS = [
  "PRAGMA foreign_keys = 1",
  "PRAGMA journal_mode = WAL",
  "PRAGMA synchronous = NORMAL",
  "PRAGMA cache_size = -65536",
  "PRAGMA mmap_size = 268435456",
];

function migrationsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
}

function loadSchemaFromDisk(): string {
  const dir = migrationsDir();
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  return files.map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
}

function splitStatements(sql: string): string[] {
  const stripped = sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  return stripped
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Build Node-mode backends (filesystem blob store + better-sqlite3 graph
 * db). Applies migrations on first init. Used by `Ingester` when the
 * caller provides `ingestDir` instead of explicit backends.
 */
function openNodeBackends(
  ingestDir: string,
  schemaSql?: string,
): { blobStore: BlobStore; graphDb: GraphDb } {
  mkdirSync(ingestDir, { recursive: true });
  const dbPath = join(ingestDir, "papyri.db");
  const isNew = !existsSync(dbPath);
  const db = new Database(dbPath);
  for (const p of PRAGMAS) db.prepare(p).run();
  if (isNew) {
    const sql = schemaSql ?? loadSchemaFromDisk();
    for (const stmt of splitStatements(sql)) db.prepare(stmt).run();
  }
  return {
    blobStore: new FsBlobStore(ingestDir),
    graphDb: new SqliteGraphDb(db),
  };
}

// ---------------------------------------------------------------------------
// Bundle metadata (papyri.json) — directory-based path
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
  /**
   * Custom Node ingest directory (defaults to ~/.papyri/ingest). Ignored
   * when `backends` is set.
   */
  ingestDir?: string;
  /**
   * Schema SQL applied to a freshly created papyri.db. Forwarded from the
   * Vite-bundled SSR endpoint (which embeds the migrations file via
   * `?raw`); the CLI can leave it unset and rely on the on-disk migrations
   * dir. Ignored when `backends` is set.
   */
  schemaSql?: string;
  /**
   * Pre-built async backends. Pass these in environments where the default
   * Node fs + SQLite backends are not available — e.g. the viewer's
   * Cloudflare Workers build, which supplies `R2BlobStore` + `D1GraphDb`
   * built from `locals.runtime.env` bindings.
   */
  backends?: { blobStore: BlobStore; graphDb: GraphDb };
}

function defaultIngestDir(): string {
  const override = process.env["PAPYRI_INGEST_DIR"];
  if (override) return override;
  return join(process.env["HOME"] ?? "/root", ".papyri", "ingest");
}

function isValidQa(qa: string): boolean {
  if (!qa) return false;
  if (/^\d/.test(qa)) return false;
  return /^[A-Za-z_][A-Za-z0-9_.:<>]*$/.test(qa);
}

export class Ingester {
  private blobStore: BlobStore;
  private graphDb: GraphDb;

  constructor(opts: IngestOptions = {}) {
    if (opts.backends) {
      this.blobStore = opts.backends.blobStore;
      this.graphDb = opts.backends.graphDb;
    } else {
      const dir = opts.ingestDir ?? defaultIngestDir();
      const b = openNodeBackends(dir, opts.schemaSql);
      this.blobStore = b.blobStore;
      this.graphDb = b.graphDb;
    }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Ingest a `papyri gen` bundle directory. Synchronous fs reads under the
   * hood — Node-only path. The viewer's Workers build uses `ingestBundle`
   * instead.
   */
  async ingest(bundlePath: string, opts: IngestOptions = {}): Promise<void> {
    const check = opts.check ?? false;

    const metaPath = join(bundlePath, "papyri.json");
    if (!existsSync(metaPath)) {
      throw new Error(`papyri.json not found in ${bundlePath}`);
    }
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as PapyriMeta;
    const { module: root, version } = meta;
    const aliases: Record<string, string> = meta.aliases ?? {};

    const metaForStore: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(meta)) {
      if (k !== "aliases") metaForStore[k] = v;
    }

    console.log(`Ingesting ${basename(bundlePath)} (${root} ${version})...`);

    await this._ingestExamplesDir(bundlePath, root, version);
    await this._ingestAssetsDir(bundlePath, root, version, aliases);
    const storedLogoName = await this._ingestLogoDir(bundlePath, root, version, meta.logo ?? null);
    if (storedLogoName !== null) metaForStore["logo"] = storedLogoName;

    await this._ingestNarrativeDir(bundlePath, root, version);
    await this._ingestApiDir(bundlePath, root, version, check);

    await this.blobStore.putMeta(root, version, cborEncode(metaForStore) as Uint8Array);

    console.log(`Done ingesting ${basename(bundlePath)}.`);
  }

  /**
   * Ingest a decoded `Bundle` Node directly — no filesystem round-trip.
   * Used by the viewer's PUT /api/bundle handler under both Node and
   * Cloudflare Workers.
   */
  async ingestBundle(node: unknown): Promise<{ pkg: string; version: string }> {
    assertBundle(node);
    const bundle = node;
    const root = bundle.module;
    const version = bundle.version;
    const aliases = (bundle.aliases ?? {}) as Record<string, string>;

    let exCount = 0;
    for (const [name, section] of Object.entries(bundle.examples ?? {})) {
      const refs = collectForwardRefsFromSection(section);
      await this._put(
        { module: root, version, kind: "examples", path: name },
        encode(section),
        refs,
      );
      exCount++;
    }
    if (exCount > 0) console.log(`  examples: ${exCount} files`);

    let asCount = 0;
    for (const [name, raw] of Object.entries(bundle.assets ?? {})) {
      const bytes = toUint8(raw);
      await this._put({ module: root, version, kind: "assets", path: name }, bytes, []);
      asCount++;
    }
    if (asCount > 0) console.log(`  assets: ${asCount} files`);

    await this._put(
      { module: root, version, kind: "meta", path: "aliases.cbor" },
      cborEncode(aliases) as Uint8Array,
      [],
    );

    let storedLogoName: string | null = null;
    if (bundle.logo) {
      const assets = (bundle.assets ?? {}) as Record<string, unknown>;
      const logoBytes = assets[bundle.logo];
      if (logoBytes !== undefined) {
        const ext = extname(bundle.logo);
        const destName = ext ? `logo${ext}` : "logo";
        await this._put(
          { module: root, version, kind: "meta", path: destName },
          toUint8(logoBytes),
          [],
        );
        storedLogoName = destName;
      }
    }

    let docCount = 0;
    for (const [name, genDoc] of Object.entries(bundle.narrative ?? {})) {
      const g = genDoc as TypedNode;
      if (g.__type !== "GeneratedDoc") {
        console.warn(`  docs: skipping ${name} (unexpected type ${g.__type})`);
        continue;
      }
      const ingestedDoc = generatedDocToIngested(g, name);
      const refs = collectForwardRefs(ingestedDoc);
      await this._put(
        { module: root, version, kind: "docs", path: name },
        encode(ingestedDoc),
        refs,
      );
      docCount++;
    }
    if (docCount > 0) console.log(`  docs: ${docCount} pages`);

    if (Array.isArray(bundle.toc) && bundle.toc.length > 0) {
      await this._put(
        { module: root, version, kind: "meta", path: "toc.cbor" },
        encode(bundle.toc),
        [],
      );
    }

    let apiCount = 0;
    for (const [qa, genDoc] of Object.entries(bundle.api ?? {})) {
      const g = genDoc as TypedNode;
      if (g.__type !== "GeneratedDoc") {
        console.warn(`  module: skipping ${qa} (unexpected type ${g.__type})`);
        continue;
      }
      const modRoot = qa.split(/[.:]/, 1)[0];
      if (modRoot !== root) {
        console.warn(`  module: skipping ${qa} (root ${modRoot} != bundle root ${root})`);
        continue;
      }
      const ingestedDoc = generatedDocToIngested(g, qa);
      const refs = collectForwardRefs(ingestedDoc);
      const keyQa = qa.includes(":") ? qa.split(":")[0]! : qa;
      const keyMod = keyQa.split(".")[0] ?? root;
      await this._put(
        { module: keyMod, version, kind: "module", path: qa },
        encode(ingestedDoc),
        refs,
        encode(stripVolatileFields(ingestedDoc)),
      );
      apiCount++;
    }
    if (apiCount > 0) console.log(`  module: ${apiCount} pages`);

    const metaForStore: Record<string, unknown> = { module: root, version };
    if (bundle.summary) metaForStore["summary"] = bundle.summary;
    if (bundle.github_slug) metaForStore["github_slug"] = bundle.github_slug;
    if (bundle.tag) metaForStore["tag"] = bundle.tag;
    if (storedLogoName !== null) metaForStore["logo"] = storedLogoName;
    else if (bundle.logo) metaForStore["logo"] = bundle.logo;
    for (const [k, v] of Object.entries((bundle.extra ?? {}) as Record<string, unknown>)) {
      if (!(k in metaForStore)) metaForStore[k] = v;
    }
    await this.blobStore.putMeta(root, version, cborEncode(metaForStore) as Uint8Array);

    return { pkg: root, version };
  }

  async close(): Promise<void> {
    await this.graphDb.close();
  }

  // -------------------------------------------------------------------------
  // Core write — single path used by both `ingest()` and `ingestBundle()`.
  //
  // Atomicity contract:
  //   On SQLite (`SqliteGraphDb`) the whole `batch` runs inside one
  //   transaction. On D1 it runs as a single `db.batch([...])` call which
  //   is atomic per the D1 contract. Either way: all nodes + links for one
  //   `_put` either land together or not at all.
  //
  //   To stay D1-compatible we never read from the DB inside `batch`: we
  //   resolve source/dest ids inline via subqueries
  //   (`SELECT id FROM nodes WHERE …`) so each link insert is self-contained.
  //   D1 batches do not surface intermediate query results, so this is the
  //   only way to chain ID-dependent writes.
  // -------------------------------------------------------------------------

  private async _put(
    key: Key,
    bytes: Uint8Array,
    refs: Key[],
    digestInput?: Uint8Array,
  ): Promise<void> {
    let oldRefs = new Set<string>();
    if (key.kind !== "assets" && (await this.blobStore.has(key))) {
      oldRefs = new Set((await this._getForwardRefs(key)).map(keyStr));
    }

    await this.blobStore.put(key, bytes);
    // The digest is what powers the version-diff "changed" bucket. Callers
    // that want the digest to ignore volatile fields (e.g. `item_line` on
    // IngestedDoc) hand in a normalised re-encoding via `digestInput`;
    // otherwise we hash the stored bytes directly.
    const digest = blake2b(digestInput ?? bytes, { dkLen: DIGEST_SIZE });

    const newRefSet = new Set(refs.map(keyStr));
    const addedRefs = refs.filter((r) => !oldRefs.has(keyStr(r)));
    const removedRefStrs = [...oldRefs].filter((s) => !newRefSet.has(s));

    const insNode =
      "INSERT OR IGNORE INTO nodes(package, version, category, identifier) VALUES (?, ?, ?, ?)";
    const updBlob =
      "UPDATE nodes SET has_blob=1, digest=? WHERE package=? AND version=? AND category=? AND identifier=?";
    const insLink =
      "INSERT OR IGNORE INTO links(source, dest) VALUES (" +
      "(SELECT id FROM nodes WHERE package=? AND version=? AND category=? AND identifier=?), " +
      "(SELECT id FROM nodes WHERE package=? AND version=? AND category=? AND identifier=?)" +
      ")";
    const delLink =
      "DELETE FROM links WHERE source = " +
      "(SELECT id FROM nodes WHERE package=? AND version=? AND category=? AND identifier=?) " +
      "AND dest = " +
      "(SELECT id FROM nodes WHERE package=? AND version=? AND category=? AND identifier=?)";

    const stmts: BatchStmt[] = [
      { sql: insNode, params: [key.module, key.version, key.kind, key.path] },
      { sql: updBlob, params: [digest, key.module, key.version, key.kind, key.path] },
      ...addedRefs.map((r) => ({
        sql: insNode,
        params: [r.module, r.version, r.kind, r.path],
      })),
      ...addedRefs.map((r) => ({
        sql: insLink,
        params: [
          key.module,
          key.version,
          key.kind,
          key.path,
          r.module,
          r.version,
          r.kind,
          r.path,
        ],
      })),
    ];
    for (const s of removedRefStrs) {
      const [m, v, k, p] = s.split("/");
      stmts.push({
        sql: delLink,
        params: [
          key.module,
          key.version,
          key.kind,
          key.path,
          m ?? "",
          v ?? "",
          k ?? "",
          p ?? "",
        ],
      });
    }

    await this.graphDb.batch(stmts);
  }

  private async _getForwardRefs(key: Key): Promise<Key[]> {
    const rows = await this.graphDb.all<{
      package: string;
      version: string;
      category: string;
      identifier: string;
    }>(
      "SELECT n_dest.package, n_dest.version, n_dest.category, n_dest.identifier " +
        "FROM links " +
        "JOIN nodes AS n_src ON links.source = n_src.id " +
        "JOIN nodes AS n_dest ON links.dest = n_dest.id " +
        "WHERE n_src.package=? AND n_src.version=? AND n_src.category=? AND n_src.identifier=?",
      [key.module, key.version, key.kind, key.path],
    );
    return rows.map((r) => ({
      module: r.package,
      version: r.version,
      kind: r.category,
      path: r.identifier,
    }));
  }

  // -------------------------------------------------------------------------
  // Per-section helpers (directory-based ingest path)
  // -------------------------------------------------------------------------

  private async _ingestExamplesDir(
    bundlePath: string,
    root: string,
    version: string,
  ): Promise<void> {
    const examplesDir = join(bundlePath, "examples");
    if (!existsSync(examplesDir)) return;

    const files = readdirSync(examplesDir, { withFileTypes: true }).filter((e) => e.isFile());
    let count = 0;
    for (const f of files) {
      const raw = readFileSync(join(examplesDir, f.name));
      const section = decode<TypedNode>(raw);
      const refs = collectForwardRefsFromSection(section);
      await this._put(
        { module: root, version, kind: "examples", path: f.name },
        encode(section),
        refs,
      );
      count++;
    }
    if (count > 0) console.log(`  examples: ${count} files`);
  }

  private async _ingestAssetsDir(
    bundlePath: string,
    root: string,
    version: string,
    aliases: Record<string, string>,
  ): Promise<void> {
    const assetsDir = join(bundlePath, "assets");
    if (existsSync(assetsDir)) {
      const files = readdirSync(assetsDir, { withFileTypes: true }).filter((e) => e.isFile());
      let count = 0;
      for (const f of files) {
        const raw = new Uint8Array(readFileSync(join(assetsDir, f.name)));
        await this._put({ module: root, version, kind: "assets", path: f.name }, raw, []);
        count++;
      }
      if (count > 0) console.log(`  assets: ${count} files`);
    }

    await this._put(
      { module: root, version, kind: "meta", path: "aliases.cbor" },
      cborEncode(aliases) as Uint8Array,
      [],
    );
  }

  private async _ingestLogoDir(
    bundlePath: string,
    root: string,
    version: string,
    logoName: string | null,
  ): Promise<string | null> {
    if (!logoName) return null;
    const src = join(bundlePath, "assets", logoName);
    if (!existsSync(src)) return null;
    const ext = extname(logoName);
    const destName = ext ? `logo${ext}` : "logo";
    const raw = new Uint8Array(readFileSync(src));
    await this._put({ module: root, version, kind: "meta", path: destName }, raw, []);
    return destName;
  }

  private async _ingestNarrativeDir(
    bundlePath: string,
    root: string,
    version: string,
  ): Promise<void> {
    const docsDir = join(bundlePath, "docs");
    if (existsSync(docsDir)) {
      const files = readdirSync(docsDir, { withFileTypes: true }).filter((e) => e.isFile());
      let count = 0;
      for (const f of files) {
        const raw = readFileSync(join(docsDir, f.name));
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
        const qa = f.name;
        const ingestedDoc = generatedDocToIngested(genDoc, qa);
        const refs = collectForwardRefs(ingestedDoc);
        await this._put(
          { module: root, version, kind: "docs", path: qa },
          encode(ingestedDoc),
          refs,
        );
        count++;
      }
      if (count > 0) console.log(`  docs: ${count} pages`);
    }

    const tocPath = join(bundlePath, "toc.cbor");
    if (existsSync(tocPath)) {
      const tocRaw = new Uint8Array(readFileSync(tocPath));
      await this._put({ module: root, version, kind: "meta", path: "toc.cbor" }, tocRaw, []);
    }
  }

  private async _ingestApiDir(
    bundlePath: string,
    root: string,
    version: string,
    check: boolean,
  ): Promise<void> {
    const moduleDir = join(bundlePath, "module");
    if (!existsSync(moduleDir)) return;

    const files = readdirSync(moduleDir, { withFileTypes: true }).filter(
      (e) => e.isFile() && (e.name.endsWith(".cbor") || !e.name.includes(".")),
    );

    const docs: { qa: string; ingestedDoc: TypedNode }[] = [];
    let skipped = 0;

    for (const f of files) {
      const qa = f.name.endsWith(".cbor") ? f.name.slice(0, -5) : f.name;
      if (check && !isValidQa(qa)) {
        skipped++;
        continue;
      }
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

    let count = 0;
    for (const { qa, ingestedDoc } of docs) {
      const refs = collectForwardRefs(ingestedDoc);
      const keyQa = qa.includes(":") ? qa.split(":")[0]! : qa;
      const keyMod = keyQa.split(".")[0] ?? root;
      await this._put(
        { module: keyMod, version, kind: "module", path: qa },
        encode(ingestedDoc),
        refs,
        encode(stripVolatileFields(ingestedDoc)),
      );
      count++;
    }

    if (skipped > 0) console.log(`  module: skipped ${skipped} (normalise_ref check)`);
    if (count > 0) console.log(`  module: ${count} pages`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toUint8(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (v && typeof v === "object" && "byteLength" in (v as object)) {
    const b = v as ArrayBufferView;
    return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  }
  throw new Error(`expected bytes, got ${typeof v}`);
}
