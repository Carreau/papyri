/**
 * Write-capable GraphStore: SQLite graph index + filesystem blob store.
 *
 * Mirrors papyri/graphstore.py — same schema, same on-disk layout, same
 * digest algorithm so digests computed here are byte-identical to those
 * produced by the Python tool.
 *
 * Layout: <root>/<module>/<version>/<kind>/<identifier>
 * SQLite: <root>/papyri.db  (nodes + links tables)
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { blake2b } from "@noble/hashes/blake2b.js";
import DatabaseType from "better-sqlite3";
import Database from "better-sqlite3";

const DIGEST_SIZE = 16;

// ---------------------------------------------------------------------------
// Key
// ---------------------------------------------------------------------------

export interface Key {
  module: string;
  version: string;
  kind: string;
  path: string;
}

export function keyEq(a: Key, b: Key): boolean {
  return a.module === b.module && a.version === b.version && a.kind === b.kind && a.path === b.path;
}

export function keyStr(k: Key): string {
  return `${k.module}/${k.version}/${k.kind}/${k.path}`;
}

// ---------------------------------------------------------------------------
// Schema
//
// Single source of truth: `ingest/migrations/*.sql`. The Cloudflare D1
// path applies the same files via `wrangler d1 migrations apply`
// (`viewer/wrangler.toml` points `migrations_dir = "../ingest/migrations"`).
//
// Two consumers, two ways the schema can reach the GraphStore constructor:
//
//   1. The `papyri-ingest` CLI runs from `dist/cli.js` → `dist/graphstore.js`.
//      `import.meta.url` points at the actual file on disk, so the lazy
//      disk loader below resolves `../migrations/*.sql` correctly.
//
//   2. The viewer's SSR bundle is produced by Vite, which inlines
//      `graphstore.ts` into `dist/server/chunks/<hash>.mjs`. There the
//      `import.meta.url` is a chunk path with no sibling `migrations/`
//      dir. To handle that, callers can pass `schemaSql` explicitly
//      (e.g. via Vite's `?raw` import) and skip the disk loader.
// ---------------------------------------------------------------------------

function migrationsDir(): string {
  // Resolved lazily because this module is loaded transitively by viewer
  // code that runs inside the Cloudflare prerender miniflare worker,
  // where `import.meta.url` is not always a `file:` URL. The
  // `new GraphStore()` constructor that needs this path never runs in
  // that context.
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "migrations");
}

function loadSchemaFromDisk(): string {
  const dir = migrationsDir();
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort(); // lexicographic so 0000_*.sql lands before 0001_*.sql
  return files.map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
}

function splitStatements(sql: string): string[] {
  // SQLite `--` line comments are stripped before splitting so a comment
  // ending in `;` doesn't confuse the splitter. We don't use string
  // literals containing `--` or `;` in the migrations themselves; if that
  // ever changes, swap this for a real tokenizer.
  const stripped = sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  return stripped
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const PRAGMAS = [
  "PRAGMA foreign_keys = 1",
  "PRAGMA journal_mode = WAL",
  "PRAGMA synchronous = NORMAL",
  "PRAGMA cache_size = -65536",
  "PRAGMA mmap_size = 268435456",
];

// ---------------------------------------------------------------------------
// GraphStore
// ---------------------------------------------------------------------------

export interface GraphStoreOptions {
  /**
   * Schema SQL applied when the SQLite file is first created. Combined
   * `migrations/*.sql` content; statements are split on `;` and exec'd
   * in order. Pass this when the caller's runtime can't reach the
   * on-disk migrations dir — e.g. a Vite-bundled SSR worker. The CLI
   * can omit it; the disk loader handles `dist/cli.js` correctly.
   */
  schemaSql?: string;
}

export class GraphStore {
  private db: DatabaseType.Database;
  private root: string;

  constructor(ingestDir: string, options: GraphStoreOptions = {}) {
    this.root = ingestDir;
    const dbPath = join(ingestDir, "papyri.db");
    const isNew = !existsSync(dbPath);
    mkdirSync(ingestDir, { recursive: true });

    this.db = new Database(dbPath);
    for (const p of PRAGMAS) this.db.exec(p);

    if (isNew) {
      const sql = options.schemaSql ?? loadSchemaFromDisk();
      for (const stmt of splitStatements(sql)) this.db.exec(stmt);
    }
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private keyToPath(key: Key): string {
    return join(this.root, key.module, key.version, key.kind, key.path);
  }

  private maybeInsertNode(
    key: Key,
    opts: { hasBlob?: boolean; digest?: Uint8Array | null } = {},
  ): number {
    const { hasBlob = false, digest = null } = opts;
    // INSERT OR IGNORE; then SELECT to get the id either way.
    let row = this.db
      .prepare(
        "INSERT OR IGNORE INTO nodes(package, version, category, identifier)" +
          " VALUES (?, ?, ?, ?) RETURNING id",
      )
      .get(key.module, key.version, key.kind, key.path) as { id: number } | undefined;

    if (row === undefined) {
      row = this.db
        .prepare(
          "SELECT id FROM nodes WHERE package=? AND version=? AND category=? AND identifier=?",
        )
        .get(key.module, key.version, key.kind, key.path) as { id: number };
    }

    const nodeId = row.id;
    if (hasBlob) {
      this.db
        .prepare("UPDATE nodes SET has_blob=1, digest=? WHERE id=?")
        .run(digest ?? null, nodeId);
    }
    return nodeId;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Store blob bytes under `key`, recording forward-ref links to `refs`.
   * Computes a 16-byte BLAKE2b digest of `bytes` (matching Python's
   * `hashlib.blake2b(bytes, digest_size=16)`).
   */
  put(key: Key, bytes: Uint8Array, refs: Key[]): void {
    const blobPath = this.keyToPath(key);
    mkdirSync(dirname(blobPath), { recursive: true });

    // For non-asset keys, read old forward refs so we can diff them.
    let oldRefs: Set<string>;
    if (key.kind !== "assets" && existsSync(blobPath)) {
      oldRefs = new Set(this.getForwardRefs(key).map(keyStr));
    } else {
      oldRefs = new Set();
    }

    writeFileSync(blobPath, bytes);
    const digest = blake2b(bytes, { dkLen: DIGEST_SIZE });

    const newRefSet = new Set(refs.map(keyStr));
    const addedRefs = refs.filter((r) => !oldRefs.has(keyStr(r)));
    const removedRefStrs = [...oldRefs].filter((s) => !newRefSet.has(s));

    const tx = this.db.transaction(() => {
      const sourceId = this.maybeInsertNode(key, { hasBlob: true, digest });

      const addParams = addedRefs.map(
        (r) => [sourceId, this.maybeInsertNode(r)] as [number, number],
      );
      const addStmt = this.db.prepare("INSERT OR IGNORE INTO links(source, dest) VALUES (?,?)");
      for (const p of addParams) addStmt.run(...p);

      if (removedRefStrs.length > 0) {
        // Look up ids for the removed refs.
        const placeholders = removedRefStrs.map(() => "(?,?,?,?)").join(",");
        const params: string[] = [];
        for (const s of removedRefStrs) {
          const [mod, ver, kind, path] = s.split("/");
          params.push(mod ?? "", ver ?? "", kind ?? "", path ?? "");
        }
        const rows = this.db
          .prepare(
            `SELECT id FROM nodes WHERE (package, version, category, identifier) IN (VALUES ${placeholders})`,
          )
          .all(...params) as { id: number }[];
        const delStmt = this.db.prepare("DELETE FROM links WHERE source=? AND dest=?");
        for (const r of rows) delStmt.run(sourceId, r.id);
      }
    });
    tx();
  }

  /** Write a per-bundle meta.cbor (not tracked in the nodes table). */
  putMeta(module: string, version: string, data: Uint8Array): void {
    const metaPath = join(this.root, module, version, "meta.cbor");
    mkdirSync(dirname(metaPath), { recursive: true });
    writeFileSync(metaPath, data);
  }

  /** Read blob bytes for a key. */
  get(key: Key): Buffer {
    return readFileSync(this.keyToPath(key));
  }

  /** Return all keys with blobs that match the (possibly-null) pattern fields. */
  glob(pattern: Partial<Key>): Key[] {
    const clauses: string[] = [];
    const params: string[] = [];
    for (const [col, field] of [
      ["package", "module"],
      ["version", "version"],
      ["category", "kind"],
      ["identifier", "path"],
    ] as [string, keyof Key][]) {
      const val = pattern[field];
      if (val !== undefined && val !== null) {
        clauses.push(`${col}=?`);
        params.push(val);
      }
    }
    clauses.push("has_blob=1");
    const where = "WHERE " + clauses.join(" AND ");
    const rows = this.db
      .prepare(`SELECT package, version, category, identifier FROM nodes ${where}`)
      .all(...params) as {
      package: string;
      version: string;
      category: string;
      identifier: string;
    }[];
    return rows.map((r) => ({
      module: r.package,
      version: r.version,
      kind: r.category,
      path: r.identifier,
    }));
  }

  /** Return the set of keys that `key` references (forward edges). */
  getForwardRefs(key: Key): Key[] {
    const rows = this.db
      .prepare(
        "SELECT n_dest.package, n_dest.version, n_dest.category, n_dest.identifier " +
          "FROM links " +
          "JOIN nodes AS n_src  ON links.source = n_src.id " +
          "JOIN nodes AS n_dest ON links.dest   = n_dest.id " +
          "WHERE n_src.package=? AND n_src.version=? AND n_src.category=? AND n_src.identifier=?",
      )
      .all(key.module, key.version, key.kind, key.path) as {
      package: string;
      version: string;
      category: string;
      identifier: string;
    }[];
    return rows.map((r) => ({
      module: r.package,
      version: r.version,
      kind: r.category,
      path: r.identifier,
    }));
  }

  /** Return the set of keys that link TO `key` (back edges). */
  getBackRefs(key: Key): Key[] {
    const rows = this.db
      .prepare(
        "SELECT n_src.package, n_src.version, n_src.category, n_src.identifier " +
          "FROM links " +
          "JOIN nodes AS n_src  ON links.source = n_src.id " +
          "JOIN nodes AS n_dest ON links.dest   = n_dest.id " +
          "WHERE n_dest.package=? AND n_dest.version=? AND n_dest.category=? AND n_dest.identifier=?",
      )
      .all(key.module, key.version, key.kind, key.path) as {
      package: string;
      version: string;
      category: string;
      identifier: string;
    }[];
    return rows.map((r) => ({
      module: r.package,
      version: r.version,
      kind: r.category,
      path: r.identifier,
    }));
  }

  close(): void {
    this.db.close();
  }
}
