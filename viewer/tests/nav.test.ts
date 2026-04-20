import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStore } from "../src/lib/storage-local.ts";
import { initStore } from "../src/lib/storage.ts";
import {
  isTutorial,
  listDocs,
  listExamples,
  listFilesRecursive,
  loadBundleNav,
  clearNavCache,
} from "../src/lib/nav.ts";

describe("nav.ts", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "papyri-viewer-nav-"));
    initStore(new LocalStore(dir));
    clearNavCache();
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

  describe("listFilesRecursive", () => {
    it("returns [] for a missing root", async () => {
      expect(await listFilesRecursive("pkg", "1.0", "nope")).toEqual([]);
    });

    it("walks nested files and normalises separators", async () => {
      await mkdir(join(dir, "pkg", "1.0", "a", "b"), { recursive: true });
      await writeFile(join(dir, "pkg", "1.0", "a", "b", "deep.txt"), "x");
      await writeFile(join(dir, "pkg", "1.0", "a", "shallow.txt"), "x");
      await writeFile(join(dir, "pkg", "1.0", "root.txt"), "x");
      const got = await listFilesRecursive("pkg", "1.0", "");
      expect(got).toEqual(["a/b/deep.txt", "a/shallow.txt", "root.txt"]);
    });
  });

  describe("listDocs / listExamples", () => {
    it("read from the bundle's docs/ and examples/ dirs", async () => {
      await mkdir(join(dir, "pkg", "1.0", "docs", "tutorials"), { recursive: true });
      await writeFile(join(dir, "pkg", "1.0", "docs", "index"), "x");
      await writeFile(join(dir, "pkg", "1.0", "docs", "crossrefs"), "x");
      await writeFile(join(dir, "pkg", "1.0", "docs", "tutorials", "intro"), "x");

      await mkdir(join(dir, "pkg", "1.0", "examples"), { recursive: true });
      await writeFile(join(dir, "pkg", "1.0", "examples", "simple_plot.py"), "x");

      expect(await listDocs("pkg", "1.0")).toEqual([
        "crossrefs",
        "index",
        "tutorials/intro",
      ]);
      expect(await listExamples("pkg", "1.0")).toEqual(["simple_plot.py"]);
    });

    it("returns [] when the dir is absent", async () => {
      expect(await listDocs("pkg", "1.0")).toEqual([]);
      expect(await listExamples("pkg", "1.0")).toEqual([]);
    });
  });

  describe("loadBundleNav", () => {
    it("splits tutorials off from docs by filename convention", async () => {
      await mkdir(join(dir, "pkg", "1.0", "docs", "tutorials"), { recursive: true });
      await writeFile(join(dir, "pkg", "1.0", "docs", "index"), "x");
      await writeFile(join(dir, "pkg", "1.0", "docs", "tutorial_intro"), "x");
      await writeFile(join(dir, "pkg", "1.0", "docs", "tutorials", "basics"), "x");
      await mkdir(join(dir, "pkg", "1.0", "module"));

      const nav = await loadBundleNav("pkg", "1.0");
      expect(nav.docs.map((e) => e.name)).toEqual(["index"]);
      expect(nav.tutorials.map((e) => e.name).sort()).toEqual([
        "tutorial_intro",
        "tutorials/basics",
      ]);
    });

    it("produces URL hrefs that encode path segments", async () => {
      await mkdir(join(dir, "pkg", "1.0", "docs"), { recursive: true });
      await writeFile(join(dir, "pkg", "1.0", "docs", "a b"), "x");
      const nav = await loadBundleNav("pkg", "1.0");
      const entry = nav.docs.find((e) => e.name === "a b");
      expect(entry?.href).toBe("/pkg/1.0/docs/a%20b/");
    });

    it("returns an empty view-model for a bare bundle dir", async () => {
      const nav = await loadBundleNav("pkg", "1.0");
      expect(nav.docs).toEqual([]);
      expect(nav.tutorials).toEqual([]);
      expect(nav.examples).toEqual([]);
      expect(nav.qualnames).toEqual([]);
      expect(nav.toc).toEqual([]);
      expect(nav.logoDataUrl).toBeNull();
    });
  });
});
