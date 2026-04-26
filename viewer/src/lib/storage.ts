// Storage abstraction for papyri bundle blobs.
//
// The current implementation (LocalFsStorage) reads and writes the local
// ingest directory. The interface is designed so an R2-backed implementation
// can be dropped in without touching the crosslink engine or the bundle
// endpoint.
//
// Key format convention: forward-slash–separated paths relative to the bundle
// root, e.g. "module/numpy.array", "docs/reference/index", "meta/toc.cbor".
// Implementations must NOT interpret the key as a URL or apply any escaping.

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

export interface StorageBackend {
  /** Fetch a blob by key. Returns null if the key does not exist. */
  get(key: string): Promise<Uint8Array | null>;
  /** Write a blob, creating any intermediate structure the backend requires. */
  put(key: string, data: Uint8Array): Promise<void>;
  /**
   * List all keys that begin with `prefix` (including the prefix itself in
   * each returned key). Results are sorted lexicographically. An absent or
   * empty prefix directory returns an empty array.
   */
  list(prefix: string): Promise<string[]>;
}

// ---------------------------------------------------------------------------
// Filesystem implementation
// ---------------------------------------------------------------------------

async function walkDir(dir: string, rootForRelative: string, out: string[]): Promise<void> {
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
      await walkDir(full, rootForRelative, out);
    } else if (e.isFile()) {
      out.push(relative(rootForRelative, full).split(sep).join("/"));
    }
  }
}

/**
 * StorageBackend backed by a local filesystem directory.
 *
 * `root` is the bundle root (e.g. `~/.papyri/ingest/numpy/2.3.5`). All
 * keys are resolved relative to it.
 */
export class LocalFsStorage implements StorageBackend {
  constructor(readonly root: string) {}

  async get(key: string): Promise<Uint8Array | null> {
    try {
      const buf = await readFile(join(this.root, key));
      // Return a plain Uint8Array view so callers don't observe Node Buffer internals.
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async put(key: string, data: Uint8Array): Promise<void> {
    const full = join(this.root, key);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, data);
  }

  async list(prefix: string): Promise<string[]> {
    const dir = join(this.root, prefix.replace(/\/$/, ""));
    const out: string[] = [];
    await walkDir(dir, this.root, out);
    out.sort();
    return out;
  }
}
