// Thin wrapper over the papyri.db SQLite graph store.
//
// The ingest step writes two tables:
//   nodes  — one row per known key; has_blob=1 means the blob is on disk,
//            has_blob=0 means it is a placeholder for a not-yet-ingested ref
//            target (may carry wildcard version "*" or "?").
//   links  — directed edges (nodes.id source -> nodes.id dest)
//
// This module uses the DB for two things:
//   1. resolveRef:   pick the best on-disk document (has_blob=1) matching a ref.
//   2. getBackrefs:  return blob-backed documents that link to a given target.
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

// undefined = not yet opened; null = file was absent at open time.
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
 * Close and evict the cached read-only DB handle. The next call to
 * `openGraphDb()` will reopen the file, picking up any writes made since
 * (e.g. after the bundle ingest endpoint updates the graph).
 */
export function resetGraphDbCache(): void {
  if (_db) _db.close();
  _db = undefined;
}

/**
 * Resolve a RefInfo-shaped reference to a (package, version, kind, path)
 * tuple that is actually on disk. XRefs sometimes carry `version === "?"`
 * or a stale version; prefer the exact match but fall back to the same
 * (pkg, kind, path) on any version (lexicographic sort, descending).
 * Returns `null` if nothing matches.
 *
 * `kind === "api"` is a gen-time placeholder for unresolved cross-package
 * module refs; it is normalised to `"module"` here since the on-disk node
 * uses `kind = "module"`.
 */
export function resolveRef(ref: RefTuple): RefTuple | null {
  const db = openGraphDb();
  if (!db) return null;
  // Normalise gen-time "api" stub kind to the actual on-disk kind.
  const kind = ref.kind === "api" ? "module" : ref.kind;
  // Exact match first.
  const exact = db
    .prepare(
      "SELECT package, version, category, identifier FROM nodes " +
        "WHERE has_blob=1 AND package=? AND version=? AND category=? AND identifier=? LIMIT 1"
    )
    .get(ref.pkg, ref.ver, kind, ref.path) as
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
      "SELECT package, version, category, identifier FROM nodes " +
        "WHERE has_blob=1 AND package=? AND category=? AND identifier=?"
    )
    .all(ref.pkg, kind, ref.path) as Array<{
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
 *
 * In addition to exact-version links, also matches wildcard-version stubs
 * ("?" or "*") for the same (package, category, identifier).  These arise
 * from cross-package refs ingested by the TypeScript ingest path, which
 * cannot resolve the version at ingest time.  Pre-fix bundles may also
 * carry "api"-kind stubs (version="*", category="api") for the same path;
 * those are matched by the OR branch on category='api'.
 */
export function getBackrefs(target: RefTuple): RefTuple[] {
  const db = openGraphDb();
  if (!db) return [];
  const rows = db
    .prepare(
      "SELECT DISTINCT n_src.package, n_src.version, n_src.category, n_src.identifier " +
        "FROM links l " +
        "JOIN nodes n_src ON n_src.id = l.source " +
        "JOIN nodes n_dest ON n_dest.id = l.dest " +
        "WHERE n_src.has_blob=1 " +
        "AND n_dest.package=? AND n_dest.identifier=? " +
        "AND (" +
        "  (n_dest.version=? AND n_dest.category=?) " +
        "  OR (n_dest.version IN ('?','*') AND n_dest.category IN ('module','api'))" +
        ")"
    )
    .all(target.pkg, target.path, target.ver, target.kind) as Array<{
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
    `${a.pkg}/${a.ver}/${a.kind}/${a.path}`.localeCompare(`${b.pkg}/${b.ver}/${b.kind}/${b.path}`)
  );
  return out;
}
