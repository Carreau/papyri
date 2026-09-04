/**
 * Request-scoped storage backend factory.
 *
 * Returns a `{ blobStore, graphDb, rawStore }` triple backed by the local
 * filesystem + SQLite under `~/.papyri/ingest/` (or the paths set by
 * `PAPYRI_INGEST_DIR` / `PAPYRI_INGEST_DB`).
 *
 * A PR preview is the same triple rooted at its own directory
 * (`~/.papyri/previews/<owner>/<repo>/pr<N>/`, see `preview.ts`) with its own
 * SQLite file, so a preview is fully isolated from the main graph and dropping
 * it is a directory removal. Callers that don't pass one explicitly get the
 * preview of the in-flight request (`request-context.ts`), which is how pages
 * serve preview content without threading the namespace through every call.
 *
 * Node built-ins and the native `better-sqlite3` binding are loaded via dynamic
 * `import()` so Vite/Rollup can tree-shake them in future build targets.
 * `papyri-ingest` is imported statically: it is a workspace package whose
 * `import` condition points at TypeScript source, so it must be bundled rather
 * than left as a runtime external.
 */
import {
  applyMigrations,
  FsBlobStore,
  FsRawStore,
  SqliteGraphDb,
  type BlobStore,
  type GraphDb,
  type RawStore,
} from "papyri-ingest";
// Type-only import; erased at compile time.
import type BetterSqlite3 from "better-sqlite3";
import { previewDir, previewId, type PreviewRef } from "./preview.ts";
import { currentPreview } from "./request-context.ts";

export interface Backends {
  blobStore: BlobStore;
  graphDb: GraphDb;
  rawStore: RawStore;
}

/**
 * How many preview databases stay open at once. Previews are numerous and
 * mostly cold; the main store is cached separately and never evicted.
 */
const MAX_OPEN_PREVIEWS = 8;

async function nodeBackends(root: string): Promise<Backends> {
  const fs = await import(/* @vite-ignore */ "node:fs");
  const path = await import(/* @vite-ignore */ "node:path");
  const url = await import(/* @vite-ignore */ "node:url");
  const sqliteMod = (await import(/* @vite-ignore */ "better-sqlite3")) as {
    default: typeof BetterSqlite3;
  };
  const Database = sqliteMod.default;

  const dbPath = path.join(root, "papyri.db");

  fs.mkdirSync(root, { recursive: true });
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
  applyMigrations(db, migrationsPath);

  return {
    blobStore: new FsBlobStore(root),
    graphDb: new SqliteGraphDb(db),
    rawStore: new FsRawStore(root),
  };
}

/** Directory holding the main (non-preview) store. */
export async function mainIngestDir(): Promise<string> {
  if (process.env.PAPYRI_INGEST_DIR) return process.env.PAPYRI_INGEST_DIR;
  const path = await import(/* @vite-ignore */ "node:path");
  const os = await import(/* @vite-ignore */ "node:os");
  return path.join(os.homedir(), ".papyri", "ingest");
}

let _main: Promise<Backends> | null = null;
// Insertion-ordered — the first key is the least recently opened preview.
const _previews = new Map<string, Promise<Backends>>();

/**
 * Storage triple for the main store, or for `preview` when given. With no
 * argument the preview of the in-flight request is used (null outside one).
 */
export async function getBackends(preview?: PreviewRef | null): Promise<Backends> {
  const ref = preview === undefined ? currentPreview() : preview;
  if (!ref) {
    if (!_main) _main = mainIngestDir().then(nodeBackends);
    return _main;
  }
  const key = previewId(ref);
  const cached = _previews.get(key);
  if (cached) {
    // Refresh recency.
    _previews.delete(key);
    _previews.set(key, cached);
    return cached;
  }
  const created = nodeBackends(previewDir(ref));
  _previews.set(key, created);
  while (_previews.size > MAX_OPEN_PREVIEWS) {
    const oldest = _previews.keys().next();
    if (oldest.done) break;
    const evicted = _previews.get(oldest.value)!;
    _previews.delete(oldest.value);
    // Close on a best-effort basis: an in-flight request may still hold the
    // handle, and better-sqlite3 tolerates a close after the last statement.
    void evicted.then((b) => b.graphDb.close()).catch(() => {});
  }
  return created;
}

/**
 * Forget (and close) a cached preview backend. Called before a preview
 * directory is deleted so no open SQLite handle keeps the files alive.
 */
export async function closePreviewBackends(ref: PreviewRef): Promise<void> {
  const key = previewId(ref);
  const cached = _previews.get(key);
  if (!cached) return;
  _previews.delete(key);
  try {
    (await cached).graphDb.close();
  } catch {
    /* already closed or failed to open — nothing to release. */
  }
}

/**
 * Return the expected upload token, or `undefined` when auth is disabled
 * (local development without the env var set).
 */
export async function getUploadToken(): Promise<string | undefined> {
  return process.env.PAPYRI_UPLOAD_TOKEN || undefined;
}
