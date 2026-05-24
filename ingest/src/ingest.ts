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
 *     viewer use this path; the constructor builds them from `ingestDir`.
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

// Max concurrent R2 puts during a bundle flush.  R2 has no batch-put API so
// we parallelise the individual puts instead of serialising them.
const BLOB_CONCURRENCY = 100;

// D1 batch calls are capped at ~1 000 statements; stay well under that limit
// so a single large bundle does not blow the API ceiling.
const DB_CHUNK_SIZE = 500;

// Fields that change across rebuilds without reflecting any user-visible
// content change. We strip them before computing the content digest so the
// version-diff "changed" bucket isn't dominated by churn from
// `inspect.getsourcelines()` shifting under unrelated edits or
// `inspect.getfile()` returning different absolute paths across environments.
const VOLATILE_FIELDS_BY_TYPE: Record<string, ReadonlySet<string>> = {
  IngestedDoc: new Set(["item_line", "item_file"]),
  // Figure.value is a RefInfo pointing into the bundle's `assets/`
  // directory. The underlying image bytes (matplotlib output, embedded
  // PNGs, etc.) are non-deterministic across rebuilds, so the asset
  // identity churns and would otherwise propagate into every containing
  // doc/section/example digest. Null the RefInfo for hashing — Figure
  // presence and ordering still count, only the asset identity is
  // volatile. Image.url is the same story for narrative `.. image::`.
  Figure: new Set(["value"]),
  Image: new Set(["url"]),
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
function openNodeBackends(ingestDir: string): { blobStore: BlobStore; graphDb: GraphDb } {
  mkdirSync(ingestDir, { recursive: true });
  const dbPath = join(ingestDir, "papyri.db");
  const isNew = !existsSync(dbPath);
  const db = new Database(dbPath);
  for (const p of PRAGMAS) db.prepare(p).run();
  if (isNew) {
    const sql = loadSchemaFromDisk();
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

/**
 * Per-section progress callback. Invoked at most once per N writes
 * (currently per-chunk for `module`, per-item for the smaller sections).
 * `phase` is one of "examples" | "assets" | "docs" | "module". `done`
 * and `total` are item counts within the phase. The callback may be
 * async; ingest awaits it before continuing. Throwing is non-fatal —
 * ingest swallows errors and proceeds, so a closed stream writer
 * cannot abort an in-flight ingest.
 */
export type ProgressCallback = (phase: string, done: number, total: number) => void | Promise<void>;

export interface IngestOptions {
  /** Mirror Python's --check: skip qualnames that don't pass normalise_ref. */
  check?: boolean;
  /**
   * Custom Node ingest directory (defaults to ~/.papyri/ingest). Ignored
   * when `backends` is set.
   */
  ingestDir?: string;
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
      const b = openNodeBackends(dir);
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
  async ingestBundle(
    node: unknown,
    bundleSizeBytes?: number,
    onProgress?: ProgressCallback,
  ): Promise<{ pkg: string; version: string }> {
    assertBundle(node);
    const bundle = node;
    const root = bundle.module;
    const version = bundle.version;
    const aliases = (bundle.aliases ?? {}) as Record<string, string>;

    // Wall-clock timing: ingest is dominated by R2/D1 round-trips on
    // Workers; surface per-phase timings so we can tell where time goes.
    const t0 = Date.now();
    const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(2)}s`;

    // Progress emit helper. Errors are swallowed so a broken stream writer
    // (e.g. client disconnect) never aborts an in-flight ingest.
    const emit = async (phase: string, done: number, total: number) => {
      if (!onProgress) return;
      try {
        await onProgress(phase, done, total);
      } catch {
        /* progress is best-effort */
      }
    };

    // --- Phase 1: pre-fetch existing state ---
    // Bundles-table lookup tells us whether this is a fresh ingest (no prior
    // blobs, no links to reconcile).  For a fresh bundle both subsequent
    // queries would return nothing, so we skip them and use empty
    // collections — the accumulate loop treats them the same way.
    // For re-uploads we run two bulk D1 queries to replace the old
    // N×(R2 HEAD + D1 SELECT) per-doc pattern.
    const tBundle = Date.now();
    const existingBundle = await this.graphDb.all(
      "SELECT 1 AS one FROM bundles WHERE module = ? AND version = ? LIMIT 1",
      [root, version],
    );
    const freshIngest = existingBundle.length === 0;
    console.log(
      `  [${elapsed()}] bundles lookup: ${Date.now() - tBundle}ms (fresh=${freshIngest})`,
    );

    let existingBlobs: Set<string>;
    let existingRefs: Map<string, Set<string>>;
    if (freshIngest) {
      existingBlobs = new Set();
      existingRefs = new Map();
    } else {
      const tPrefetch = Date.now();
      [existingBlobs, existingRefs] = await Promise.all([
        this._fetchExistingBlobKeys(root, version),
        this._fetchAllForwardRefsForBundle(root, version),
      ]);
      console.log(
        `  [${elapsed()}] pre-fetch: ${existingBlobs.size} blobs in ${Date.now() - tPrefetch}ms`,
      );
    }

    // --- Phase 2: accumulate blobs and graph statements (pure CPU, no I/O) ---
    // stage() queues one blob put and the corresponding graph statements.
    // All node inserts are collected separately from link inserts so the
    // flush can send them in the right order (nodes before links).
    const blobPuts: { key: Key; bytes: Uint8Array }[] = [];
    const nodeStmts: BatchStmt[] = [];
    const linkStmts: BatchStmt[] = [];

    const stage = (key: Key, bytes: Uint8Array, refs: Key[], digestInput?: Uint8Array): void => {
      blobPuts.push({ key, bytes });
      const s = this._buildBatchStmts(key, bytes, refs, existingBlobs, existingRefs, digestInput);
      nodeStmts.push(...s.nodeStmts);
      linkStmts.push(...s.linkStmts);
    };

    const exEntries = Object.entries(bundle.examples ?? {});
    for (const [name, section] of exEntries) {
      stage(
        { module: root, version, kind: "examples", path: name },
        encode(section),
        collectForwardRefsFromSection(section),
        encode(stripVolatileFields(section)),
      );
    }
    if (exEntries.length > 0) {
      console.log(`  [${elapsed()}] examples: ${exEntries.length} staged`);
      await emit("examples", exEntries.length, exEntries.length);
    }

    const asEntries = Object.entries(bundle.assets ?? {});
    for (const [name, raw] of asEntries) {
      stage({ module: root, version, kind: "assets", path: name }, toUint8(raw), []);
    }
    if (asEntries.length > 0) {
      console.log(`  [${elapsed()}] assets: ${asEntries.length} staged`);
      await emit("assets", asEntries.length, asEntries.length);
    }

    stage(
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
        stage({ module: root, version, kind: "meta", path: destName }, toUint8(logoBytes), []);
        storedLogoName = destName;
      }
    }

    const narrativeEntries = Object.entries(bundle.narrative ?? {});
    let docCount = 0;
    for (const [name, genDoc] of narrativeEntries) {
      const g = genDoc as TypedNode;
      if (g.__type !== "GeneratedDoc") {
        console.warn(`  docs: skipping ${name} (unexpected type ${g.__type})`);
        continue;
      }
      const ingestedDoc = generatedDocToIngested(g, name);
      stage(
        { module: root, version, kind: "docs", path: name },
        encode(ingestedDoc),
        collectForwardRefs(ingestedDoc),
        encode(stripVolatileFields(ingestedDoc)),
      );
      docCount++;
    }
    if (docCount > 0) {
      console.log(`  [${elapsed()}] docs: ${docCount} staged`);
      await emit("docs", docCount, narrativeEntries.length);
    }

    if (Array.isArray(bundle.toc) && bundle.toc.length > 0) {
      stage({ module: root, version, kind: "meta", path: "toc.cbor" }, encode(bundle.toc), []);
    }

    const apiEntries = Object.entries(bundle.api ?? {});
    const apiTotal = apiEntries.length;
    if (apiTotal > 0) console.log(`  [${elapsed()}] module: staging ${apiTotal} pages`);
    let apiCount = 0;
    for (const [qa, genDoc] of apiEntries) {
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
      const keyQa = qa.includes(":") ? qa.split(":")[0]! : qa;
      const keyMod = keyQa.split(".")[0] ?? root;
      const encoded = encode(ingestedDoc);
      stage(
        { module: keyMod, version, kind: "module", path: qa },
        encoded,
        collectForwardRefs(ingestedDoc),
        encode(stripVolatileFields(ingestedDoc)),
      );
      apiCount++;
    }
    if (apiCount > 0) {
      console.log(`  [${elapsed()}] module: ${apiCount} staged`);
      await emit("module", apiCount, apiTotal);
    }

    // --- Phase 3: flush — concurrent R2 puts + chunked D1 mega-batch ---
    // All nodeStmts precede linkStmts so subquery-based insLink always
    // finds the dest node row already present in the batch.
    const tFlush = Date.now();
    console.log(
      `  [${elapsed()}] flushing ${blobPuts.length} blobs, ${nodeStmts.length + linkStmts.length} graph stmts`,
    );
    const flushLog = (msg: string) => console.log(`  [${elapsed()}] ${msg}`);
    await Promise.all([
      this._putBlobsConcurrent(blobPuts, flushLog),
      this._flushGraphStmts([...nodeStmts, ...linkStmts], flushLog),
    ]);
    console.log(`  [${elapsed()}] flush done in ${Date.now() - tFlush}ms`);

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

    if (bundleSizeBytes !== undefined) {
      const now = Math.floor(Date.now() / 1000);
      await this.graphDb.run(
        "INSERT INTO bundles(module, version, bundle_size_bytes, ingested_at) VALUES (?, ?, ?, ?)" +
          " ON CONFLICT(module, version) DO UPDATE SET" +
          " bundle_size_bytes=excluded.bundle_size_bytes, ingested_at=excluded.ingested_at",
        [root, version, bundleSizeBytes, now],
      );
    }

    console.log(`  [${elapsed()}] ingestBundle: done`);
    return { pkg: root, version };
  }

  async close(): Promise<void> {
    await this.graphDb.close();
  }

  // -------------------------------------------------------------------------
  // Two-phase ingest helpers (used by ingestBundle)
  // -------------------------------------------------------------------------

  /** One D1 query replaces N R2 HEAD requests for existence checks. */
  private async _fetchExistingBlobKeys(root: string, version: string): Promise<Set<string>> {
    const rows = await this.graphDb.all<{ category: string; identifier: string }>(
      "SELECT category, identifier FROM nodes WHERE package=? AND version=? AND has_blob=1",
      [root, version],
    );
    return new Set(rows.map((r) => `${r.category}/${r.identifier}`));
  }

  /** One D1 JOIN query replaces N per-doc _getForwardRefs calls. */
  private async _fetchAllForwardRefsForBundle(
    root: string,
    version: string,
  ): Promise<Map<string, Set<string>>> {
    const rows = await this.graphDb.all<{
      src_category: string;
      src_identifier: string;
      dest_package: string;
      dest_version: string;
      dest_category: string;
      dest_identifier: string;
    }>(
      "SELECT n_src.category AS src_category, n_src.identifier AS src_identifier," +
        " n_dest.package AS dest_package, n_dest.version AS dest_version," +
        " n_dest.category AS dest_category, n_dest.identifier AS dest_identifier" +
        " FROM links" +
        " JOIN nodes AS n_src ON links.source = n_src.id" +
        " JOIN nodes AS n_dest ON links.dest = n_dest.id" +
        " WHERE n_src.package=? AND n_src.version=?",
      [root, version],
    );
    const map = new Map<string, Set<string>>();
    for (const r of rows) {
      const srcKey = `${r.src_category}/${r.src_identifier}`;
      let set = map.get(srcKey);
      if (!set) {
        set = new Set();
        map.set(srcKey, set);
      }
      set.add(
        keyStr({
          module: r.dest_package,
          version: r.dest_version,
          kind: r.dest_category,
          path: r.dest_identifier,
        }),
      );
    }
    return map;
  }

  /**
   * Pure (no I/O) graph-statement builder for one item.
   *
   * Returns stmts split into nodeStmts and linkStmts so the caller can
   * concatenate all nodeStmts before all linkStmts in the mega-batch —
   * guaranteeing dest nodes exist when the subquery-based insLink runs.
   */
  private _buildBatchStmts(
    key: Key,
    bytes: Uint8Array,
    refs: Key[],
    existingBlobs: Set<string>,
    existingRefs: Map<string, Set<string>>,
    digestInput?: Uint8Array,
  ): { nodeStmts: BatchStmt[]; linkStmts: BatchStmt[] } {
    const blobKey = `${key.kind}/${key.path}`;
    const isExisting = key.kind !== "assets" && existingBlobs.has(blobKey);
    const oldRefs = isExisting
      ? (existingRefs.get(blobKey) ?? new Set<string>())
      : new Set<string>();

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

    const nodeStmts: BatchStmt[] = [
      { sql: insNode, params: [key.module, key.version, key.kind, key.path] },
      { sql: updBlob, params: [digest, key.module, key.version, key.kind, key.path] },
      ...addedRefs.map((r) => ({ sql: insNode, params: [r.module, r.version, r.kind, r.path] })),
    ];
    const linkStmts: BatchStmt[] = [
      ...addedRefs.map((r) => ({
        sql: insLink,
        params: [key.module, key.version, key.kind, key.path, r.module, r.version, r.kind, r.path],
      })),
      ...removedRefStrs.map((s) => {
        const [m, v, k, p] = s.split("/");
        return {
          sql: delLink,
          params: [key.module, key.version, key.kind, key.path, m ?? "", v ?? "", k ?? "", p ?? ""],
        };
      }),
    ];

    return { nodeStmts, linkStmts };
  }

  /** Run all D1 graph writes in DB_CHUNK_SIZE-statement slices. */
  private async _flushGraphStmts(stmts: BatchStmt[], log?: (msg: string) => void): Promise<void> {
    const total = stmts.length;
    for (let i = 0; i < total; i += DB_CHUNK_SIZE) {
      await this.graphDb.batch(stmts.slice(i, i + DB_CHUNK_SIZE));
      log?.(`graph: ${Math.min(i + DB_CHUNK_SIZE, total)}/${total} stmts`);
    }
  }

  /** Put blobs concurrently up to BLOB_CONCURRENCY in-flight at a time. */
  private async _putBlobsConcurrent(
    blobs: { key: Key; bytes: Uint8Array }[],
    log?: (msg: string) => void,
  ): Promise<void> {
    if (blobs.length === 0) return;
    const store = this.blobStore;
    const total = blobs.length;
    let index = 0;
    let done = 0;
    const LOG_EVERY = 100;
    const worker = async (): Promise<void> => {
      while (true) {
        const i = index++;
        if (i >= total) break;
        await store.put(blobs[i]!.key, blobs[i]!.bytes);
        const d = ++done;
        if (d % LOG_EVERY === 0 || d === total) log?.(`blobs: ${d}/${total}`);
      }
    };
    await Promise.all(Array.from({ length: Math.min(BLOB_CONCURRENCY, total) }, worker));
  }

  // -------------------------------------------------------------------------
  // Core write — used by the directory-based ingest() path only.
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
    freshIngest: boolean = false,
  ): Promise<void> {
    // `freshIngest`: caller has confirmed there are no prior writes for
    // this (pkg, version). Skip both round-trips to find oldRefs — there
    // can't be any. Cuts subrequests-per-_put from 3 to 2 (and removes
    // a serialised network hop, which matters far more for wall time).
    // INSERT OR IGNORE in the batch below keeps the second-attempt case
    // safe if a fresh-flagged ingest is somehow retried.
    let oldRefs = new Set<string>();
    if (!freshIngest && key.kind !== "assets" && (await this.blobStore.has(key))) {
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
        params: [key.module, key.version, key.kind, key.path, r.module, r.version, r.kind, r.path],
      })),
    ];
    for (const s of removedRefStrs) {
      const [m, v, k, p] = s.split("/");
      stmts.push({
        sql: delLink,
        params: [key.module, key.version, key.kind, key.path, m ?? "", v ?? "", k ?? "", p ?? ""],
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
        encode(stripVolatileFields(section)),
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
          encode(stripVolatileFields(ingestedDoc)),
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
