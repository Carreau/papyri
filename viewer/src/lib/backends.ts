/**
 * Request-scoped storage backend factory.
 *
 * Returns a `{ blobStore, graphDb, rawStore }` triple backed by the local
 * filesystem + SQLite under `~/.papyri/ingest/` (or the paths set by
 * `PAPYRI_INGEST_DIR` / `PAPYRI_INGEST_DB`).
 *
 * The Node-side modules are loaded via dynamic `import()` so Vite/Rollup can
 * tree-shake them in future build targets.
 */
import { FsRawStore, type BlobStore, type GraphDb, type RawStore } from "papyri-ingest";
// Type-only import; erased at compile time.
import type BetterSqlite3 from "better-sqlite3";

export interface Backends {
  blobStore: BlobStore;
  graphDb: GraphDb;
  rawStore: RawStore;
}

async function nodeBackends(): Promise<Backends> {
  const ingest = await import(/* @vite-ignore */ "papyri-ingest");
  const fs = await import(/* @vite-ignore */ "node:fs");
  const path = await import(/* @vite-ignore */ "node:path");
  const os = await import(/* @vite-ignore */ "node:os");
  const sqliteMod = (await import(/* @vite-ignore */ "better-sqlite3")) as {
    default: typeof BetterSqlite3;
  };
  const Database = sqliteMod.default;

  const ingestDir = process.env.PAPYRI_INGEST_DIR ?? path.join(os.homedir(), ".papyri", "ingest");
  const dbPath = path.join(ingestDir, "papyri.db");

  fs.mkdirSync(ingestDir, { recursive: true });
  const db = new Database(dbPath) as BetterSqlite3.Database;
  for (const sql of [
    "PRAGMA journal_mode = WAL",
    "PRAGMA synchronous = NORMAL",
    "CREATE TABLE IF NOT EXISTS nodes (id INTEGER PRIMARY KEY, package TEXT NOT NULL, version TEXT NOT NULL, category TEXT NOT NULL, identifier TEXT NOT NULL, has_blob INTEGER NOT NULL DEFAULT 0, digest BLOB, UNIQUE (package, version, category, identifier))",
    "CREATE TABLE IF NOT EXISTS links (source INTEGER NOT NULL REFERENCES nodes (id) ON DELETE CASCADE, dest INTEGER NOT NULL REFERENCES nodes (id) ON DELETE CASCADE, PRIMARY KEY (source, dest))",
    "CREATE INDEX IF NOT EXISTS idx_links_dest ON links (dest)",
    "CREATE INDEX IF NOT EXISTS idx_nodes_pkg_cat_ident ON nodes (package, category, identifier)",
    "CREATE TABLE IF NOT EXISTS bundles (module TEXT NOT NULL, version TEXT NOT NULL, bundle_size_bytes INTEGER NOT NULL, ingested_at INTEGER NOT NULL, PRIMARY KEY (module, version))",
    "CREATE TABLE IF NOT EXISTS external_projects (name TEXT PRIMARY KEY, base_url TEXT NOT NULL, version TEXT, fetched_at INTEGER)",
    "CREATE TABLE IF NOT EXISTS external_objects (project TEXT NOT NULL REFERENCES external_projects (name) ON DELETE CASCADE, name TEXT NOT NULL, domain TEXT NOT NULL, role TEXT NOT NULL, uri TEXT NOT NULL, dispname TEXT, priority INTEGER, PRIMARY KEY (project, name, domain, role))",
    "CREATE INDEX IF NOT EXISTS idx_external_objects_name ON external_objects (project, name)",
  ]) {
    db.prepare(sql).run();
  }

  return {
    blobStore: new ingest.FsBlobStore(ingestDir),
    graphDb: new ingest.SqliteGraphDb(db),
    rawStore: new FsRawStore(ingestDir),
  };
}

let _cached: Promise<Backends> | null = null;

export async function getBackends(): Promise<Backends> {
  if (!_cached) _cached = nodeBackends();
  return _cached;
}

/**
 * Return the expected upload token, or `undefined` when auth is disabled
 * (local development without the env var set).
 */
export async function getUploadToken(): Promise<string | undefined> {
  return process.env.PAPYRI_UPLOAD_TOKEN || undefined;
}
