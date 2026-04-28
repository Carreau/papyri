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
import { mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { Key } from "./graphstore.js";

/** Flat path used as both fs path-suffix and R2 object key. */
export function keyToPath(key: Key): string {
  return `${key.module}/${key.version}/${key.kind}/${key.path}`;
}

export interface BlobStore {
  put(key: Key, bytes: Uint8Array): Promise<void>;
  get(key: Key): Promise<Uint8Array | null>;
  has(key: Key): Promise<boolean>;
  /** Per-bundle meta.cbor (outside the {kind,path} address space). */
  putMeta(module: string, version: string, bytes: Uint8Array): Promise<void>;
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

export interface R2BucketLike {
  put(key: string, value: ArrayBuffer | ArrayBufferView | Uint8Array): Promise<unknown>;
  get(key: string): Promise<R2ObjectLike | null>;
  head(key: string): Promise<unknown | null>;
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
}
