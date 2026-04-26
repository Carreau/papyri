import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { encode as cborEncode } from "cbor-x";
import Database from "better-sqlite3";
import { crosslinkBundle, openCrosslinkDb } from "../src/lib/crosslink.ts";
import { LocalFsStorage } from "../src/lib/storage.ts";

// ---------------------------------------------------------------------------
// Helpers to build minimal CBOR blobs that mimic the papyri IR structure.
// cbor-x encodes plain objects as CBOR maps; tagged objects need cbor-x's
// Tag class. We side-step all of that by building the encoded form directly
// using the same Encoder that the viewer's decoder expects.
//
// The simplest approach: write a CBOR map (plain object) whose "refs" field
// is a list of objects with __type="RefInfo". The decoder turns tagged values
// into typed nodes, but collectRefs also handles plain objects — so for test
// purposes we can skip the CBOR tags entirely and just embed plain
// {__type:"RefInfo", ...} maps.
// ---------------------------------------------------------------------------

function makeDocCbor(refs: Array<{ module: string; version: string; kind: string; path: string }>): Buffer {
  // Encode a minimal document: a plain CBOR map with a "refs" array.
  // collectRefs does a depth-first walk, so nesting here is fine.
  const doc = {
    __type: "IngestedDoc",
    refs: refs.map((r) => ({ __type: "RefInfo", ...r })),
  };
  return Buffer.from(cborEncode(doc));
}

// ---------------------------------------------------------------------------

let tmpRoot: string;
let bundleDir: string;
let dbPath: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "papyri-xlink-test-"));
  bundleDir = join(tmpRoot, "bundle");
  dbPath = join(tmpRoot, "papyri.db");
  await mkdir(join(bundleDir, "module"), { recursive: true });
  await mkdir(join(bundleDir, "docs"), { recursive: true });
  await mkdir(join(bundleDir, "examples"), { recursive: true });
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("crosslinkBundle", () => {
  it("inserts nodes and links for module files", async () => {
    const blob = makeDocCbor([{ module: "numpy", version: "2.3.5", kind: "module", path: "numpy.array" }]);
    await writeFile(join(bundleDir, "module", "mymod.func"), blob);

    const db = openCrosslinkDb(dbPath);
    const stats = await crosslinkBundle(new LocalFsStorage(bundleDir), "mypkg", "1.0.0", db);
    db.close();

    expect(stats.blobs).toBe(1);
    expect(stats.links).toBe(1);

    const db2 = new Database(dbPath, { readonly: true });
    const srcNode = db2
      .prepare("SELECT * FROM nodes WHERE package=? AND version=? AND category=? AND identifier=?")
      .get("mypkg", "1.0.0", "module", "mymod.func") as { has_blob: number } | undefined;
    expect(srcNode).toBeDefined();
    expect(srcNode!.has_blob).toBe(1);

    const destNode = db2
      .prepare("SELECT * FROM nodes WHERE package=? AND version=? AND category=? AND identifier=?")
      .get("numpy", "2.3.5", "module", "numpy.array") as { has_blob: number } | undefined;
    expect(destNode).toBeDefined();
    expect(destNode!.has_blob).toBe(0); // placeholder

    const linkCount = (
      db2.prepare("SELECT COUNT(*) AS c FROM links").get() as { c: number }
    ).c;
    expect(linkCount).toBe(1);
    db2.close();
  });

  it("processes docs and examples directories", async () => {
    await writeFile(join(bundleDir, "docs", "guide"), makeDocCbor([]));
    await writeFile(join(bundleDir, "examples", "plot.py"), makeDocCbor([]));

    const db = openCrosslinkDb(dbPath);
    const stats = await crosslinkBundle(new LocalFsStorage(bundleDir), "pkg", "0.1.0", db);
    db.close();

    expect(stats.blobs).toBe(2);

    const db2 = new Database(dbPath, { readonly: true });
    const rows = db2.prepare("SELECT category, identifier FROM nodes WHERE has_blob=1").all() as Array<{
      category: string;
      identifier: string;
    }>;
    expect(rows).toContainEqual({ category: "docs", identifier: "guide" });
    expect(rows).toContainEqual({ category: "examples", identifier: "plot.py" });
    db2.close();
  });

  it("strips .cbor extension from identifiers", async () => {
    await writeFile(join(bundleDir, "module", "pkg.Cls.cbor"), makeDocCbor([]));

    const db = openCrosslinkDb(dbPath);
    await crosslinkBundle(new LocalFsStorage(bundleDir), "pkg", "1.0", db);
    db.close();

    const db2 = new Database(dbPath, { readonly: true });
    const row = db2
      .prepare("SELECT identifier FROM nodes WHERE identifier=?")
      .get("pkg.Cls") as { identifier: string } | undefined;
    expect(row?.identifier).toBe("pkg.Cls");
    db2.close();
  });

  it("ignores RefInfo with kind='local'", async () => {
    const blob = makeDocCbor([{ module: "mypkg", version: "1.0", kind: "local", path: "anchor" }]);
    await writeFile(join(bundleDir, "module", "page"), blob);

    const db = openCrosslinkDb(dbPath);
    const stats = await crosslinkBundle(new LocalFsStorage(bundleDir), "mypkg", "1.0", db);
    db.close();

    expect(stats.links).toBe(0); // local refs must not become graph edges

    const db2 = new Database(dbPath, { readonly: true });
    const linkCount = (db2.prepare("SELECT COUNT(*) AS c FROM links").get() as { c: number }).c;
    expect(linkCount).toBe(0);
    db2.close();
  });

  it("replaces existing links on re-upload", async () => {
    const blob1 = makeDocCbor([{ module: "a", version: "1", kind: "module", path: "a.X" }]);
    const blob2 = makeDocCbor([{ module: "b", version: "1", kind: "module", path: "b.Y" }]);
    await writeFile(join(bundleDir, "module", "page"), blob1);

    const db = openCrosslinkDb(dbPath);
    await crosslinkBundle(new LocalFsStorage(bundleDir), "pkg", "1.0", db);

    // Re-upload the same file with a different ref.
    await writeFile(join(bundleDir, "module", "page"), blob2);
    const stats = await crosslinkBundle(new LocalFsStorage(bundleDir), "pkg", "1.0", db);
    db.close();

    expect(stats.links).toBe(1);

    const db2 = new Database(dbPath, { readonly: true });
    const linkCount = (db2.prepare("SELECT COUNT(*) AS c FROM links").get() as { c: number }).c;
    // Only one link after the second ingest; old link was replaced.
    expect(linkCount).toBe(1);
    db2.close();
  });

  it("returns zero stats for an empty bundle", async () => {
    const db = openCrosslinkDb(dbPath);
    const stats = await crosslinkBundle(new LocalFsStorage(bundleDir), "empty", "0.0.1", db);
    db.close();
    expect(stats.blobs).toBe(0);
    expect(stats.links).toBe(0);
  });
});

describe("LocalFsStorage", () => {
  it("put and get round-trip", async () => {
    const store = new LocalFsStorage(tmpRoot);
    const data = new Uint8Array([1, 2, 3]);
    await store.put("sub/file.bin", data);
    const got = await store.get("sub/file.bin");
    expect(got).toEqual(data);
  });

  it("get returns null for missing key", async () => {
    const store = new LocalFsStorage(tmpRoot);
    expect(await store.get("nonexistent")).toBeNull();
  });

  it("list returns keys under prefix", async () => {
    const store = new LocalFsStorage(tmpRoot);
    await store.put("module/a", new Uint8Array([0]));
    await store.put("module/b", new Uint8Array([0]));
    await store.put("docs/c", new Uint8Array([0]));

    const moduleKeys = await store.list("module/");
    expect(moduleKeys).toEqual(["module/a", "module/b"]);
  });

  it("list returns empty array for absent prefix", async () => {
    const store = new LocalFsStorage(tmpRoot);
    expect(await store.list("nonexistent/")).toEqual([]);
  });
});
