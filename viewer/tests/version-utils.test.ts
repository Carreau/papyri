import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsBlobStore } from "papyri-ingest";
import { equivalentLatestHref } from "../src/lib/version-utils.ts";

describe("equivalentLatestHref", () => {
  let dir: string;
  const pkg = "numpy";
  const latest = "2.0";

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "papyri-viewer-verutils-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("links to the same qualname when it exists in the latest version", async () => {
    await mkdir(join(dir, pkg, latest, "module"), { recursive: true });
    await writeFile(join(dir, pkg, latest, "module", "numpy.array"), "x");
    const store = new FsBlobStore(dir);
    expect(await equivalentLatestHref(store, pkg, latest, { qualname: "numpy.array" })).toBe(
      "/project/numpy/2.0/numpy.array/"
    );
  });

  it("matches a .cbor-suffixed module blob", async () => {
    await mkdir(join(dir, pkg, latest, "module"), { recursive: true });
    await writeFile(join(dir, pkg, latest, "module", "numpy.array.cbor"), "x");
    const store = new FsBlobStore(dir);
    expect(await equivalentLatestHref(store, pkg, latest, { qualname: "numpy.array" })).toBe(
      "/project/numpy/2.0/numpy.array/"
    );
  });

  it("returns null when the qualname was removed in the latest version", async () => {
    const store = new FsBlobStore(dir);
    expect(await equivalentLatestHref(store, pkg, latest, { qualname: "numpy.old_api" })).toBe(
      null
    );
  });

  it("links to the same doc page when it exists", async () => {
    await mkdir(join(dir, pkg, latest, "docs"), { recursive: true });
    await writeFile(join(dir, pkg, latest, "docs", "whatsnew:index"), "x");
    const store = new FsBlobStore(dir);
    expect(await equivalentLatestHref(store, pkg, latest, { docPath: "whatsnew:index" })).toBe(
      "/project/numpy/2.0/docs/whatsnew/index/"
    );
  });

  it("links to the same example page when it exists", async () => {
    await mkdir(join(dir, pkg, latest, "examples"), { recursive: true });
    await writeFile(join(dir, pkg, latest, "examples", "plot.py"), "x");
    const store = new FsBlobStore(dir);
    expect(await equivalentLatestHref(store, pkg, latest, { examplePath: "plot.py" })).toBe(
      "/project/numpy/2.0/examples/plot.py/"
    );
  });

  it("returns null with no active page (bundle index, search, …)", async () => {
    const store = new FsBlobStore(dir);
    expect(await equivalentLatestHref(store, pkg, latest, {})).toBe(null);
  });
});
