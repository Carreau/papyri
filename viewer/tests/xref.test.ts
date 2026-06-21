import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { SqliteGraphDb } from "papyri-ingest";
import { buildXrefResolver } from "../src/lib/xref.ts";

function seedDb(path: string) {
  const db = new Database(path);
  db.exec(
    "CREATE TABLE nodes(id INTEGER PRIMARY KEY, package TEXT, version TEXT, category TEXT, identifier TEXT, has_blob INTEGER NOT NULL DEFAULT 0, UNIQUE(package,version,category,identifier));" +
      "CREATE TABLE links(source INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE, dest INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE, PRIMARY KEY (source, dest));"
  );
  const ins = db.prepare(
    "INSERT INTO nodes(package,version,category,identifier,has_blob) VALUES (?,?,?,?,?)"
  );
  // A narrative doc page that exists in the bundle.
  ins.run("scipy", "1.0.0", "docs", "optimize:root", 1);
  // An API page that exists in the bundle.
  ins.run("scipy", "1.0.0", "module", "scipy.optimize:root", 1);
  db.close();
}

function localRefDoc(kind: string, path: string, value: string) {
  return {
    __type: "CrossRef",
    value,
    kind: "exists",
    reference: { __type: "LocalRef", kind, path },
  };
}

describe("buildXrefResolver — LocalRef verification", () => {
  let dir: string;
  let graphDb: SqliteGraphDb;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "papyri-viewer-xref-"));
    const dbPath = join(dir, "papyri.db");
    seedDb(dbPath);
    graphDb = new SqliteGraphDb(new Database(dbPath) as Parameters<typeof SqliteGraphDb>[0]);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("links a LocalRef whose target has a blob", async () => {
    const node = localRefDoc("docs", "optimize:root", "root");
    const resolve = await buildXrefResolver(graphDb, node, "scipy", "1.0.0");
    expect(resolve(node)).toEqual({
      url: "/project/scipy/1.0.0/docs/optimize/root/",
      label: "root",
    });
  });

  it("does NOT link a LocalRef whose doc target is missing (was a 404)", async () => {
    // e.g. `:doc:`optimize.root-hybr`` — gen emits LocalRef('docs', …) without
    // verifying the target exists; no such page was ingested.
    const node = localRefDoc("docs", "optimize.root-hybr", "optimize.root-hybr");
    const resolve = await buildXrefResolver(graphDb, node, "scipy", "1.0.0");
    expect(resolve(node)).toBeNull();
  });

  it("does NOT link a LocalRef whose module target is missing", async () => {
    const node = localRefDoc("module", "scipy.optimize:nonexistent", "nonexistent");
    const resolve = await buildXrefResolver(graphDb, node, "scipy", "1.0.0");
    expect(resolve(node)).toBeNull();
  });

  it("links a LocalRef module target that has a blob", async () => {
    const node = localRefDoc("module", "scipy.optimize:root", "root");
    const resolve = await buildXrefResolver(graphDb, node, "scipy", "1.0.0");
    expect(resolve(node)).toEqual({
      url: "/project/scipy/1.0.0/scipy.optimize$root/",
      label: "root",
    });
  });
});
