/**
 * RawStore — append-only archive of uploaded .papyri.gz bundles.
 *
 * Every bundle received by PUT /api/bundle is written here verbatim (the
 * compressed bytes as received off the wire) before ingest runs. This raw
 * archive is the source-of-truth for the processed store: if the ingest
 * schema changes or a pipeline bug is found, the processed store (BlobStore
 * + GraphDb) can be wiped and rebuilt from these raw bytes without requiring
 * maintainers to re-upload.
 *
 * Key convention used by both implementations:
 *   _raw/<pkg>/<ver>.papyri.gz
 *
 * The `_raw/` prefix is never a valid processed-blob key (those start with a
 * letter or digit) so the two namespaces are naturally disjoint when sharing
 * the same R2 bucket.
 *
 *   FsRawStore — Node filesystem, files at <ingest-dir>/_raw/<pkg>/<ver>.papyri.gz
 *   R2RawStore — Cloudflare R2, objects at _raw/<pkg>/<ver>.papyri.gz in BLOBS bucket
 */
import { mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { R2BucketLike } from "./blob-store.js";

export interface RawStore {
  /** Archive a raw .papyri.gz bundle (compressed bytes as received off the wire). */
  put(pkg: string, ver: string, bytes: Uint8Array): Promise<void>;
  /** Retrieve a previously archived bundle. Returns null if absent. */
  get(pkg: string, ver: string): Promise<Uint8Array | null>;
  /** List all archived (pkg, ver) pairs, sorted by pkg then ver. */
  list(): Promise<Array<{ pkg: string; ver: string }>>;
  /**
   * Drop every archived bundle. Returns the number of (pkg, ver) entries
   * removed. Idempotent — clearing an already-empty archive returns 0.
   */
  clear(): Promise<number>;
}

function rawKey(pkg: string, ver: string): string {
  return `_raw/${pkg}/${ver}.papyri.gz`;
}

function parseRawKey(key: string): { pkg: string; ver: string } | null {
  const m = /^_raw\/([^/]+)\/([^/]+)\.papyri\.gz$/.exec(key);
  if (!m || !m[1] || !m[2]) return null;
  return { pkg: m[1], ver: m[2] };
}

// ---------------------------------------------------------------------------
// Node filesystem
// ---------------------------------------------------------------------------

export class FsRawStore implements RawStore {
  constructor(private readonly root: string) {}

  private fullPath(pkg: string, ver: string): string {
    return join(this.root, "_raw", pkg, `${ver}.papyri.gz`);
  }

  async put(pkg: string, ver: string, bytes: Uint8Array): Promise<void> {
    const p = this.fullPath(pkg, ver);
    await mkdir(join(this.root, "_raw", pkg), { recursive: true });
    await writeFile(p, bytes);
  }

  async get(pkg: string, ver: string): Promise<Uint8Array | null> {
    try {
      const buf = await readFile(this.fullPath(pkg, ver));
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async list(): Promise<Array<{ pkg: string; ver: string }>> {
    const rawDir = join(this.root, "_raw");
    const results: Array<{ pkg: string; ver: string }> = [];
    let pkgEntries;
    try {
      pkgEntries = await readdir(rawDir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    for (const pkgEnt of pkgEntries) {
      if (!pkgEnt.isDirectory()) continue;
      const verEntries = await readdir(join(rawDir, pkgEnt.name), { withFileTypes: true });
      for (const verEnt of verEntries) {
        if (!verEnt.isFile() || !verEnt.name.endsWith(".papyri.gz")) continue;
        results.push({ pkg: pkgEnt.name, ver: verEnt.name.slice(0, -".papyri.gz".length) });
      }
    }
    results.sort((a, b) => a.pkg.localeCompare(b.pkg) || a.ver.localeCompare(b.ver));
    return results;
  }

  async clear(): Promise<number> {
    const entries = await this.list();
    await rm(join(this.root, "_raw"), { recursive: true, force: true });
    return entries.length;
  }
}

// ---------------------------------------------------------------------------
// Cloudflare R2
// ---------------------------------------------------------------------------

export class R2RawStore implements RawStore {
  constructor(private readonly bucket: R2BucketLike) {}

  async put(pkg: string, ver: string, bytes: Uint8Array): Promise<void> {
    await this.bucket.put(rawKey(pkg, ver), bytes);
  }

  async get(pkg: string, ver: string): Promise<Uint8Array | null> {
    const obj = await this.bucket.get(rawKey(pkg, ver));
    if (!obj) return null;
    return new Uint8Array(await obj.arrayBuffer());
  }

  async list(): Promise<Array<{ pkg: string; ver: string }>> {
    const out: Array<{ pkg: string; ver: string }> = [];
    let cursor: string | undefined;
    do {
      const r = await this.bucket.list({ prefix: "_raw/", cursor });
      for (const o of r.objects) {
        const parsed = parseRawKey(o.key);
        if (parsed) out.push(parsed);
      }
      cursor = r.truncated ? r.cursor : undefined;
    } while (cursor);
    out.sort((a, b) => a.pkg.localeCompare(b.pkg) || a.ver.localeCompare(b.ver));
    return out;
  }

  async clear(): Promise<number> {
    let count = 0;
    let cursor: string | undefined;
    do {
      const r = await this.bucket.list({ prefix: "_raw/", cursor });
      const keys = r.objects.map((o) => o.key);
      if (keys.length > 0) {
        await this.bucket.delete(keys);
        count += keys.length;
      }
      cursor = r.truncated ? r.cursor : undefined;
    } while (cursor);
    return count;
  }
}
