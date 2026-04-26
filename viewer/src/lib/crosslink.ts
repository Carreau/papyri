// TypeScript crosslink engine — mirrors the write side of graphstore.py.
//
// After a bundle is uploaded (or placed on disk), this module:
//   1. Opens / creates the SQLite graph DB with the canonical schema.
//   2. Walks module/, docs/, and examples/ through the StorageBackend.
//   3. For each file: decodes the CBOR, collects non-local RefInfo refs,
//      upserts a `nodes` row (has_blob=1), and replaces the outgoing `links`.
//
// Digest note: graphstore.py records 16-byte BLAKE2b-128 fingerprints. Node
// has no built-in BLAKE2b with variable output length (only blake2b512). We
// store NULL for now; the digest column is only used by `papyri diff`, a
// Python CLI command. Add @noble/hashes if TS-side diffing is ever needed.
//
// Storage note: the engine reads exclusively through StorageBackend so the
// same code works when the backing store is swapped from local filesystem to
// R2 (or any other object store). The DB handle is passed in by the caller so
// the engine is not coupled to a specific DB path or connection strategy.

import Database from "better-sqlite3";
import type DatabaseType from "better-sqlite3";
import { decodeCborBytes } from "./ir-reader.ts";
import type { StorageBackend } from "./storage.ts";

// ---------------------------------------------------------------------------
// Schema — mirrors graphstore.py _SCHEMA.
// ---------------------------------------------------------------------------

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS nodes(
  id         INTEGER PRIMARY KEY,
  package    TEXT NOT NULL,
  version    TEXT NOT NULL,
  category   TEXT NOT NULL,
  identifier TEXT NOT NULL,
  has_blob   INTEGER NOT NULL DEFAULT 0,
  digest     BLOB,
  UNIQUE(package, version, category, identifier)
);
CREATE TABLE IF NOT EXISTS links(
  source INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  dest   INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  PRIMARY KEY (source, dest)
);
CREATE INDEX IF NOT EXISTS idx_links_dest ON links(dest);
CREATE INDEX IF NOT EXISTS idx_nodes_pkg_cat_ident
  ON nodes(package, category, identifier);
`;

const PRAGMAS = [
  "PRAGMA foreign_keys = 1",
  "PRAGMA journal_mode = WAL",
  "PRAGMA synchronous = NORMAL",
  "PRAGMA cache_size = -65536",
  "PRAGMA mmap_size = 268435456",
];

export function openCrosslinkDb(dbPath: string): DatabaseType.Database {
  const db = new Database(dbPath);
  for (const p of PRAGMAS) db.exec(p);
  db.exec(SCHEMA_SQL);
  return db;
}

// ---------------------------------------------------------------------------
// RefInfo collection — depth-first walk of a decoded CBOR tree.
// ---------------------------------------------------------------------------

interface RefInfo {
  module: string;
  version: string;
  kind: string;
  path: string;
}

function collectRefs(node: unknown, out: RefInfo[] = []): RefInfo[] {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, out);
    return out;
  }
  const obj = node as Record<string, unknown>;
  // A RefInfo node decoded from CBOR tag 4000 has __type="RefInfo".
  // kind="local" is a within-document anchor; it is not a graph edge.
  if (
    obj["__type"] === "RefInfo" &&
    typeof obj["kind"] === "string" &&
    obj["kind"] !== "local" &&
    typeof obj["module"] === "string" &&
    obj["module"] &&
    typeof obj["path"] === "string" &&
    obj["path"]
  ) {
    out.push({
      module: obj["module"] as string,
      version: String(obj["version"] ?? "?"),
      kind: obj["kind"] as string,
      path: obj["path"] as string,
    });
  }
  for (const v of Object.values(obj)) collectRefs(v, out);
  return out;
}

// ---------------------------------------------------------------------------
// DB helpers — correspond to graphstore.py _maybe_insert_node / put.
// ---------------------------------------------------------------------------

function upsertNode(
  stmts: PreparedStmts,
  pkg: string,
  version: string,
  category: string,
  identifier: string,
  hasBlob: boolean
): number {
  stmts.insertIgnore.run(pkg, version, category, identifier);
  const row = stmts.selectId.get(pkg, version, category, identifier) as { id: number };
  if (hasBlob) {
    // digest=NULL: see module-level note on BLAKE2b.
    stmts.setHasBlob.run(row.id);
  }
  return row.id;
}

function processFile(
  stmts: PreparedStmts,
  pkg: string,
  version: string,
  category: string,
  identifier: string,
  bytes: Uint8Array
): number {
  let decoded: unknown;
  try {
    decoded = decodeCborBytes(bytes);
  } catch {
    return 0;
  }

  const refs = collectRefs(decoded);
  const sourceId = upsertNode(stmts, pkg, version, category, identifier, true);

  stmts.deleteLinks.run(sourceId);
  let linkCount = 0;
  for (const ref of refs) {
    const destId = upsertNode(stmts, ref.module, ref.version, ref.kind, ref.path, false);
    stmts.insertLink.run(sourceId, destId);
    linkCount++;
  }
  return linkCount;
}

// ---------------------------------------------------------------------------
// Prepared statement cache — created once per crosslinkBundle call so they
// are compiled inside the transaction's connection lifetime.
// ---------------------------------------------------------------------------

interface PreparedStmts {
  insertIgnore: DatabaseType.Statement;
  selectId: DatabaseType.Statement;
  setHasBlob: DatabaseType.Statement;
  deleteLinks: DatabaseType.Statement;
  insertLink: DatabaseType.Statement;
}

function prepareStmts(db: DatabaseType.Database): PreparedStmts {
  return {
    insertIgnore: db.prepare(
      "INSERT OR IGNORE INTO nodes(package, version, category, identifier) VALUES (?,?,?,?)"
    ),
    selectId: db.prepare(
      "SELECT id FROM nodes WHERE package=? AND version=? AND category=? AND identifier=?"
    ),
    setHasBlob: db.prepare("UPDATE nodes SET has_blob=1, digest=NULL WHERE id=?"),
    deleteLinks: db.prepare("DELETE FROM links WHERE source=?"),
    insertLink: db.prepare("INSERT OR IGNORE INTO links(source, dest) VALUES (?,?)"),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CrosslinkStats {
  /** Number of CBOR blobs processed (nodes upserted with has_blob=1). */
  blobs: number;
  /** Total outgoing links inserted for this bundle. */
  links: number;
}

// Categories whose files are indexed in the graph.
const CATEGORIES: ReadonlyArray<{ prefix: string; category: string }> = [
  { prefix: "module/", category: "module" },
  { prefix: "docs/", category: "docs" },
  { prefix: "examples/", category: "examples" },
];

/**
 * Walk a bundle in `storage` and update `db` with nodes + links for every
 * CBOR blob in the tracked categories.
 *
 * Everything runs inside a single transaction so either the whole bundle is
 * indexed or nothing is (the caller can still surface a partial-read error
 * and leave the blob files in place for a later retry).
 */
export async function crosslinkBundle(
  storage: StorageBackend,
  pkg: string,
  version: string,
  db: DatabaseType.Database
): Promise<CrosslinkStats> {
  // Build the file list before opening the transaction (async I/O not allowed
  // inside better-sqlite3's synchronous transaction wrapper).
  const fileList: Array<{ category: string; identifier: string; key: string }> = [];
  for (const { prefix, category } of CATEGORIES) {
    const keys = await storage.list(prefix);
    for (const key of keys) {
      let identifier = key.slice(prefix.length);
      if (identifier.endsWith(".cbor")) identifier = identifier.slice(0, -5);
      fileList.push({ category, identifier, key });
    }
  }

  // Read all blobs before the transaction (async).
  const blobs: Array<{ category: string; identifier: string; bytes: Uint8Array }> = [];
  for (const entry of fileList) {
    const bytes = await storage.get(entry.key);
    if (bytes) blobs.push({ category: entry.category, identifier: entry.identifier, bytes });
  }

  // Write phase: synchronous transaction.
  let totalBlobs = 0;
  let totalLinks = 0;

  const stmts = prepareStmts(db);
  const runTransaction = db.transaction(() => {
    for (const { category, identifier, bytes } of blobs) {
      const links = processFile(stmts, pkg, version, category, identifier, bytes);
      totalBlobs++;
      totalLinks += links;
    }
  });
  runTransaction();

  return { blobs: totalBlobs, links: totalLinks };
}
