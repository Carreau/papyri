import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsBlobStore } from "papyri-ingest";
import { listIngestedBundles, listModules } from "../src/lib/ir-reader.ts";

describe("fs-facing helpers", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "papyri-viewer-fs-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("listIngestedBundles: [] on empty/missing, discovers <pkg>/<ver>", async () => {
    // Empty store returns [].
    expect(await listIngestedBundles(new FsBlobStore(join(dir, "nope")))).toEqual([]);
    expect(await listIngestedBundles(new FsBlobStore(dir))).toEqual([]);

    // Create a minimal blob per bundle so FsBlobStore.list("") picks them up.
    const dummy = new Uint8Array([0]);
    for (const [pkg, ver] of [
      ["numpy", "1.26.4"],
      ["numpy", "2.0.0"],
      ["scipy", "1.13.0"],
    ]) {
      await mkdir(join(dir, pkg, ver, "module"), { recursive: true });
      await writeFile(join(dir, pkg, ver, "module", "placeholder"), dummy);
    }
    // A stray file at the top level must be ignored (parts.length < 3).
    await writeFile(join(dir, "stray.txt"), "nope");

    const got = await listIngestedBundles(new FsBlobStore(dir));
    expect(got.map((b) => `${b.pkg}/${b.version}`)).toEqual([
      "numpy/1.26.4",
      "numpy/2.0.0",
      "scipy/1.13.0",
    ]);
  });

  it("listModules: missing module/ -> [], files listed, .cbor stripped", async () => {
    const store = new FsBlobStore(dir);
    expect(await listModules(store, "pkg", "1.0")).toEqual([]);

    const modDir = join(dir, "pkg", "1.0", "module");
    await mkdir(modDir, { recursive: true });
    await writeFile(join(modDir, "numpy.fft$fft"), "x");
    await writeFile(join(modDir, "numpy.linalg$svd.cbor"), "x");
    // Subdirectories are ignored (rel.includes("/")).
    await mkdir(join(modDir, "subdir"));
    await writeFile(join(modDir, "subdir", "ignored"), "x");

    expect(await listModules(store, "pkg", "1.0")).toEqual(["numpy.fft$fft", "numpy.linalg$svd"]);
  });
});
