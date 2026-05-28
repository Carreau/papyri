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
  const url = await import(/* @vite-ignore */ "node:url");
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
  // Resolve the migrations directory via import.meta.resolve so this works
  // whether the ingest package is bundled inline by Vite or loaded as an
  // external. import.meta.url here may point to the bundle file rather than
  // ingest/src/ingest.ts, so we cannot use migrationsDir() from ingest.ts
  // directly — instead we let Node.js search node_modules upward at runtime.
  const sentinelUrl = import.meta.resolve("papyri-ingest/migrations/0001_init.sql");
  const migrationsPath = path.dirname(url.fileURLToPath(sentinelUrl));
  ingest.applyMigrations(db, migrationsPath);

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
