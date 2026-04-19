// Outbound-link support via Sphinx intersphinx inventories.
//
// Phase A of the intersphinx interop plan (see top-level PLAN.md follow-ups):
// when a papyri cross-reference cannot be resolved against the local graph
// store, fall back to an external Sphinx project's `objects.inv`. The
// registry mapping (project name -> docs base URL) is vendored at
// `src/data/intersphinx-registry.json` and mirrors a small slice of the
// `intersphinx_registry` PyPI package.
//
// Inventory files themselves are NOT vendored. They're downloaded by
// `scripts/fetch-inventories.mjs` into a cache dir (defaults to
// `~/.papyri/inventories/`, overridable via `PAPYRI_INVENTORY_DIR`). If the
// cache is missing or partial we degrade silently — unresolved refs still
// render as plain text, same as before this module existed.
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import registryData from "../data/intersphinx-registry.json" with { type: "json" };

// Sphinx inventory v2 entry. See
// https://www.sphinx-doc.org/en/master/usage/extensions/intersphinx.html
// for the file format. Fields match the whitespace-separated columns.
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

interface RegistryEntry {
  url: string;
}
interface RegistryFile {
  projects: Record<string, RegistryEntry>;
}

const REGISTRY = (registryData as RegistryFile).projects;

export function inventoryCacheDir(): string {
  return (
    process.env.PAPYRI_INVENTORY_DIR ??
    join(homedir(), ".papyri", "inventories")
  );
}

/** Return the URL where `<project>`'s `objects.inv` is expected to live. */
export function inventoryUrlFor(project: string): string | null {
  const entry = REGISTRY[project];
  if (!entry) return null;
  // Registry URLs are conventionally base dirs ending in `/`; guard just in case.
  const base = entry.url.endsWith("/") ? entry.url : entry.url + "/";
  return base + "objects.inv";
}

export function registryProjects(): string[] {
  return Object.keys(REGISTRY);
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
  // Pull the 4 header lines out of the uncompressed prefix.
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
  // header[3] is the zlib-marker line; don't validate strictly.

  const body = inflateSync(buffer.subarray(offset)).toString("utf8");
  const entries: InventoryEntry[] = [];
  // Entry grammar (from Sphinx' InventoryFile):
  //   <name> <domain>:<role> <priority> <uri> <display_name>
  // `name` and `display_name` may contain spaces. In practice Sphinx' writer
  // never emits a space-containing name, but display_name regularly does
  // (it's the human-readable title). The standard-library parser uses
  //   re.match(r'(?x)(.+?)\s+(\S+)\s+(-?\d+)\s+(\S+)\s+(.*)', line)
  // which is non-greedy on `name`, greedy on `display_name`. Mirror that.
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
    // `$` suffix in uri expands to the entry name (Sphinx convention).
    const expandedUri = uri.endsWith("$")
      ? uri.slice(0, -1) + name
      : uri;
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
// Loaded-inventory registry. Populated lazily on first lookup.
// ---------------------------------------------------------------------------

interface LoadedInventory {
  baseUrl: string;
  byName: Map<string, InventoryEntry>;
}

let _cache: Map<string, LoadedInventory> | null = null;

/** Reset the in-memory cache. Test-only. */
export function _resetInventoryCache(): void {
  _cache = null;
}

function loadAll(): Map<string, LoadedInventory> {
  if (_cache) return _cache;
  const out = new Map<string, LoadedInventory>();
  const dir = inventoryCacheDir();
  if (!existsSync(dir)) {
    _cache = out;
    return out;
  }
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
    const registryEntry = REGISTRY[project];
    if (!registryEntry) continue;
    const baseUrl = registryEntry.url.endsWith("/")
      ? registryEntry.url
      : registryEntry.url + "/";
    try {
      const buf = readFileSync(join(dir, fname));
      const parsed = parseInventory(buf);
      const byName = new Map<string, InventoryEntry>();
      for (const e of parsed.entries) {
        // Prefer higher-priority entries when names collide (lower number =
        // higher priority in Sphinx' scheme; 1 beats -1). Reject priority=-1
        // unless no other entry exists: -1 marks "hidden, fallback only".
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
 * Look up a qualified name in the external inventories.
 *
 * `project` is the Python module name (e.g. "numpy"), matched against the
 * registry. `name` is the fully qualified symbol (e.g. "numpy.linspace").
 * Returns the resolved URL + display label, or null if the project has no
 * loaded inventory or the name isn't present.
 *
 * Papyri paths sometimes contain a colon separator (e.g.
 * "numpy.fft:fft_helper"); Sphinx inventories use dots. We try the raw name
 * first, then the colon-normalised form.
 */
export function lookupExternal(
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

/**
 * Best-effort outbound resolver. Given whatever a missing RefInfo carries,
 * try to produce a link into an external Sphinx-hosted documentation site.
 *
 * `module` comes straight from `RefInfo.module`. When it's null (papyri's
 * "unresolved" sentinel sets module=null), we derive a candidate from the
 * first dotted component of `path`: "numpy.linspace" -> "numpy".
 */
export function resolveExternal(
  module: string | null | undefined,
  path: string,
): { url: string; label: string } | null {
  if (!path) return null;
  const tried = new Set<string>();
  const projects: string[] = [];
  if (module) projects.push(module);
  // Fall back: first dotted component of the path.
  const firstDot = path.split(/[.:]/, 1)[0];
  if (firstDot && firstDot !== module) projects.push(firstDot);
  for (const project of projects) {
    if (tried.has(project)) continue;
    tried.add(project);
    const hit = lookupExternal(project, path);
    if (hit) return { url: hit.url, label: hit.displayName };
  }
  return null;
}
