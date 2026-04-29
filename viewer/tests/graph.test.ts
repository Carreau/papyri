import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { SqliteGraphDb } from "papyri-ingest";
import { resolveRef, getBackrefs } from "../src/lib/graph.ts";

function seedDb(path: string) {
  const db = new Database(path);
  db.exec(
    "CREATE TABLE nodes(id INTEGER PRIMARY KEY, package TEXT, version TEXT, category TEXT, identifier TEXT, has_blob INTEGER NOT NULL DEFAULT 0, UNIQUE(package,version,category,identifier));" +
      "CREATE TABLE links(source INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE, dest INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE, PRIMARY KEY (source, dest));"
  );
  const ins = db.prepare(
    "INSERT INTO nodes(package,version,category,identifier,has_blob) VALUES (?,?,?,?,?)"
  );
  ins.run("numpy", "1.0.0", "module", "numpy.fft:fft", 1);
  ins.run("numpy", "2.0.0", "module", "numpy.fft:fft", 1);
  const caller = ins.run("numpy", "2.0.0", "module", "numpy:example", 1).lastInsertRowid as number;
  const dest = (
    db
      .prepare("SELECT id FROM nodes WHERE package=? AND version=? AND category=? AND identifier=?")
      .get("numpy", "2.0.0", "module", "numpy.fft:fft") as { id: number }
  ).id;
  db.prepare("INSERT INTO links(source,dest) VALUES (?,?)").run(caller, dest);
  db.close();
}

describe("graph.ts", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "papyri-viewer-graph-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("resolveRef: exact hit, pkg-only fallback (lex-max version), no match", async () => {
    const dbPath = join(dir, "papyri.db");
    seedDb(dbPath);
    const graphDb = new SqliteGraphDb(new Database(dbPath) as Parameters<typeof SqliteGraphDb>[0]);

    expect(
      await resolveRef(graphDb, {
        pkg: "numpy",
        ver: "1.0.0",
        kind: "module",
        path: "numpy.fft:fft",
      })
    ).toEqual({ pkg: "numpy", ver: "1.0.0", kind: "module", path: "numpy.fft:fft" });
    expect(
      (
        await resolveRef(graphDb, {
          pkg: "numpy",
          ver: "9.9.9",
          kind: "module",
          path: "numpy.fft:fft",
        })
      )?.ver
    ).toBe("2.0.0");
    expect(
      await resolveRef(graphDb, { pkg: "scipy", ver: "1.0.0", kind: "module", path: "x" })
    ).toBeNull();
  });

  it("getBackrefs: lists callers of a destination, [] with no incoming edges", async () => {
    const dbPath = join(dir, "papyri.db");
    seedDb(dbPath);
    const graphDb = new SqliteGraphDb(new Database(dbPath) as Parameters<typeof SqliteGraphDb>[0]);

    expect(
      await getBackrefs(graphDb, {
        pkg: "numpy",
        ver: "2.0.0",
        kind: "module",
        path: "numpy.fft:fft",
      })
    ).toEqual([{ pkg: "numpy", ver: "2.0.0", kind: "module", path: "numpy:example" }]);
    expect(
      await getBackrefs(graphDb, {
        pkg: "numpy",
        ver: "1.0.0",
        kind: "module",
        path: "numpy.fft:fft",
      })
    ).toEqual([]);
  });
});
