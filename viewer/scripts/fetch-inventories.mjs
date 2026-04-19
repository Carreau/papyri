#!/usr/bin/env node
// Download `objects.inv` for every project in the vendored intersphinx
// registry into the local inventory cache. Idempotent; running again
// overwrites existing files.
//
// Usage:
//   node scripts/fetch-inventories.mjs            # ~/.papyri/inventories/
//   PAPYRI_INVENTORY_DIR=/tmp/inv node scripts/fetch-inventories.mjs
//
// Network failures on individual inventories are logged and skipped; we
// don't want one flaky CDN to fail the whole sync.
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const registryPath = join(here, "..", "src", "data", "intersphinx-registry.json");
const registry = JSON.parse(
  await (await import("node:fs/promises")).readFile(registryPath, "utf8"),
);
const projects = registry.projects ?? {};

const outDir =
  process.env.PAPYRI_INVENTORY_DIR ?? join(homedir(), ".papyri", "inventories");
await mkdir(outDir, { recursive: true });

const entries = Object.entries(projects);
console.log(`fetching ${entries.length} inventories into ${outDir}`);

let ok = 0;
let fail = 0;
for (const [project, { url }] of entries) {
  const base = url.endsWith("/") ? url : url + "/";
  const invUrl = base + "objects.inv";
  try {
    const res = await fetch(invUrl, { redirect: "follow" });
    if (!res.ok) {
      console.warn(`  ${project}: HTTP ${res.status} from ${invUrl}`);
      fail += 1;
      continue;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    await writeFile(join(outDir, `${project}.inv`), buf);
    console.log(`  ${project}: ${buf.length} bytes`);
    ok += 1;
  } catch (err) {
    console.warn(`  ${project}: ${err.message ?? err}`);
    fail += 1;
  }
}

console.log(`done: ${ok} ok, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
