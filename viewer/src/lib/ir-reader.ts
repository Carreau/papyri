import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { dataDir } from "./paths.ts";

export interface BundleMeta {
  module?: string;
  version?: string;
  logo?: string;
  tag?: string;
  [key: string]: unknown;
}

export interface Bundle {
  /** Directory name on disk, e.g. "numpy_1.26.4". */
  dirName: string;
  /** Absolute path to the bundle directory. */
  path: string;
  /** Parsed papyri.json if present and readable, else null. */
  meta: BundleMeta | null;
}

// Only papyri.json is read per bundle for now — enough to populate the index.
// Deeper IR decoding (module/*.json, CBOR blobs) lands in M1.
export async function listBundles(root: string = dataDir()): Promise<Bundle[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  const bundles: Bundle[] = [];
  for (const name of dirs) {
    const path = join(root, name);
    const metaPath = join(path, "papyri.json");
    let meta: BundleMeta | null = null;
    try {
      await stat(metaPath);
      const raw = await readFile(metaPath, "utf8");
      meta = JSON.parse(raw) as BundleMeta;
    } catch {
      meta = null;
    }
    bundles.push({ dirName: name, path, meta });
  }
  return bundles;
}
