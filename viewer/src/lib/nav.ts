import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { Decoder } from "cbor-x";

// ---------------------------------------------------------------------------
// Per-bundle view-model. Pages under [pkg]/[ver]/** call `loadBundleNav` to
// get everything the sidebar + bundle identity block need in one shot. Read
// lives here so `ir-reader.ts` stays focused on on-disk decoding primitives.
//
// §0 of viewer/TODO.md makes the ingest store the single source of truth:
// `meta.cbor` carries `{module, version, logo, summary, ...}` and the logo
// file itself is copied into `<bundle>/meta/logo.<ext>`. Older bundles that
// predate the logo copy step still have the logo in `assets/`; we fall back
// there so the viewer works against a mixed ingest.
// ---------------------------------------------------------------------------

export interface BundleMeta {
  module?: string;
  version?: string;
  /** Basename under `meta/` (newer ingest) or `assets/` (older). */
  logo?: string;
  /** Plain-text first paragraph of the module summary. */
  summary?: string;
  homepage?: string;
  docspage?: string;
  pypi?: string;
  github_slug?: string;
  tag?: string;
  [key: string]: unknown;
}

export interface BundleNav {
  pkg: string;
  version: string;
  bundlePath: string;
  meta: BundleMeta;
  /** `data:` URI if we found the logo on disk, else null. */
  logoDataUrl: string | null;
}

async function readMetaCbor(bundlePath: string): Promise<BundleMeta> {
  try {
    const raw = await readFile(join(bundlePath, "meta.cbor"));
    const dec = new Decoder({ mapsAsObjects: true });
    const decoded = dec.decode(raw);
    if (decoded && typeof decoded === "object") {
      return decoded as BundleMeta;
    }
  } catch {
    // Bundles without meta.cbor get an empty view-model; the sidebar still
    // renders using pkg/version from the URL.
  }
  return {};
}

const LOGO_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

async function logoDataUrl(
  bundlePath: string,
  logoName: string | undefined,
): Promise<string | null> {
  // `meta/logo.*` is what `Ingester._ingest_logo` writes; older ingests
  // didn't do that, so fall back to whatever basename meta.cbor points at
  // under `assets/`.
  const candidates: string[] = [];
  try {
    const metaEntries = await readdir(join(bundlePath, "meta"));
    for (const e of metaEntries) {
      if (e.startsWith("logo.")) candidates.push(join(bundlePath, "meta", e));
    }
  } catch {
    // No meta dir — fine.
  }
  if (logoName) {
    candidates.push(join(bundlePath, "assets", logoName));
  }
  for (const path of candidates) {
    try {
      const buf = await readFile(path);
      const ext = extname(path).toLowerCase();
      const mime = LOGO_MIME[ext] ?? "application/octet-stream";
      return `data:${mime};base64,${buf.toString("base64")}`;
    } catch {
      // Try the next one.
    }
  }
  return null;
}

export async function loadBundleNav(
  pkg: string,
  version: string,
  bundlePath: string,
): Promise<BundleNav> {
  const meta = await readMetaCbor(bundlePath);
  const url = await logoDataUrl(bundlePath, meta.logo);
  return {
    pkg,
    version,
    bundlePath,
    meta,
    logoDataUrl: url,
  };
}
