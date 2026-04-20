import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStore } from "../src/lib/storage-local.ts";
import { initStore } from "../src/lib/storage.ts";
import { LocalGraph } from "../src/lib/graph-local.ts";
import { initGraph } from "../src/lib/graph.ts";
import { listIngestedBundles, listModules } from "../src/lib/ir-reader.ts";

describe("fs-facing helpers", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "papyri-viewer-fs-"));
    initStore(new LocalStore(dir));
    initGraph(new LocalGraph(join(dir, "nope.db")));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("listIngestedBundles: [] on empty/missing, discovers <pkg>/<ver>", async () => {
    expect(await listIngestedBundles()).toEqual([]);
    await mkdir(join(dir, "numpy", "1.26.4"), { recursive: true });
    await mkdir(join(dir, "numpy", "2.0.0"), { recursive: true });
    await mkdir(join(dir, "scipy", "1.13.0"), { recursive: true });
    await writeFile(join(dir, "stray.txt"), "nope"); // must be skipped
    const got = await listIngestedBundles();
    expect(got.map((b) => `${b.pkg}/${b.version}`)).toEqual([
      "numpy/1.26.4", "numpy/2.0.0", "scipy/1.13.0",
    ]);
  });

  it("listModules: missing module/ -> [], files listed, .cbor stripped", async () => {
    expect(await listModules("pkg", "1.0")).toEqual([]);
    const modDir = join(dir, "pkg", "1.0", "module");
    await mkdir(modDir, { recursive: true });
    await writeFile(join(modDir, "numpy.fft$fft"), "x");
    await writeFile(join(modDir, "numpy.linalg$svd.cbor"), "x");
    await mkdir(join(modDir, "subdir")); // ignored (empty dir)
    expect(await listModules("pkg", "1.0")).toEqual(["numpy.fft$fft", "numpy.linalg$svd"]);
  });
});
