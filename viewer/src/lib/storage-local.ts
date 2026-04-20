// Local filesystem BundleStore. Reads from ~/.papyri/ingest/ (or PAPYRI_INGEST_DIR).
// Imported only in dev (behind import.meta.env.DEV in middleware.ts) so it is
// tree-shaken out of the Cloudflare production bundle.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { BundleStore } from "./storage.ts";
import { ingestDir } from "./paths.ts";

export class LocalStore implements BundleStore {
  constructor(private readonly root: string = ingestDir()) {}

  async readBytes(
    pkg: string,
    ver: string,
    key: string,
  ): Promise<Uint8Array | null> {
    const path = join(this.root, pkg, ver, key);
    try {
      return new Uint8Array(await readFile(path));
    } catch {
      return null;
    }
  }

  async listDir(
    pkg: string,
    ver: string,
    subdir: string,
  ): Promise<string[]> {
    const base = join(this.root, pkg, ver, subdir);
    const out: string[] = [];
    async function walk(dir: string, rel: string): Promise<void> {
      let ents;
      try {
        ents = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of ents) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          await walk(join(dir, e.name), r);
        } else if (e.isFile()) {
          out.push(r);
        }
      }
    }
    await walk(base, "");
    out.sort();
    return out;
  }

  async listBundles(): Promise<Array<{ pkg: string; ver: string }>> {
    let pkgs;
    try {
      pkgs = await readdir(this.root, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: Array<{ pkg: string; ver: string }> = [];
    for (const p of pkgs) {
      if (!p.isDirectory()) continue;
      let vers;
      try {
        vers = await readdir(join(this.root, p.name), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const v of vers) {
        if (!v.isDirectory()) continue;
        out.push({ pkg: p.name, ver: v.name });
      }
    }
    out.sort((a, b) =>
      `${a.pkg}/${a.ver}`.localeCompare(`${b.pkg}/${b.ver}`),
    );
    return out;
  }
}
