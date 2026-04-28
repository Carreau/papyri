/**
 * BlobStore — async key→bytes store used by the Ingester.
 *
 * Two implementations share the same on-disk / R2 layout, keyed by
 * `<module>/<version>/<kind>/<path>` so a key like
 * `numpy/2.3.5/module/numpy.linspace` round-trips unchanged between Node-fs
 * and Cloudflare R2:
 *
 *   FsBlobStore  — Node filesystem rooted at a directory.
 *   R2BlobStore  — Cloudflare R2 bucket binding (Workers runtime).
 *
 * Per-bundle metadata (`meta.cbor`) lives at `<module>/<version>/meta.cbor`
 * — outside the (kind,path) addressing scheme, which is why it needs its
 * own helper.
 */
import { mkdir, writeFile, readFile, stat, readdir } from "node:fs/promises";
import { join, dirname, sep } from "node:path";
import type { Key } from "./graphstore.js";

/** Flat path used as both fs path-suffix and R2 object key. */
export function keyToPath(key: Key): string {
  return `${key.module}/${key.version}/${key.kind}/${key.path}`;
}

export interface BlobStore {
  put(key: Key, bytes: Uint8Array): Promise<void>;
  get(key: Key): Promise<Uint8Array | null>;
  has(key: Key): Promise<boolean>;
  /**
   * List every key under *prefix*, recursive (matching R2's default
   * semantics — fs walks recursively to match). Returned strings are full
   * keys including the prefix; sorted lexicographically. Empty array if
   * the prefix is absent.
   *
   * Both backends paginate internally so callers see a single materialised
   * list. Use coarse prefixes (`<pkg>/<ver>/`) to keep page counts bounded.
   */
  list(prefix: string): Promise<string[]>;
  /** Per-bundle meta.cbor (outside the {kind,path} address space). */
  putMeta(module: string, version: string, bytes: Uint8Array): Promise<void>;
  /** Read per-bundle meta.cbor. Null if absent. */
  getMeta(module: string, version: string): Promise<Uint8Array | null>;
}

// ---------------------------------------------------------------------------
// Node filesystem
// ---------------------------------------------------------------------------

export class FsBlobStore implements BlobStore {
  constructor(private readonly root: string) {}

  private fullPath(key: Key): string {
    return join(this.root, key.module, key.version, key.kind, key.path);
  }

  async put(key: Key, bytes: Uint8Array): Promise<void> {
    const p = this.fullPath(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, bytes);
  }

  async get(key: Key): Promise<Uint8Array | null> {
    try {
      const buf = await readFile(this.fullPath(key));
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async has(key: Key): Promise<boolean> {
    try {
      await stat(this.fullPath(key));
      return true;
    } catch {
      return false;
    }
  }

  async putMeta(module: string, version: string, bytes: Uint8Array): Promise<void> {
    const p = join(this.root, module, version, "meta.cbor");
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, bytes);
  }

  async getMeta(module: string, version: string): Promise<Uint8Array | null> {
    try {
      const buf = await readFile(join(this.root, module, version, "meta.cbor"));
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async list(prefix: string): Promise<string[]> {
    const startDir = join(this.root, prefix);
    const out: string[] = [];
    async function walk(dir: string): Promise<void> {
      let ents;
      try {
        ents = await readdir(dir, { withFileTypes: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
        throw err;
      }
      for (const e of ents) {
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          await walk(full);
        } else if (e.isFile()) {
          out.push(full);
        }
      }
    }
    await walk(startDir);
    // Convert absolute paths back to root-relative keys (POSIX-style).
    const rootSlash = this.root.endsWith(sep) ? this.root : this.root + sep;
    const rels = out.map((p) => p.slice(rootSlash.length).split(sep).join("/"));
    rels.sort();
    return rels;
  }
}

// ---------------------------------------------------------------------------
// Cloudflare R2
//
// Typed against a minimal structural shape so the Node build doesn't need to
// pull in `@cloudflare/workers-types`. The viewer's Workers build supplies
// the real R2Bucket binding; the structural type matches what we actually
// call.
// ---------------------------------------------------------------------------

export interface R2ObjectLike {
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface R2ListResult {
  objects: { key: string }[];
  truncated: boolean;
  cursor?: string;
}

export interface R2BucketLike {
  put(key: string, value: ArrayBuffer | ArrayBufferView | Uint8Array): Promise<unknown>;
  get(key: string): Promise<R2ObjectLike | null>;
  head(key: string): Promise<unknown | null>;
  list(opts?: { prefix?: string; cursor?: string; limit?: number }): Promise<R2ListResult>;
}

export class R2BlobStore implements BlobStore {
  constructor(private readonly bucket: R2BucketLike) {}

  async put(key: Key, bytes: Uint8Array): Promise<void> {
    await this.bucket.put(keyToPath(key), bytes);
  }

  async get(key: Key): Promise<Uint8Array | null> {
    const obj = await this.bucket.get(keyToPath(key));
    if (!obj) return null;
    return new Uint8Array(await obj.arrayBuffer());
  }

  async has(key: Key): Promise<boolean> {
    return (await this.bucket.head(keyToPath(key))) !== null;
  }

  async putMeta(module: string, version: string, bytes: Uint8Array): Promise<void> {
    await this.bucket.put(`${module}/${version}/meta.cbor`, bytes);
  }

  async getMeta(module: string, version: string): Promise<Uint8Array | null> {
    const obj = await this.bucket.get(`${module}/${version}/meta.cbor`);
    if (!obj) return null;
    return new Uint8Array(await obj.arrayBuffer());
  }

  async list(prefix: string): Promise<string[]> {
    // R2 list paginates at 1000 keys/page. Follow the cursor until
    // `truncated === false` so callers see one materialised array.
    const out: string[] = [];
    let cursor: string | undefined;
    do {
      const r: R2ListResult = await this.bucket.list({ prefix, cursor });
      for (const o of r.objects) out.push(o.key);
      cursor = r.truncated ? r.cursor : undefined;
    } while (cursor);
    out.sort();
    return out;
  }
}
