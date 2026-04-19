// Thin wrapper over the papyri.db SQLite graph store.
//
// The ingest step writes three tables (see docs/IR.md):
//   documents    — one row per blob actually on disk under the ingest tree
//   destinations — one row per ref target (may be dangling)
//   links        — directed edges (documents.id -> destinations.id)
//
// M2 uses this for two things:
//   1. resolveRef:   pick the best on-disk document matching a given ref tuple.
//   2. getBackrefs:  for a document target, return the documents linking to it.
//
// better-sqlite3 is a sync API, which matches Astro's SSG build model. We
// keep a single cached Database connection per process (Astro runs one
// build process) and degrade gracefully when the DB file is missing
// (fresh checkout / CI).
import { existsSync } from "node:fs";
import type DatabaseType from "better-sqlite3";
import Database from "better-sqlite3";
import { ingestDb } from "./paths.ts";

export interface RefTuple {
  pkg: string;
  ver: string;
  kind: string;
  path: string;
}

let _db: DatabaseType.Database | null | undefined;

/**
 * Return a cached read-only handle to the ingest graph DB, or `null` if the
 * file is absent. Callers should treat `null` as "no graph information
 * available" and degrade accordingly.
 */
export function openGraphDb(): DatabaseType.Database | null {
  if (_db !== undefined) return _db;
  const path = ingestDb();
  if (!existsSync(path)) {
    _db = null;
    return null;
  }
  try {
    _db = new Database(path, { readonly: true, fileMustExist: true });
    return _db;
  } catch {
    _db = null;
    return null;
  }
}

/**
 * Resolve a RefInfo-shaped reference to a (package, version, kind, path)
 * tuple that is actually on disk. XRefs sometimes carry `version === "?"`
 * or a stale version; prefer the exact match but fall back to the same
 * (pkg, kind, path) on any version (lexicographic sort, descending).
 * Returns `null` if nothing matches.
 */
export function resolveRef(ref: RefTuple): RefTuple | null {
  const db = openGraphDb();
  if (!db) return null;
  // Exact match first.
  const exact = db
    .prepare(
      "SELECT package, version, category, identifier FROM documents " +
        "WHERE package=? AND version=? AND category=? AND identifier=? LIMIT 1",
    )
    .get(ref.pkg, ref.ver, ref.kind, ref.path) as
    | { package: string; version: string; category: string; identifier: string }
    | undefined;
  if (exact) {
    return {
      pkg: exact.package,
      ver: exact.version,
      kind: exact.category,
      path: exact.identifier,
    };
  }
  // Fall back: any version of the same (pkg, kind, path), pick the newest
  // by lexicographic sort. Sort in JS so semver-ish strings work even though
  // SQLite collation is plain text.
  const rows = db
    .prepare(
      "SELECT package, version, category, identifier FROM documents " +
        "WHERE package=? AND category=? AND identifier=?",
    )
    .all(ref.pkg, ref.kind, ref.path) as Array<{
    package: string;
    version: string;
    category: string;
    identifier: string;
  }>;
  if (rows.length === 0) return null;
  rows.sort((a, b) => b.version.localeCompare(a.version));
  const best = rows[0]!;
  return {
    pkg: best.package,
    ver: best.version,
    kind: best.category,
    path: best.identifier,
  };
}

/**
 * Return the documents that link *to* the given target, as
 * (pkg, version, kind, path) tuples. Sorted lexicographically and
 * deduplicated. Empty list if the DB is missing or the target has no
 * incoming edges.
 */
export function getBackrefs(target: RefTuple): RefTuple[] {
  const db = openGraphDb();
  if (!db) return [];
  const rows = db
    .prepare(
      "SELECT DISTINCT d.package, d.version, d.category, d.identifier " +
        "FROM links l " +
        "JOIN destinations ds ON ds.id = l.dest " +
        "JOIN documents d ON d.id = l.source " +
        "WHERE ds.package=? AND ds.version=? AND ds.category=? AND ds.identifier=?",
    )
    .all(target.pkg, target.ver, target.kind, target.path) as Array<{
    package: string;
    version: string;
    category: string;
    identifier: string;
  }>;
  const out: RefTuple[] = rows.map((r) => ({
    pkg: r.package,
    ver: r.version,
    kind: r.category,
    path: r.identifier,
  }));
  out.sort((a, b) =>
    `${a.pkg}/${a.ver}/${a.kind}/${a.path}`.localeCompare(
      `${b.pkg}/${b.ver}/${b.kind}/${b.path}`,
    ),
  );
  return out;
}
