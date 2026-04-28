// Async wrappers over the cross-link graph (`nodes` / `links` tables).
//
// Everything routes through `papyri-ingest`'s `GraphDb` interface, so the
// same code runs against:
//   • better-sqlite3 (Node SSR / `pnpm serve`)  — `SqliteGraphDb`
//   • Cloudflare D1   (Workers / `wrangler dev`) — `D1GraphDb`
//
// Operations mirror the ingest tables:
//   nodes  — one row per known key; has_blob=1 means the blob is on disk,
//            has_blob=0 means it is a placeholder for a not-yet-ingested ref
//            target (may carry wildcard version "*" or "?").
//   links  — directed edges (source nodes.id → dest nodes.id)
//
// Two reader operations:
//   1. resolveRef  — pick the best on-disk document (has_blob=1) matching a
//                    ref (exact module/version/kind/path, falling back to
//                    same module/kind/path on any version).
//   2. getBackrefs — return blob-backed documents that link to a target.

import type { GraphDb } from "papyri-ingest";

export interface RefTuple {
  pkg: string;
  ver: string;
  kind: string;
  path: string;
}

interface NodeRow {
  package: string;
  version: string;
  category: string;
  identifier: string;
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
export async function resolveRef(graphDb: GraphDb, ref: RefTuple): Promise<RefTuple | null> {
  const kind = ref.kind === "api" ? "module" : ref.kind;
  const exact = await graphDb.get<NodeRow>(
    "SELECT package, version, category, identifier FROM nodes " +
      "WHERE has_blob=1 AND package=? AND version=? AND category=? AND identifier=? LIMIT 1",
    [ref.pkg, ref.ver, kind, ref.path]
  );
  if (exact) {
    return {
      pkg: exact.package,
      ver: exact.version,
      kind: exact.category,
      path: exact.identifier,
    };
  }
  const rows = await graphDb.all<NodeRow>(
    "SELECT package, version, category, identifier FROM nodes " +
      "WHERE has_blob=1 AND package=? AND category=? AND identifier=?",
    [ref.pkg, kind, ref.path]
  );
  if (rows.length === 0) return null;
  rows.sort((a, b) => b.version.localeCompare(a.version));
  const best = rows[0]!;
  return { pkg: best.package, ver: best.version, kind: best.category, path: best.identifier };
}

/**
 * Batch-resolve a list of refs in one query. Returns a map keyed by the
 * input ref's `pkg|ver|kind|path` so callers can look up resolutions
 * synchronously after `await`. Cheaper than N round-trips to D1.
 */
export async function resolveRefs(
  graphDb: GraphDb,
  refs: RefTuple[]
): Promise<Map<string, RefTuple>> {
  // Naive impl: parallel resolves. Good enough until N gets big — D1
  // batches don't help here because each lookup may need its own fallback
  // query. Switch to a single VALUES-based join if profiling shows it.
  const out = new Map<string, RefTuple>();
  await Promise.all(
    refs.map(async (r) => {
      const resolved = await resolveRef(graphDb, r);
      if (resolved) out.set(refKey(r), resolved);
    })
  );
  return out;
}

export function refKey(r: RefTuple): string {
  return `${r.pkg}|${r.ver}|${r.kind}|${r.path}`;
}

/**
 * Return the documents that link *to* the given target, as
 * (pkg, version, kind, path) tuples. Sorted lexicographically and
 * deduplicated. Empty list if the target has no incoming edges.
 *
 * In addition to exact-version links, also matches wildcard-version stubs
 * ("?" or "*") for the same (package, category, identifier).  These arise
 * from cross-package refs ingested by the TypeScript ingest path, which
 * cannot resolve the version at ingest time.
 */
export async function getBackrefs(graphDb: GraphDb, target: RefTuple): Promise<RefTuple[]> {
  const rows = await graphDb.all<NodeRow>(
    "SELECT DISTINCT n_src.package, n_src.version, n_src.category, n_src.identifier " +
      "FROM links l " +
      "JOIN nodes n_src ON n_src.id = l.source " +
      "JOIN nodes n_dest ON n_dest.id = l.dest " +
      "WHERE n_src.has_blob=1 " +
      "AND n_dest.package=? AND n_dest.identifier=? " +
      "AND (" +
      "  (n_dest.version=? AND n_dest.category=?) " +
      "  OR (n_dest.version IN ('?','*') AND n_dest.category=?)" +
      ")",
    [target.pkg, target.path, target.ver, target.kind, target.kind]
  );
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

/**
 * Map of `identifier → digest hex` for all blob-backed nodes of a given
 * (package, version, category). Digests are 16-byte BLAKE2b sums of the
 * raw blob bytes (see `Ingester._digest_blob`); we hex-encode here so
 * callers can compare across backends (better-sqlite3 returns Buffer,
 * D1 returns Uint8Array).
 */
export async function listDigests(
  graphDb: GraphDb,
  pkg: string,
  ver: string,
  category: string
): Promise<Map<string, string>> {
  const rows = await graphDb.all<{ identifier: string; digest: Uint8Array | null }>(
    "SELECT identifier, digest FROM nodes " +
      "WHERE has_blob=1 AND package=? AND version=? AND category=?",
    [pkg, ver, category]
  );
  const out = new Map<string, string>();
  for (const r of rows) {
    if (!r.digest) continue;
    const bytes =
      r.digest instanceof Uint8Array ? r.digest : new Uint8Array(r.digest as ArrayLike<number>);
    let hex = "";
    for (const b of bytes) hex += b.toString(16).padStart(2, "0");
    out.set(r.identifier, hex);
  }
  return out;
}

/** Distinct (pkg, ver) pairs of bundles that have any blob in the graph. */
export async function listBundlesViaGraph(
  graphDb: GraphDb
): Promise<{ pkg: string; ver: string }[]> {
  const rows = await graphDb.all<{ package: string; version: string }>(
    "SELECT DISTINCT package, version FROM nodes WHERE has_blob=1 ORDER BY package, version"
  );
  return rows.map((r) => ({ pkg: r.package, ver: r.version }));
}
