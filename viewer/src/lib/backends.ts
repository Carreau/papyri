/**
 * Request-scoped storage backend factory.
 *
 * Returns a `{ blobStore, graphDb }` pair pointing at whichever runtime is
 * serving the current request:
 *
 *   • Cloudflare Workers (`wrangler dev` / deployed). Bindings come from
 *     `import { env } from "cloudflare:workers"` — `env.BLOBS` (R2) and
 *     `env.GRAPH_DB` (D1). The schema is bootstrapped lazily on first use
 *     via `IF NOT EXISTS` DDL so a virgin local D1 (no `wrangler d1
 *     migrations apply` run) still works.
 *
 *   • Node SSR (`astro dev` / `pnpm serve`). The `cloudflare:workers`
 *     import fails; we fall back to fs+sqlite under `~/.papyri/ingest/`.
 *     The Node-side modules are loaded via dynamic `import()` so the
 *     Workers bundle never pulls in `node:fs` or `better-sqlite3`.
 *
 * Both branches return the same `BlobStore` / `GraphDb` interface, so all
 * consumer code (pages, libs) is backend-agnostic.
 */
import {
  R2BlobStore,
  D1GraphDb,
  type BlobStore,
  type GraphDb,
  type R2BucketLike,
  type D1DatabaseLike,
} from "papyri-ingest";
// Type-only import; erased at compile time, so the Workers bundle never
// pulls in the native better-sqlite3 addon.
import type BetterSqlite3 from "better-sqlite3";

interface WorkersEnv {
  GRAPH_DB?: D1DatabaseLike;
  BLOBS?: R2BucketLike;
}

export interface Backends {
  blobStore: BlobStore;
  graphDb: GraphDb;
}

async function loadCfEnv(): Promise<WorkersEnv | null> {
  try {
    const mod = (await import(/* @vite-ignore */ "cloudflare:workers")) as {
      env?: WorkersEnv;
    };
    return mod.env ?? null;
  } catch {
    return null;
  }
}

// D1 schema bootstrap — idempotent. Mirrors `ingest/migrations/0000_init.sql`
// with `IF NOT EXISTS` so re-running against a populated DB is a cheap
// no-op. Run once per worker isolate via the latch below.
let _d1SchemaApplied = false;
async function ensureD1Schema(graphDb: GraphDb): Promise<void> {
  if (_d1SchemaApplied) return;
  await graphDb.batch([
    {
      sql:
        "CREATE TABLE IF NOT EXISTS nodes (" +
        "  id INTEGER PRIMARY KEY," +
        "  package TEXT NOT NULL," +
        "  version TEXT NOT NULL," +
        "  category TEXT NOT NULL," +
        "  identifier TEXT NOT NULL," +
        "  has_blob INTEGER NOT NULL DEFAULT 0," +
        "  digest BLOB," +
        "  UNIQUE (package, version, category, identifier)" +
        ")",
    },
    {
      sql:
        "CREATE TABLE IF NOT EXISTS links (" +
        "  source INTEGER NOT NULL REFERENCES nodes (id) ON DELETE CASCADE," +
        "  dest INTEGER NOT NULL REFERENCES nodes (id) ON DELETE CASCADE," +
        "  PRIMARY KEY (source, dest)" +
        ")",
    },
    { sql: "CREATE INDEX IF NOT EXISTS idx_links_dest ON links (dest)" },
    {
      sql: "CREATE INDEX IF NOT EXISTS idx_nodes_pkg_cat_ident ON nodes (package, category, identifier)",
    },
  ]);
  _d1SchemaApplied = true;
}

// Node-side build: load via dynamic import so Vite/rollup leaves these
// outside the Workers bundle (the cloudflare adapter and `vite.external`
// in astro.config.mjs both need this to be lazy).
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
  // Apply schema idempotently (matches the Workers branch). The Ingester
  // also bootstraps schema for fresh DBs; we duplicate the IF NOT EXISTS
  // form here so the read-side viewer doesn't depend on a write happening
  // first.
  for (const sql of [
    "PRAGMA journal_mode = WAL",
    "PRAGMA synchronous = NORMAL",
    "CREATE TABLE IF NOT EXISTS nodes (id INTEGER PRIMARY KEY, package TEXT NOT NULL, version TEXT NOT NULL, category TEXT NOT NULL, identifier TEXT NOT NULL, has_blob INTEGER NOT NULL DEFAULT 0, digest BLOB, UNIQUE (package, version, category, identifier))",
    "CREATE TABLE IF NOT EXISTS links (source INTEGER NOT NULL REFERENCES nodes (id) ON DELETE CASCADE, dest INTEGER NOT NULL REFERENCES nodes (id) ON DELETE CASCADE, PRIMARY KEY (source, dest))",
    "CREATE INDEX IF NOT EXISTS idx_links_dest ON links (dest)",
    "CREATE INDEX IF NOT EXISTS idx_nodes_pkg_cat_ident ON nodes (package, category, identifier)",
  ]) {
    db.prepare(sql).run();
  }

  return {
    blobStore: new ingest.FsBlobStore(ingestDir),
    graphDb: new ingest.SqliteGraphDb(db),
  };
}

/**
 * Resolve backends for the current request. Cheap to call repeatedly — the
 * Node branch is cached per process; the Workers branch builds a thin
 * wrapper around shared bindings on each call.
 */
let _nodeCached: Promise<Backends> | null = null;

export async function getBackends(): Promise<Backends> {
  const cf = await loadCfEnv();
  if (cf?.GRAPH_DB && cf?.BLOBS) {
    const graphDb = new D1GraphDb(cf.GRAPH_DB);
    await ensureD1Schema(graphDb);
    return { blobStore: new R2BlobStore(cf.BLOBS), graphDb };
  }
  if (!_nodeCached) _nodeCached = nodeBackends();
  return _nodeCached;
}
