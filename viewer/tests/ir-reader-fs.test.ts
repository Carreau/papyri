import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listBundles,
  listIngestedBundles,
  listModules,
} from "../src/lib/ir-reader.ts";

describe("fs-facing helpers", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "papyri-viewer-fs-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("listBundles: missing root -> [], empty root -> []", async () => {
    expect(await listBundles(join(dir, "does-not-exist"))).toEqual([]);
    expect(await listBundles(dir)).toEqual([]);
  });

  it("listBundles reads a minimal fake bundle layout", async () => {
    const bPath = join(dir, "numpy_1.26.4");
    await mkdir(bPath, { recursive: true });
    await writeFile(
      join(bPath, "papyri.json"),
      JSON.stringify({ module: "numpy", version: "1.26.4" }),
    );
    await mkdir(join(dir, "no_meta_0.1"), { recursive: true });

    const bundles = await listBundles(dir);
    expect(bundles).toHaveLength(2);
    const numpy = bundles.find((b) => b.dirName === "numpy_1.26.4")!;
    expect(numpy.meta).toEqual({ module: "numpy", version: "1.26.4" });
    expect(numpy.path).toBe(bPath);
    expect(bundles.find((b) => b.dirName === "no_meta_0.1")!.meta).toBeNull();
  });

  it("listIngestedBundles: [] on empty/missing, discovers <pkg>/<ver>", async () => {
    expect(await listIngestedBundles(join(dir, "nope"))).toEqual([]);
    expect(await listIngestedBundles(dir)).toEqual([]);
    await mkdir(join(dir, "numpy", "1.26.4"), { recursive: true });
    await mkdir(join(dir, "numpy", "2.0.0"), { recursive: true });
    await mkdir(join(dir, "scipy", "1.13.0"), { recursive: true });
    await writeFile(join(dir, "stray.txt"), "nope"); // must be skipped
    const got = await listIngestedBundles(dir);
    expect(got.map((b) => `${b.pkg}/${b.version}`)).toEqual([
      "numpy/1.26.4", "numpy/2.0.0", "scipy/1.13.0",
    ]);
  });

  it("listModules: missing module/ -> [], files listed, .cbor stripped", async () => {
    expect(await listModules(dir)).toEqual([]);
    const modDir = join(dir, "module");
    await mkdir(modDir, { recursive: true });
    await writeFile(join(modDir, "numpy.fft$fft"), "x");
    await writeFile(join(modDir, "numpy.linalg$svd.cbor"), "x");
    await mkdir(join(modDir, "subdir")); // ignored
    expect(await listModules(dir)).toEqual(["numpy.fft$fft", "numpy.linalg$svd"]);
  });
});
