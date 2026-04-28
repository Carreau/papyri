import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsBlobStore } from "papyri-ingest";
import { isTutorial, listDocs, listExamples, loadBundleNav } from "../src/lib/nav.ts";

describe("nav.ts", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "papyri-viewer-nav-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe("isTutorial", () => {
    it("flags tutorial_ prefixed basenames", () => {
      expect(isTutorial("tutorial_intro")).toBe(true);
      expect(isTutorial("subdir/tutorial_nested")).toBe(true);
    });
    it("flags anything under tutorials/", () => {
      expect(isTutorial("tutorials/intro")).toBe(true);
      expect(isTutorial("tutorials/nested/deep")).toBe(true);
    });
    it("rejects regular doc paths", () => {
      expect(isTutorial("index")).toBe(false);
      expect(isTutorial("crossrefs")).toBe(false);
      expect(isTutorial("guide/usage")).toBe(false);
    });
    it("does not confuse mid-word matches", () => {
      // "contains tutorial_" but basename isn't prefixed
      expect(isTutorial("pretutorial_not_really")).toBe(false);
    });
  });

  describe("listDocs / listExamples", () => {
    const pkg = "pkg",
      ver = "1.0";

    it("read from the bundle's docs/ and examples/ dirs", async () => {
      await mkdir(join(dir, pkg, ver, "docs", "tutorials"), { recursive: true });
      await writeFile(join(dir, pkg, ver, "docs", "index"), "x");
      await writeFile(join(dir, pkg, ver, "docs", "crossrefs"), "x");
      await writeFile(join(dir, pkg, ver, "docs", "tutorials", "intro"), "x");

      await mkdir(join(dir, pkg, ver, "examples"), { recursive: true });
      await writeFile(join(dir, pkg, ver, "examples", "simple_plot.py"), "x");

      const store = new FsBlobStore(dir);
      expect(await listDocs(store, pkg, ver)).toEqual(["crossrefs", "index", "tutorials/intro"]);
      expect(await listExamples(store, pkg, ver)).toEqual(["simple_plot.py"]);
    });

    it("returns [] when the dir is absent", async () => {
      const store = new FsBlobStore(dir);
      expect(await listDocs(store, pkg, ver)).toEqual([]);
      expect(await listExamples(store, pkg, ver)).toEqual([]);
    });
  });

  describe("loadBundleNav", () => {
    // Use a unique pkg name per test to avoid the module-level nav cache
    // returning a stale result from a previous test case.

    it("splits tutorials off from docs by filename convention", async () => {
      const pkg = "pkg-split",
        ver = "1.0";
      await mkdir(join(dir, pkg, ver, "docs", "tutorials"), { recursive: true });
      await writeFile(join(dir, pkg, ver, "docs", "index"), "x");
      await writeFile(join(dir, pkg, ver, "docs", "tutorial_intro"), "x");
      await writeFile(join(dir, pkg, ver, "docs", "tutorials", "basics"), "x");
      await mkdir(join(dir, pkg, ver, "module"), { recursive: true });

      const nav = await loadBundleNav(new FsBlobStore(dir), pkg, ver);
      expect(nav.docs.map((e) => e.name)).toEqual(["index"]);
      expect(nav.tutorials.map((e) => e.name).sort()).toEqual([
        "tutorial_intro",
        "tutorials/basics",
      ]);
    });

    it("produces URL hrefs that encode path segments", async () => {
      const pkg = "pkg-hrefs",
        ver = "1.0";
      await mkdir(join(dir, pkg, ver, "docs"), { recursive: true });
      await writeFile(join(dir, pkg, ver, "docs", "a b"), "x");
      const nav = await loadBundleNav(new FsBlobStore(dir), pkg, ver);
      const entry = nav.docs.find((e) => e.name === "a b");
      expect(entry?.href).toBe(`/${pkg}/${ver}/docs/a%20b/`);
    });

    it("returns an empty view-model for a bare bundle dir", async () => {
      const pkg = "pkg-empty",
        ver = "1.0";
      const nav = await loadBundleNav(new FsBlobStore(dir), pkg, ver);
      expect(nav.docs).toEqual([]);
      expect(nav.tutorials).toEqual([]);
      expect(nav.examples).toEqual([]);
      expect(nav.qualnames).toEqual([]);
      expect(nav.toc).toEqual([]);
      expect(nav.logoDataUrl).toBeNull();
    });
  });
});
