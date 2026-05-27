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
  for (const sql of ["PRAGMA journal_mode = WAL", "PRAGMA synchronous = NORMAL"]) {
    db.prepare(sql).run();
  }
  // Schema lives in ingest/migrations/*.sql; applyMigrations brings this
  // long-running server's DB up to the latest version on startup (it runs
  // pending migrations against existing DBs too, not just fresh ones).
  ingest.applyMigrations(db);

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
