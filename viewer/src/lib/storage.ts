// Storage abstraction: isolates all bundle I/O behind a single interface so
// the rest of the viewer is platform-agnostic (local filesystem vs Cloudflare R2).
//
// Singleton is initialised once from middleware.ts based on whether a Cloudflare
// R2 binding is present. Callers always use `getStore()`.

export interface BundleStore {
  /** Read raw bytes for a file inside a bundle. Null if not found. */
  readBytes(pkg: string, ver: string, key: string): Promise<Uint8Array | null>;
  /** List all file paths under `subdir` within a bundle, recursively.
   *  Paths are relative to the subdir (e.g., "numpy.linspace", "fig-1.png"). */
  listDir(pkg: string, ver: string, subdir: string): Promise<string[]>;
  /** List all ingested (pkg, ver) pairs. */
  listBundles(): Promise<Array<{ pkg: string; ver: string }>>;
}

let _store: BundleStore | undefined;

export function getStore(): BundleStore {
  if (!_store) {
    throw new Error(
      "BundleStore not initialised — middleware must call initStore() before any request handler runs",
    );
  }
  return _store;
}

export function initStore(store: BundleStore): void {
  _store = store;
}
