/**
 * Ingester — TypeScript equivalent of papyri/crosslink.py's Ingester class.
 *
 * Accepts a decoded `Bundle` Node from a `.papyri` artifact
 * (`ingestBundle(node)`) and writes its contents into the cross-link graph
 * store via the `BlobStore` + `GraphDb` abstractions. The packed `.papyri`
 * artifact is the only ingest input — there is no directory-based path.
 *
 * The default backend is Node fs + better-sqlite3, built from `ingestDir`.
 * Pre-built backends can be injected via the `backends` option.
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

import { readdirSync, readFileSync, mkdirSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { encode as cborEncode } from "cbor-x";
import { blake2b } from "@noble/hashes/blake2b.js";
import Database from "better-sqlite3";
import { encode, generatedDocToIngested } from "./encoder.js";
import type { TypedNode } from "./encoder.js";
import { assertBundle, assertSafeUrls } from "./bundle.js";
import { keyStr, type Key } from "./keys.js";
import { collectForwardRefs, collectForwardRefsFromSection } from "./visitor.js";
import { FsBlobStore, type BlobStore } from "./blob-store.js";
import { SqliteGraphDb, type GraphDb, type BatchStmt } from "./graph-db.js";

const DIGEST_SIZE = 16;

// Max concurrent blob puts during a bundle flush.
const BLOB_CONCURRENCY = 100;

// Cap per db.batch() call to keep individual transactions bounded.
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
 * Apply pending SQL migrations from `ingest/migrations/` to `db`.
 *
 * Versioning uses SQLite's `PRAGMA user_version`: a migration file named
 * `NNNN_*.sql` carries version `NNNN`, and after it is applied the DB's
 * `user_version` is bumped to `NNNN`. On each call we run only the files
 * whose number is greater than the stored `user_version`, in ascending
 * order. This applies to both freshly created and pre-existing DBs — the
 * long-running viewer calls this on startup so a schema change reaches a
 * live DB without a wipe.
 *
 * Each file (its statements + the version bump) runs in a single
 * transaction so a crash mid-file cannot leave the version half-advanced.
 * Migration bodies use `IF NOT EXISTS` where possible, so a re-run is a
 * no-op; `ALTER TABLE ADD COLUMN` (which SQLite has no `IF NOT EXISTS`
 * for) is kept safe by the version gate running it exactly once.
 *
 * @param db - The database to migrate.
 * @param dir - Path to the migrations directory. When omitted, resolved
 *   relative to this source file — correct for the standalone CLI and
 *   tests, but callers in a bundled context (e.g. the viewer's
 *   `backends.ts`) must pass an explicit path via `import.meta.resolve`.
 */
export function applyMigrations(db: Database.Database, dir?: string): void {
  const resolvedDir = dir ?? migrationsDir();
  const current = (db.prepare("PRAGMA user_version").get() as { user_version: number })
    .user_version;
  const files = readdirSync(resolvedDir)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => ({ file: f, num: Number.parseInt(f.slice(0, 4), 10) }))
    .filter((m) => m.num > current)
    .sort((a, b) => a.num - b.num);
  for (const { file, num } of files) {
    const stmts = splitStatements(readFileSync(join(resolvedDir, file), "utf8"));
    // user_version cannot be a bound `?` parameter; `num` is a parsed
    // integer from the filename, not user input, so interpolation is safe.
    db.transaction(() => {
      for (const stmt of stmts) db.prepare(stmt).run();
      db.prepare(`PRAGMA user_version = ${num}`).run();
    })();
    console.log(`  migration applied: ${file} (user_version=${num})`);
  }
}

/**
 * Build Node-mode backends (filesystem blob store + better-sqlite3 graph
 * db). Applies migrations on init. Used by `Ingester` when the caller
 * provides `ingestDir` instead of explicit backends.
 */
function openNodeBackends(ingestDir: string): { blobStore: BlobStore; graphDb: GraphDb } {
  mkdirSync(ingestDir, { recursive: true });
  const dbPath = join(ingestDir, "papyri.db");
  const db = new Database(dbPath);
  for (const p of PRAGMAS) db.prepare(p).run();
  applyMigrations(db);
  return {
    blobStore: new FsBlobStore(ingestDir),
    graphDb: new SqliteGraphDb(db),
  };
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
  /**
   * Custom Node ingest directory (defaults to ~/.papyri/ingest). Ignored
   * when `backends` is set.
   */
  ingestDir?: string;
  /**
   * Pre-built async backends. Overrides the default fs + SQLite pair.
   */
  backends?: { blobStore: BlobStore; graphDb: GraphDb };
}

function defaultIngestDir(): string {
  const override = process.env["PAPYRI_INGEST_DIR"];
  if (override) return override;
  return join(process.env["HOME"] ?? "/root", ".papyri", "ingest");
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
   * Ingest a decoded `Bundle` Node — the sole ingest entry point. The Bundle
   * comes from a `.papyri` artifact (gunzip + cbor-decode); both the viewer's
   * PUT /api/bundle handler and the standalone CLI feed it here.
   */
  async ingestBundle(
    node: unknown,
    bundleSizeBytes?: number,
    onProgress?: ProgressCallback,
    contentHash?: string,
  ): Promise<{ pkg: string; version: string }> {
    assertBundle(node);
    assertSafeUrls(node);
    const bundle = node;
    const root = bundle.module;
    const version = bundle.version;
    const aliases = (bundle.aliases ?? {}) as Record<string, string>;

    // Per-phase wall-clock timings so we can tell where time goes.
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
    // For re-uploads we run two bulk queries to replace the old
    // per-doc SELECT + HEAD pattern.
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
    let existingRefs: Map<string, Map<string, Key>>;
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

    // --- Phase 3: flush — concurrent blob puts + chunked graph mega-batch ---
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
        "INSERT INTO bundles(module, version, bundle_size_bytes, ingested_at, content_hash)" +
          " VALUES (?, ?, ?, ?, ?)" +
          " ON CONFLICT(module, version) DO UPDATE SET" +
          " bundle_size_bytes=excluded.bundle_size_bytes, ingested_at=excluded.ingested_at," +
          " content_hash=excluded.content_hash",
        [root, version, bundleSizeBytes, now, contentHash ?? null],
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

  /** Bulk DB query replaces N per-doc HEAD requests for existence checks. */
  private async _fetchExistingBlobKeys(root: string, version: string): Promise<Set<string>> {
    const rows = await this.graphDb.all<{ category: string; identifier: string }>(
      "SELECT category, identifier FROM nodes WHERE package=? AND version=? AND has_blob=1",
      [root, version],
    );
    return new Set(rows.map((r) => `${r.category}/${r.identifier}`));
  }

  /** One bulk JOIN query replaces N per-doc _getForwardRefs calls. */
  private async _fetchAllForwardRefsForBundle(
    root: string,
    version: string,
  ): Promise<Map<string, Map<string, Key>>> {
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
    const map = new Map<string, Map<string, Key>>();
    for (const r of rows) {
      const srcKey = `${r.src_category}/${r.src_identifier}`;
      let inner = map.get(srcKey);
      if (!inner) {
        inner = new Map();
        map.set(srcKey, inner);
      }
      const destKey: Key = {
        module: r.dest_package,
        version: r.dest_version,
        kind: r.dest_category,
        path: r.dest_identifier,
      };
      inner.set(keyStr(destKey), destKey);
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
    existingRefs: Map<string, Map<string, Key>>,
    digestInput?: Uint8Array,
  ): { nodeStmts: BatchStmt[]; linkStmts: BatchStmt[] } {
    const blobKey = `${key.kind}/${key.path}`;
    const isExisting = key.kind !== "assets" && existingBlobs.has(blobKey);
    const oldRefs = isExisting
      ? (existingRefs.get(blobKey) ?? new Map<string, Key>())
      : new Map<string, Key>();

    const digest = blake2b(digestInput ?? bytes, { dkLen: DIGEST_SIZE });
    const newRefSet = new Set(refs.map(keyStr));
    const addedRefs = refs.filter((r) => !oldRefs.has(keyStr(r)));
    const removedRefs = [...oldRefs.values()].filter((k) => !newRefSet.has(keyStr(k)));

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
      ...removedRefs.map((r) => ({
        sql: delLink,
        params: [key.module, key.version, key.kind, key.path, r.module, r.version, r.kind, r.path],
      })),
    ];

    return { nodeStmts, linkStmts };
  }

  /** Run all graph writes in DB_CHUNK_SIZE-statement slices. */
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
