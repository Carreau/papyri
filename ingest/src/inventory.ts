/**
 * Intersphinx inventory support — link *to* projects that don't use papyri.
 *
 * Sphinx publishes an `objects.inv` (format v2) at each doc root. It is a
 * 4-line plaintext header followed by a zlib-compressed body whose lines are:
 *
 *     <name> <domain>:<role> <priority> <uri> <dispname>
 *
 * e.g. `numpy.ndarray py:class 1 reference/generated/numpy.ndarray.html#$ -`
 *
 * Conventions:
 *   - a `uri` ending in `$` substitutes the object name for the `$`.
 *   - a `dispname` of `-` means "same as name".
 *   - `uri` is relative to the inventory's base URL.
 *
 * We parse the inventory once (at load time), resolve each `uri` to an
 * absolute URL against the project's base URL, and store the rows so the
 * viewer can resolve a cross-package `RefInfo` that points at an external
 * project to a real external href at render time.
 *
 * Decompression goes through the Web `DecompressionStream("deflate")` (zlib
 * format), a portable Web API with no backend-specific dependency.
 */
import type { GraphDb } from "./graph-db.js";

export interface InventoryObject {
  /** Fully-qualified dotted name, e.g. `numpy.ndarray`. */
  name: string;
  /** Sphinx domain, e.g. `py`, `std`, `c`. */
  domain: string;
  /** Sphinx role, e.g. `class`, `function`, `method`, `doc`, `label`. */
  role: string;
  /** Sphinx priority. >=0 is indexed; -1 is hidden. */
  priority: number;
  /** URI relative to the inventory base URL, with `$` already substituted. */
  uri: string;
  /** Human display name (resolved: `-` becomes `name`). */
  dispname: string;
}

export interface ParsedInventory {
  /** Project name from the inventory header (`# Project: ...`). */
  project: string;
  /** Project version from the inventory header (`# Version: ...`). */
  version: string;
  objects: InventoryObject[];
}

const HEADER_LINES = 4;
const NEWLINE = 0x0a;

async function inflateZlib(data: Uint8Array): Promise<string> {
  // Copy into a fresh ArrayBuffer so Blob accepts it as a BlobPart
  // (a Uint8Array backed by ArrayBufferLike — e.g. a Node Buffer — is
  // rejected by some runtimes). Mirrors the gzip handling in reingest.ts.
  const buf = new ArrayBuffer(data.byteLength);
  new Uint8Array(buf).set(data);
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream("deflate"));
  const out = await new Response(stream).arrayBuffer();
  return new TextDecoder("utf-8").decode(out);
}

/**
 * Parse a Sphinx `objects.inv` (format v2). Throws on a missing/unknown
 * header. Unparseable body lines are skipped rather than fatal — real
 * inventories occasionally carry stray lines.
 */
export async function parseObjectsInv(bytes: Uint8Array): Promise<ParsedInventory> {
  let newlines = 0;
  let headerEnd = -1;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === NEWLINE) {
      newlines++;
      if (newlines === HEADER_LINES) {
        headerEnd = i + 1;
        break;
      }
    }
  }
  if (headerEnd < 0) throw new Error("objects.inv: truncated header");

  const headerLines = new TextDecoder("utf-8").decode(bytes.subarray(0, headerEnd)).split("\n");
  if (!headerLines[0]?.startsWith("# Sphinx inventory version 2")) {
    throw new Error(`objects.inv: unsupported format: ${JSON.stringify(headerLines[0] ?? "")}`);
  }
  const project = (headerLines[1] ?? "").replace(/^#\s*Project:\s*/, "").trim();
  const version = (headerLines[2] ?? "").replace(/^#\s*Version:\s*/, "").trim();

  let body: string;
  try {
    body = await inflateZlib(bytes.subarray(headerEnd));
  } catch (err) {
    throw new Error(
      `objects.inv: failed to decompress body: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const objects: InventoryObject[] = [];
  // name  domain:role  priority  uri  dispname
  const line = /^(.+?)\s+(\S+?):(\S+)\s+(-?\d+)\s+(\S*)\s+(.*)$/;
  for (const raw of body.split("\n")) {
    const trimmed = raw.trimEnd();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const m = line.exec(trimmed);
    if (!m) continue;
    // The regex matched, so groups 1..6 are present.
    const name = m[1]!;
    const uriRaw = m[5]!;
    const disp = m[6]!;
    const uri = uriRaw.endsWith("$") ? uriRaw.slice(0, -1) + name : uriRaw;
    objects.push({
      name,
      domain: m[2]!,
      role: m[3]!,
      priority: Number(m[4]!),
      uri,
      dispname: disp === "-" ? name : disp,
    });
  }
  return { project, version, objects };
}

/**
 * Resolve an inventory `uri` (relative, `$` already substituted) to an
 * absolute URL against the project base. Absolute `uri`s are returned as-is.
 */
export function resolveExternalUri(baseUrl: string, uri: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl : baseUrl + "/";
  return new URL(uri, base).toString();
}

/**
 * Register a project (name + base URL) WITHOUT fetching its inventory, so the
 * admin UI can stage a (project, url) pair and fetch it on demand. Upserts the
 * `external_projects` row only; any objects already stored for the project are
 * left untouched, and `version`/`fetched_at` of an already-loaded project are
 * preserved (only the base URL is updated).
 */
export async function registerProject(
  graphDb: GraphDb,
  args: { name: string; baseUrl: string },
): Promise<void> {
  await graphDb.run(
    "INSERT INTO external_projects(name, base_url, version, fetched_at) VALUES(?,?,NULL,NULL) " +
      "ON CONFLICT(name) DO UPDATE SET base_url=excluded.base_url",
    [args.name, args.baseUrl],
  );
}

/**
 * Unload a project's inventory: delete its objects and reset
 * `version`/`fetched_at`, but KEEP the `external_projects` row (name + base
 * URL) so it can be re-loaded without re-typing. The middle ground between a
 * reload and a full drop.
 */
export async function unloadProject(graphDb: GraphDb, args: { name: string }): Promise<void> {
  await graphDb.batch([
    { sql: "DELETE FROM external_objects WHERE project=?", params: [args.name] },
    {
      sql: "UPDATE external_projects SET version=NULL, fetched_at=NULL WHERE name=?",
      params: [args.name],
    },
  ]);
}

/**
 * Persist an inventory into the `external_projects` / `external_objects`
 * tables. Replaces any previously-stored objects for the project (drop +
 * rebuild — the inventory is a derived cache, see PLAN.md). Object URIs are
 * resolved to absolute URLs at store time so the render-time lookup is a
 * single indexed read with no URL join.
 *
 * Returns the number of objects stored.
 */
export async function storeInventory(
  graphDb: GraphDb,
  args: {
    name: string;
    baseUrl: string;
    version: string;
    objects: InventoryObject[];
    fetchedAt?: number;
  },
): Promise<number> {
  const { name, baseUrl, version, objects } = args;
  const fetchedAt = args.fetchedAt ?? Date.now();

  await graphDb.batch([
    {
      sql:
        "INSERT INTO external_projects(name, base_url, version, fetched_at) VALUES(?,?,?,?) " +
        "ON CONFLICT(name) DO UPDATE SET base_url=excluded.base_url, version=excluded.version, fetched_at=excluded.fetched_at",
      params: [name, baseUrl, version, fetchedAt],
    },
    { sql: "DELETE FROM external_objects WHERE project=?", params: [name] },
  ]);

  const CHUNK = 200;
  for (let i = 0; i < objects.length; i += CHUNK) {
    const stmts = objects.slice(i, i + CHUNK).map((o) => ({
      sql:
        "INSERT OR REPLACE INTO external_objects" +
        "(project, name, domain, role, uri, dispname, priority) VALUES(?,?,?,?,?,?,?)",
      params: [
        name,
        o.name,
        o.domain,
        o.role,
        resolveExternalUri(baseUrl, o.uri),
        o.dispname,
        o.priority,
      ],
    }));
    await graphDb.batch(stmts);
  }
  return objects.length;
}
