// Cloudflare R2 BundleStore. Keys are structured as:
//   ingest/<pkg>/<ver>/<file-path>
// Only imported in production (via middleware.ts when the R2 binding is present).
import type { BundleStore } from "./storage.ts";

// Structural interface matching the Cloudflare R2 Workers API.
interface R2ObjectBody {
  arrayBuffer(): Promise<ArrayBuffer>;
}
interface R2ListResult {
  objects: Array<{ key: string }>;
  truncated: boolean;
  cursor?: string;
  delimitedPrefixes: string[];
}
interface R2BucketLike {
  get(key: string): Promise<R2ObjectBody | null>;
  list(opts: {
    prefix?: string;
    delimiter?: string;
    cursor?: string;
  }): Promise<R2ListResult>;
}

export class R2Store implements BundleStore {
  constructor(private readonly bucket: R2BucketLike) {}

  private key(pkg: string, ver: string, file: string): string {
    return `ingest/${pkg}/${ver}/${file}`;
  }

  async readBytes(
    pkg: string,
    ver: string,
    key: string,
  ): Promise<Uint8Array | null> {
    try {
      const obj = await this.bucket.get(this.key(pkg, ver, key));
      if (!obj) return null;
      return new Uint8Array(await obj.arrayBuffer());
    } catch {
      return null;
    }
  }

  async listDir(
    pkg: string,
    ver: string,
    subdir: string,
  ): Promise<string[]> {
    const prefix = `ingest/${pkg}/${ver}/${subdir}/`;
    const keys: string[] = [];
    let cursor: string | undefined;
    do {
      const result = await this.bucket.list({
        prefix,
        ...(cursor ? { cursor } : {}),
      });
      for (const obj of result.objects) {
        keys.push(obj.key.slice(prefix.length));
      }
      cursor = result.truncated ? result.cursor : undefined;
    } while (cursor);
    keys.sort();
    return keys;
  }

  async listBundles(): Promise<Array<{ pkg: string; ver: string }>> {
    // Use R2's delimiter-based listing for efficiency: avoid enumerating
    // thousands of module blobs just to discover (pkg, ver) pairs.
    const ingestPrefix = "ingest/";
    const pkgResult = await this.bucket.list({
      prefix: ingestPrefix,
      delimiter: "/",
    });
    const bundles: Array<{ pkg: string; ver: string }> = [];
    for (const pkgPrefix of pkgResult.delimitedPrefixes) {
      let cursor: string | undefined;
      do {
        const verResult = await this.bucket.list({
          prefix: pkgPrefix,
          delimiter: "/",
          ...(cursor ? { cursor } : {}),
        });
        for (const verPrefix of verResult.delimitedPrefixes) {
          // verPrefix is "ingest/<pkg>/<ver>/"
          const parts = verPrefix.split("/");
          if (parts.length >= 4) {
            bundles.push({ pkg: parts[1]!, ver: parts[2]! });
          }
        }
        cursor = verResult.truncated ? verResult.cursor : undefined;
      } while (cursor);
    }
    bundles.sort((a, b) =>
      `${a.pkg}/${a.ver}`.localeCompare(`${b.pkg}/${b.ver}`),
    );
    return bundles;
  }
}
