import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { SqliteGraphDb, registerProject, storeInventory, unloadProject } from "papyri-ingest";
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

  it("resolves a stdlib ref against a single python inventory regardless of module", async () => {
    // gen emits RefInfo.module = the object's real top-level module
    // (`collections`, `pathlib`, …), but the whole stdlib ships as one
    // inventory registered here under `python`. Name-based lookup bridges that.
    const dbPath = join(dir, "papyri.db");
    makeDb(dbPath).close();
    const graphDb = new SqliteGraphDb(new Database(dbPath) as Parameters<typeof SqliteGraphDb>[0]);

    await storeInventory(graphDb, {
      name: "python",
      baseUrl: "https://docs.python.org/3/",
      version: "3.13",
      objects: [
        {
          name: "collections.abc.Mapping",
          domain: "py",
          role: "class",
          priority: 1,
          uri: "library/collections.abc.html#collections.abc.Mapping",
          dispname: "collections.abc.Mapping",
        },
      ],
    });

    const ref: RefTuple = {
      pkg: "collections", // ≠ "python", yet must still resolve
      ver: "*",
      kind: "api",
      path: "collections.abc:Mapping",
    };
    const out = await resolveExternalRefs(graphDb, [ref]);
    expect(out.get(refKey(ref))).toBe(
      "https://docs.python.org/3/library/collections.abc.html#collections.abc.Mapping"
    );
  });

  it("prefers the inventory whose project matches the ref's top-level module", async () => {
    const dbPath = join(dir, "papyri.db");
    makeDb(dbPath).close();
    const graphDb = new SqliteGraphDb(new Database(dbPath) as Parameters<typeof SqliteGraphDb>[0]);

    // Same fully-qualified name registered in two unrelated inventories.
    for (const [proj, base] of [
      ["numpy", "https://numpy.org/doc/stable/"],
      ["other", "https://example.com/"],
    ] as const) {
      await storeInventory(graphDb, {
        name: proj,
        baseUrl: base,
        version: "1",
        objects: [
          {
            name: "thing.Widget",
            domain: "py",
            role: "class",
            priority: 1,
            uri: "thing.html#thing.Widget",
            dispname: "thing.Widget",
          },
        ],
      });
    }

    const ref: RefTuple = { pkg: "numpy", ver: "*", kind: "api", path: "thing:Widget" };
    const out = await resolveExternalRefs(graphDb, [ref]);
    // The `numpy` inventory wins because its project name matches ref.pkg.
    expect(out.get(refKey(ref))).toBe("https://numpy.org/doc/stable/thing.html#thing.Widget");
  });

  it("registers a project without fetching, then preserves it on re-register", async () => {
    const dbPath = join(dir, "papyri.db");
    makeDb(dbPath).close();
    const graphDb = new SqliteGraphDb(new Database(dbPath) as Parameters<typeof SqliteGraphDb>[0]);

    // Stage a pair — no objects fetched.
    await registerProject(graphDb, { name: "numpy", baseUrl: "https://numpy.org/doc/stable/" });
    let proj = await graphDb.get<{ base_url: string; fetched_at: number | null }>(
      "SELECT base_url, fetched_at FROM external_projects WHERE name=?",
      ["numpy"]
    );
    expect(proj?.base_url).toBe("https://numpy.org/doc/stable/");
    expect(proj?.fetched_at).toBeNull();
    let objs = await graphDb.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM external_objects WHERE project=?",
      ["numpy"]
    );
    expect(objs?.n).toBe(0);

    // Load it.
    await storeInventory(graphDb, {
      name: "numpy",
      baseUrl: "https://numpy.org/doc/stable/",
      version: "1.26",
      objects: [
        {
          name: "numpy.linspace",
          domain: "py",
          role: "function",
          priority: 1,
          uri: "x.html#numpy.linspace",
          dispname: "numpy.linspace",
        },
      ],
    });

    // Re-register with a new URL: updates base_url, keeps the loaded objects.
    await registerProject(graphDb, { name: "numpy", baseUrl: "https://example.com/np/" });
    proj = await graphDb.get<{ base_url: string }>(
      "SELECT base_url FROM external_projects WHERE name=?",
      ["numpy"]
    );
    expect(proj?.base_url).toBe("https://example.com/np/");
    objs = await graphDb.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM external_objects WHERE project=?",
      ["numpy"]
    );
    expect(objs?.n).toBe(1);
  });

  it("unloads objects but keeps the project row for re-load", async () => {
    const dbPath = join(dir, "papyri.db");
    makeDb(dbPath).close();
    const graphDb = new SqliteGraphDb(new Database(dbPath) as Parameters<typeof SqliteGraphDb>[0]);

    await storeInventory(graphDb, {
      name: "numpy",
      baseUrl: "https://numpy.org/doc/stable/",
      version: "1.26",
      objects: [
        {
          name: "numpy.linspace",
          domain: "py",
          role: "function",
          priority: 1,
          uri: "x.html#numpy.linspace",
          dispname: "numpy.linspace",
        },
      ],
    });

    await unloadProject(graphDb, { name: "numpy" });

    // Objects gone, ref no longer resolves.
    const objs = await graphDb.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM external_objects WHERE project=?",
      ["numpy"]
    );
    expect(objs?.n).toBe(0);
    const ref: RefTuple = { pkg: "numpy", ver: "*", kind: "api", path: "numpy:linspace" };
    expect((await resolveExternalRefs(graphDb, [ref])).has(refKey(ref))).toBe(false);

    // Project row kept (with base URL) but reset to unloaded.
    const proj = await graphDb.get<{
      base_url: string;
      version: string | null;
      fetched_at: number | null;
    }>("SELECT base_url, version, fetched_at FROM external_projects WHERE name=?", ["numpy"]);
    expect(proj?.base_url).toBe("https://numpy.org/doc/stable/");
    expect(proj?.version).toBeNull();
    expect(proj?.fetched_at).toBeNull();
  });

  it("drops a project and all its objects (no cascade reliance)", async () => {
    const dbPath = join(dir, "papyri.db");
    makeDb(dbPath).close();
    const graphDb = new SqliteGraphDb(new Database(dbPath) as Parameters<typeof SqliteGraphDb>[0]);

    await storeInventory(graphDb, {
      name: "numpy",
      baseUrl: "https://numpy.org/doc/stable/",
      version: "1.26",
      objects: [
        {
          name: "numpy.linspace",
          domain: "py",
          role: "function",
          priority: 1,
          uri: "x.html#numpy.linspace",
          dispname: "numpy.linspace",
        },
      ],
    });

    // Mirror the DELETE /api/inventory handler: explicit two-step delete.
    await graphDb.batch([
      { sql: "DELETE FROM external_objects WHERE project=?", params: ["numpy"] },
      { sql: "DELETE FROM external_projects WHERE name=?", params: ["numpy"] },
    ]);

    const proj = await graphDb.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM external_projects WHERE name=?",
      ["numpy"]
    );
    const objs = await graphDb.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM external_objects WHERE project=?",
      ["numpy"]
    );
    expect(proj?.n).toBe(0);
    expect(objs?.n).toBe(0);

    const ref: RefTuple = { pkg: "numpy", ver: "*", kind: "api", path: "numpy:linspace" };
    expect((await resolveExternalRefs(graphDb, [ref])).has(refKey(ref))).toBe(false);
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
