import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { SqliteGraphDb, storeInventory } from "papyri-ingest";
import { resolveExternalRefs, refKey, type RefTuple } from "../src/lib/graph.ts";

function makeDb(path: string): InstanceType<typeof Database> {
  const db = new Database(path);
  db.exec(
    "CREATE TABLE external_projects(name TEXT PRIMARY KEY, base_url TEXT NOT NULL, version TEXT, fetched_at INTEGER);" +
      "CREATE TABLE external_objects(project TEXT NOT NULL REFERENCES external_projects(name) ON DELETE CASCADE, name TEXT NOT NULL, domain TEXT NOT NULL, role TEXT NOT NULL, uri TEXT NOT NULL, dispname TEXT, priority INTEGER, PRIMARY KEY (project, name, domain, role));"
  );
  return db;
}

describe("resolveExternalRefs", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "papyri-viewer-ext-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("matches a colon-form RefInfo.path against the dotted inventory name", async () => {
    const dbPath = join(dir, "papyri.db");
    makeDb(dbPath).close();
    const graphDb = new SqliteGraphDb(new Database(dbPath) as Parameters<typeof SqliteGraphDb>[0]);

    await storeInventory(graphDb, {
      name: "numpy",
      baseUrl: "https://numpy.org/doc/stable/",
      version: "1.26",
      objects: [
        {
          name: "numpy.linalg.inv",
          domain: "py",
          role: "function",
          priority: 1,
          uri: "reference/generated/numpy.linalg.inv.html#numpy.linalg.inv",
          dispname: "numpy.linalg.inv",
        },
      ],
    });

    // gen emits RefInfo.path in full-qual colon form.
    const ref: RefTuple = { pkg: "numpy", ver: "*", kind: "api", path: "numpy.linalg:inv" };
    const out = await resolveExternalRefs(graphDb, [ref]);
    expect(out.get(refKey(ref))).toBe(
      "https://numpy.org/doc/stable/reference/generated/numpy.linalg.inv.html#numpy.linalg.inv"
    );
  });

  it("prefers the py domain and indexed priority; returns nothing for a miss", async () => {
    const dbPath = join(dir, "papyri.db");
    makeDb(dbPath).close();
    const graphDb = new SqliteGraphDb(new Database(dbPath) as Parameters<typeof SqliteGraphDb>[0]);

    await storeInventory(graphDb, {
      name: "python",
      baseUrl: "https://docs.python.org/3/",
      version: "3.13",
      objects: [
        { name: "open", domain: "std", role: "label", priority: -1, uri: "x.html", dispname: "x" },
        {
          name: "open",
          domain: "py",
          role: "function",
          priority: 1,
          uri: "library/functions.html#open",
          dispname: "open",
        },
      ],
    });

    const hit: RefTuple = { pkg: "python", ver: "*", kind: "api", path: "open" };
    const miss: RefTuple = { pkg: "python", ver: "*", kind: "api", path: "nope" };
    const out = await resolveExternalRefs(graphDb, [hit, miss]);
    expect(out.get(refKey(hit))).toBe("https://docs.python.org/3/library/functions.html#open");
    expect(out.has(refKey(miss))).toBe(false);
  });
});
