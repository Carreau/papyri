// Async wrappers over the cross-link graph (`nodes` / `links` tables).
//
// Everything routes through `papyri-ingest`'s `GraphDb` interface
// (`SqliteGraphDb` backed by better-sqlite3).
//
// Operations mirror the ingest tables:
//   nodes  — one row per known key; has_blob=1 means the blob is on disk,
//            has_blob=0 means it is a placeholder for a not-yet-ingested ref
//            target (may carry wildcard version "?").
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
 */
export async function resolveRef(graphDb: GraphDb, ref: RefTuple): Promise<RefTuple | null> {
  const exact = await graphDb.get<NodeRow>(
    "SELECT package, version, category, identifier FROM nodes " +
      "WHERE has_blob=1 AND package=? AND version=? AND category=? AND identifier=? LIMIT 1",
    [ref.pkg, ref.ver, ref.kind, ref.path]
  );
  if (exact) {
    return {
      pkg: exact.package,
      ver: exact.version,
      kind: exact.category,
      path: exact.identifier,
    };
  }
  // Only fall back to any version when the ref itself didn't pin one.
  // A ref with an explicit version that is missing from this viewer should
  // render as unresolved — silently landing on the wrong version is confusing.
  if (ref.ver !== "?") return null;
  const rows = await graphDb.all<NodeRow>(
    "SELECT package, version, category, identifier FROM nodes " +
      "WHERE has_blob=1 AND package=? AND category=? AND identifier=?",
    [ref.pkg, ref.kind, ref.path]
  );
  if (rows.length === 0) return null;
  rows.sort((a, b) => b.version.localeCompare(a.version));
  const best = rows[0]!;
  return { pkg: best.package, ver: best.version, kind: best.category, path: best.identifier };
}

/**
 * Batch-resolve a list of refs in one query. Returns a map keyed by the
 * input ref's `pkg|ver|kind|path` so callers can look up resolutions
 * synchronously after `await`.
 */
export async function resolveRefs(
  graphDb: GraphDb,
  refs: RefTuple[]
): Promise<Map<string, RefTuple>> {
  // Naive impl: parallel resolves. Each lookup may need its own fallback
  // query; switch to a single VALUES-based join if profiling shows it.
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

interface ExternalRow {
  uri: string;
}

/**
 * Resolve refs against the external (intersphinx) inventory tables — the
 * fallback for cross-package refs that point at a project which does NOT
 * publish a papyri bundle (numpy, the Python stdlib, …). Returns a map keyed
 * by `refKey` → absolute external URL.
 *
 * Matching is by **object name**, like real intersphinx: `ref.path` is the
 * gen-time `RefInfo.path` in full-qual colon form (`numpy.linalg:inv`), which
 * we normalise to the dotted Sphinx name (`numpy.linalg.inv`) and look up
 * across *every* registered inventory.
 *
 * We deliberately do NOT constrain the lookup to `project = ref.pkg`. Gen sets
 * `RefInfo.module` to the object's real top-level defining module — `pathlib`,
 * `collections`, `json`, … for the standard library — but the whole stdlib is
 * published as a *single* Sphinx inventory (conventionally registered here
 * under one project name such as `python`). A project-scoped match would
 * require registering that inventory once per stdlib top-level module; matching
 * by name lets one `python` inventory satisfy them all.
 *
 * Tie-breaking when a name exists in several inventories / domains:
 *   1. prefer the inventory whose project name equals the ref's top-level
 *      module (`numpy` ref → `numpy` inventory), so a same-named object in an
 *      unrelated project can't shadow the obvious one;
 *   2. then the `py` domain;
 *   3. then indexed (`priority >= 0`) over hidden;
 *   4. then the lowest priority value.
 */
export async function resolveExternalRefs(
  graphDb: GraphDb,
  refs: RefTuple[]
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  await Promise.all(
    refs.map(async (r) => {
      const dotName = r.path.replace(/:/g, ".");
      // Python's stdlib objects.inv uses bare names for builtins: "repr" not
      // "builtins.repr", "True" not "builtins.True".  Gen emits the full
      // "builtins:name" path so the module field is correct; here we also
      // probe the bare form so a registered "python" inventory resolves them.
      const bareName = dotName.startsWith("builtins.") ? dotName.slice("builtins.".length) : null;
      const row =
        bareName !== null
          ? await graphDb.get<ExternalRow>(
              "SELECT uri FROM external_objects WHERE name IN (?,?) " +
                "ORDER BY (project=?) DESC, (domain='py') DESC, (priority>=0) DESC, priority ASC LIMIT 1",
              [dotName, bareName, r.pkg]
            )
          : await graphDb.get<ExternalRow>(
              "SELECT uri FROM external_objects WHERE name=? " +
                "ORDER BY (project=?) DESC, (domain='py') DESC, (priority>=0) DESC, priority ASC LIMIT 1",
              [dotName, r.pkg]
            );
      if (row?.uri) out.set(refKey(r), row.uri);
    })
  );
  return out;
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
      "  OR (n_dest.version='?' AND n_dest.category=?)" +
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

export interface BrokenBackref {
  srcPkg: string;
  srcVer: string;
  srcKind: string;
  srcPath: string;
  destKind: string;
  destPath: string;
}

/**
 * Return incoming cross-references that do not resolve to `(pkg, ver)`:
 *
 *  • Exact-version refs — another bundle linked to `(pkg, ver, identifier)`
 *    specifically, but that identifier has no blob in this version.
 *    With the corrected `resolveRef` (no fallback for pinned versions), these
 *    will render as unresolved `<span class="xref unresolved">`.
 *
 *  • Wildcard-version refs — another bundle linked to `(pkg, '?', identifier)`,
 *    meaning "whatever version is available", but the identifier has no blob in
 *    `ver`. These will either resolve to a different version (older/newer) or
 *    stay unresolved if no version has it.
 *
 * Both cases tell a maintainer "someone is pointing at an identifier that is
 * missing from THIS version of my package."
 *
 * Capped at 500 rows (PLAN.md recommendation).
 */
export async function getBrokenBackrefs(
  graphDb: GraphDb,
  pkg: string,
  ver: string
): Promise<BrokenBackref[]> {
  interface Row {
    src_pkg: string;
    src_ver: string;
    src_kind: string;
    src_path: string;
    dest_kind: string;
    dest_path: string;
  }
  const rows = await graphDb.all<Row>(
    "SELECT DISTINCT " +
      "n_src.package AS src_pkg, n_src.version AS src_ver, " +
      "n_src.category AS src_kind, n_src.identifier AS src_path, " +
      "n_dest.category AS dest_kind, n_dest.identifier AS dest_path " +
      "FROM links l " +
      "JOIN nodes n_src ON n_src.id = l.source " +
      "JOIN nodes n_dest ON n_dest.id = l.dest " +
      "WHERE n_src.has_blob=1 " +
      "AND n_dest.package=? " +
      "AND (" +
      "  (n_dest.version=? AND n_dest.has_blob=0)" +
      "  OR (n_dest.version='?'" +
      "      AND NOT EXISTS (" +
      "        SELECT 1 FROM nodes n_ver" +
      "        WHERE n_ver.package=? AND n_ver.version=?" +
      "          AND n_ver.category=n_dest.category" +
      "          AND n_ver.identifier=n_dest.identifier" +
      "          AND n_ver.has_blob=1" +
      "      ))" +
      ") " +
      "ORDER BY n_src.package, n_src.version, n_src.identifier " +
      "LIMIT 500",
    [pkg, ver, pkg, ver]
  );
  return rows.map((r) => ({
    srcPkg: r.src_pkg,
    srcVer: r.src_ver,
    srcKind: r.src_kind,
    srcPath: r.src_path,
    destKind: r.dest_kind,
    destPath: r.dest_path,
  }));
}

/**
 * Count of broken incoming backref rows for `(pkg, ver)` — the number shown
 * on the bundle index badge. Capped at 500 (same as getBrokenBackrefs).
 */
export async function countBrokenBackrefs(
  graphDb: GraphDb,
  pkg: string,
  ver: string
): Promise<number> {
  const row = await graphDb.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM (" +
      "SELECT DISTINCT n_src.id, n_dest.id " +
      "FROM links l " +
      "JOIN nodes n_src ON n_src.id = l.source " +
      "JOIN nodes n_dest ON n_dest.id = l.dest " +
      "WHERE n_src.has_blob=1 " +
      "AND n_dest.package=? " +
      "AND (" +
      "  (n_dest.version=? AND n_dest.has_blob=0)" +
      "  OR (n_dest.version='?'" +
      "      AND NOT EXISTS (" +
      "        SELECT 1 FROM nodes n_ver" +
      "        WHERE n_ver.package=? AND n_ver.version=?" +
      "          AND n_ver.category=n_dest.category" +
      "          AND n_ver.identifier=n_dest.identifier" +
      "          AND n_ver.has_blob=1" +
      "      ))" +
      ") " +
      "LIMIT 500" +
      ")",
    [pkg, ver, pkg, ver]
  );
  return row?.n ?? 0;
}

/**
 * Map of `version → digest hex` for all blob-backed nodes of a given
 * (package, category, identifier) across every ingested version. Used by
 * the DocSwitcher to group versions by identical content.
 */
export async function getVersionDigests(
  graphDb: GraphDb,
  pkg: string,
  category: string,
  identifier: string
): Promise<Map<string, string>> {
  const rows = await graphDb.all<{ version: string; digest: Uint8Array | null }>(
    "SELECT version, digest FROM nodes " +
      "WHERE has_blob=1 AND package=? AND category=? AND identifier=?",
    [pkg, category, identifier]
  );
  const out = new Map<string, string>();
  for (const r of rows) {
    if (!r.digest) continue;
    const bytes =
      r.digest instanceof Uint8Array ? r.digest : new Uint8Array(r.digest as ArrayLike<number>);
    let hex = "";
    for (const b of bytes) hex += b.toString(16).padStart(2, "0");
    out.set(r.version, hex);
  }
  return out;
}

/**
 * Map of `identifier → digest hex` for all blob-backed nodes of a given
 * (package, version, category). Digests are 16-byte BLAKE2b sums of the
 * raw blob bytes (see `Ingester._digest_blob`); we hex-encode here so
 * callers can compare (better-sqlite3 returns Buffer, normalised to hex).
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
