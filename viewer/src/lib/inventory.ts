// Outbound-link resolution via Sphinx intersphinx inventories.
//
// Flow:
//   1. `papyri intersphinx fetch` (Python side) downloads `objects.inv` files
//      and writes `registry.json` into the cache dir (default
//      `~/.papyri/inventories/`).
//   2. Papyri's relink pass tags unresolved cross-references whose owning
//      project is in the intersphinx registry as `kind="intersphinx"` with
//      `module=<project-key>`.
//   3. The viewer's `resolveXref` sees `kind === "intersphinx"` and calls
//      `lookupIntersphinx` here to produce an external URL.
//
// No registry is vendored in the viewer: the Python side owns the source of
// truth (via the `intersphinx_registry` pypi package) and writes a manifest
// the viewer consumes. If the manifest is missing, every lookup returns null
// and refs tagged `intersphinx` render as plain text.
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";

export interface InventoryEntry {
  name: string;
  domain: string;
  role: string;
  priority: number;
  uri: string;
  displayName: string;
}

export interface ResolvedInventoryEntry extends InventoryEntry {
  /** Absolute URL the entry resolves to (base + uri, with `$` expanded). */
  url: string;
}

interface ManifestEntry {
  url: string;
  inventory_url?: string;
}

interface LoadedInventory {
  baseUrl: string;
  byName: Map<string, InventoryEntry>;
}

export function inventoryCacheDir(): string {
  return (
    process.env.PAPYRI_INVENTORY_DIR ??
    join(homedir(), ".papyri", "inventories")
  );
}

/**
 * Parse a Sphinx inventory v2 file. Throws if the header is missing or the
 * version isn't 2. Non-v2 inventories (Sphinx v1 from 2007-era docs) are
 * intentionally unsupported — the only project using v1 today is Python 2.
 */
export function parseInventory(buffer: Uint8Array): {
  project: string;
  version: string;
  entries: InventoryEntry[];
} {
  const header: string[] = [];
  let offset = 0;
  while (header.length < 4 && offset < buffer.length) {
    const nl = buffer.indexOf(0x0a, offset);
    if (nl < 0) break;
    header.push(Buffer.from(buffer.subarray(offset, nl)).toString("utf8"));
    offset = nl + 1;
  }
  if (header.length < 4) {
    throw new Error("inventory: truncated header");
  }
  if (!/^# Sphinx inventory version 2\b/.test(header[0]!)) {
    throw new Error(`inventory: unsupported header: ${header[0]}`);
  }
  const project = (header[1]!.match(/^# Project:\s*(.*)$/)?.[1] ?? "").trim();
  const version = (header[2]!.match(/^# Version:\s*(.*)$/)?.[1] ?? "").trim();

  const body = inflateSync(buffer.subarray(offset)).toString("utf8");
  const entries: InventoryEntry[] = [];
  // Mirror Sphinx' line regex: non-greedy `name`, greedy `display_name`.
  const re = /^(.+?)\s+(\S+)\s+(-?\d+)\s+(\S+)\s+(.*)$/;
  for (const raw of body.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line || line.startsWith("#")) continue;
    const m = re.exec(line);
    if (!m) continue;
    const [, name, typ, prio, uri, disp] = m as unknown as [
      string, string, string, string, string, string
    ];
    const colon = typ.indexOf(":");
    if (colon < 0) continue;
    const domain = typ.slice(0, colon);
    const role = typ.slice(colon + 1);
    const expandedUri = uri.endsWith("$") ? uri.slice(0, -1) + name : uri;
    const displayName = disp === "-" ? name : disp;
    entries.push({
      name,
      domain,
      role,
      priority: parseInt(prio, 10),
      uri: expandedUri,
      displayName,
    });
  }
  return { project, version, entries };
}

// ---------------------------------------------------------------------------
// Cache: loaded lazily on first lookup, keyed by project name (which matches
// both the manifest key and the `<project>.inv` filename).
// ---------------------------------------------------------------------------

let _cache: Map<string, LoadedInventory> | null = null;

/** Reset the in-memory cache. Test-only. */
export function _resetInventoryCache(): void {
  _cache = null;
}

function readManifest(dir: string): Record<string, ManifestEntry> {
  const path = join(dir, "registry.json");
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, ManifestEntry>;
  } catch {
    return {};
  }
}

function loadAll(): Map<string, LoadedInventory> {
  if (_cache) return _cache;
  const out = new Map<string, LoadedInventory>();
  const dir = inventoryCacheDir();
  if (!existsSync(dir)) {
    _cache = out;
    return out;
  }
  const manifest = readManifest(dir);
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    _cache = out;
    return out;
  }
  for (const fname of files) {
    if (!fname.endsWith(".inv")) continue;
    const project = fname.slice(0, -".inv".length);
    const entry = manifest[project];
    if (!entry) continue; // inventory on disk without a manifest entry: skip.
    const baseUrl = entry.url.endsWith("/") ? entry.url : entry.url + "/";
    try {
      const buf = readFileSync(join(dir, fname));
      const parsed = parseInventory(buf);
      const byName = new Map<string, InventoryEntry>();
      for (const e of parsed.entries) {
        // Priority-aware dedup: priority < 0 means "fallback only".
        const prev = byName.get(e.name);
        if (!prev) {
          byName.set(e.name, e);
          continue;
        }
        if (prev.priority < 0 && e.priority >= 0) {
          byName.set(e.name, e);
          continue;
        }
        if (e.priority >= 0 && e.priority < prev.priority) {
          byName.set(e.name, e);
        }
      }
      out.set(project, { baseUrl, byName });
    } catch {
      // Skip unreadable / malformed inventories silently.
    }
  }
  _cache = out;
  return out;
}

/**
 * Resolve a qualified name against a registered project's inventory. Papyri
 * paths sometimes use a colon separator (e.g. "numpy.fft:fft_helper"); Sphinx
 * inventories use dots. Try the raw name first, then colon-normalised.
 */
export function lookupIntersphinx(
  project: string | null | undefined,
  name: string,
): ResolvedInventoryEntry | null {
  if (!project) return null;
  const inv = loadAll().get(project);
  if (!inv) return null;
  const candidates = [name];
  if (name.includes(":")) candidates.push(name.replace(/:/g, "."));
  for (const candidate of candidates) {
    const entry = inv.byName.get(candidate);
    if (entry) {
      return { ...entry, url: inv.baseUrl + entry.uri };
    }
  }
  return null;
}

/** List projects currently loaded into the lookup cache. Test aid. */
export function loadedProjects(): string[] {
  return [...loadAll().keys()].sort();
}
