import { describe, it, expect } from "vitest";
import { buildQualnamePageView } from "../src/lib/qualname-page.ts";
import type { IngestedDoc } from "../src/lib/ir-reader.ts";
import type { RefTuple } from "../src/lib/graph.ts";

function makeMinimalDoc(qualname: string = "test.module"): IngestedDoc {
  return {
    __type: "IngestedDoc",
    __tag: 4010,
    _content: {},
    _ordered_sections: [],
    item_file: null,
    item_line: null,
    item_type: "function",
    aliases: [],
    example_section_data: null,
    see_also: [],
    signature: null,
    references: null,
    qa: qualname,
    arbitrary: [],
  };
}

describe("buildQualnamePageView - backref filtering", () => {
  describe("latest linking version per source package", () => {
    it("filters to latest version when same package has two versions linking", () => {
      const doc = makeMinimalDoc();
      const backrefs: RefTuple[] = [
        { pkg: "scipy", ver: "1.10.0", kind: "module", path: "scipy.signal:convolve" },
        { pkg: "scipy", ver: "1.11.0", kind: "module", path: "scipy.signal:convolve" },
      ];

      const view = buildQualnamePageView(doc, backrefs, "numpy");
      expect(view.externalBackrefs).toHaveLength(1);
      expect(view.externalBackrefs[0]!.pkg).toBe("scipy");
      // The latest version should be 1.11.0
      expect(view.externalBackrefs[0]!.url).toContain("1.11.0");
    });

    it("keeps older version when only older version links", () => {
      const doc = makeMinimalDoc();
      const backrefs: RefTuple[] = [
        { pkg: "scipy", ver: "1.10.0", kind: "module", path: "scipy.signal:convolve" },
      ];

      const view = buildQualnamePageView(doc, backrefs, "numpy");
      expect(view.externalBackrefs).toHaveLength(1);
      expect(view.externalBackrefs[0]!.url).toContain("1.10.0");
    });

    it("handles multiple source packages each with multiple versions", () => {
      const doc = makeMinimalDoc();
      const backrefs: RefTuple[] = [
        { pkg: "scipy", ver: "1.10.0", kind: "module", path: "scipy.signal:convolve" },
        { pkg: "scipy", ver: "1.11.0", kind: "module", path: "scipy.signal:convolve" },
        { pkg: "pandas", ver: "2.0.0", kind: "module", path: "pandas.core:DataFrame" },
        { pkg: "pandas", ver: "2.1.0", kind: "module", path: "pandas.core:DataFrame" },
      ];

      const view = buildQualnamePageView(doc, backrefs, "numpy");
      expect(view.externalBackrefs).toHaveLength(2);
      const byPkg = new Map(view.externalBackrefs.map((b) => [b.pkg, b]));
      expect(byPkg.get("scipy")!.url).toContain("1.11.0");
      expect(byPkg.get("pandas")!.url).toContain("2.1.0");
    });

    it("always keeps wildcard-version stubs (?) even if newer versions exist", () => {
      const doc = makeMinimalDoc();
      const backrefs: RefTuple[] = [
        { pkg: "scipy", ver: "1.11.0", kind: "module", path: "scipy.signal:convolve" },
        { pkg: "scipy", ver: "?", kind: "module", path: "scipy.signal:convolve" },
      ];

      const view = buildQualnamePageView(doc, backrefs, "numpy");
      // Both should be kept: the real version 1.11.0 and the wildcard
      expect(view.externalBackrefs).toHaveLength(2);
      const versions = new Set(view.externalBackrefs.map((b) => {
        const match = b.url.match(/\/(\d+\.\d+\.\d+|[?])\//);
        return match ? match[1] : null;
      }));
      expect(versions.has("1.11.0")).toBe(true);
      expect(versions.has("?")).toBe(true);
    });

    it("always keeps wildcard-version stubs (*) like (?)", () => {
      const doc = makeMinimalDoc();
      const backrefs: RefTuple[] = [
        { pkg: "scipy", ver: "1.11.0", kind: "module", path: "scipy.signal:convolve" },
        { pkg: "scipy", ver: "*", kind: "module", path: "scipy.signal:convolve" },
      ];

      const view = buildQualnamePageView(doc, backrefs, "numpy");
      // Both should be kept: the real version 1.11.0 and the wildcard
      expect(view.externalBackrefs).toHaveLength(2);
    });

    it("preserves internal references (same package) as before", () => {
      const doc = makeMinimalDoc();
      const backrefs: RefTuple[] = [
        { pkg: "numpy", ver: "1.26.0", kind: "module", path: "numpy.linalg:norm" },
        { pkg: "numpy", ver: "2.0.0", kind: "module", path: "numpy.linalg:norm" },
      ];

      const view = buildQualnamePageView(doc, backrefs, "numpy");
      // Internal refs should be filtered to latest version too
      expect(view.internalBackrefs).toHaveLength(1);
      expect(view.internalBackrefs[0]!.url).toContain("2.0.0");
    });

    it("distinguishes between same (pkg, path) with different kinds", () => {
      const doc = makeMinimalDoc();
      const backrefs: RefTuple[] = [
        // Two versions of the same module ref
        { pkg: "scipy", ver: "1.10.0", kind: "module", path: "scipy.signal:convolve" },
        { pkg: "scipy", ver: "1.11.0", kind: "module", path: "scipy.signal:convolve" },
        // A docs ref to the same path (different kind)
        { pkg: "scipy", ver: "1.10.0", kind: "docs", path: "scipy.signal:convolve" },
      ];

      const view = buildQualnamePageView(doc, backrefs, "numpy");
      // Should have 2: the latest module ref + the docs ref
      expect(view.externalBackrefs).toHaveLength(2);
    });

    it("deduplicates exact duplicates (same pkg, ver, kind, path)", () => {
      const doc = makeMinimalDoc();
      const backrefs: RefTuple[] = [
        { pkg: "scipy", ver: "1.11.0", kind: "module", path: "scipy.signal:convolve" },
        { pkg: "scipy", ver: "1.11.0", kind: "module", path: "scipy.signal:convolve" },
        { pkg: "scipy", ver: "1.11.0", kind: "module", path: "scipy.signal:convolve" },
      ];

      const view = buildQualnamePageView(doc, backrefs, "numpy");
      expect(view.externalBackrefs).toHaveLength(1);
    });

    it("correctly compares semantic versions (1.9 < 1.10 < 1.11)", () => {
      const doc = makeMinimalDoc();
      const backrefs: RefTuple[] = [
        { pkg: "scipy", ver: "1.9.0", kind: "module", path: "scipy.signal:convolve" },
        { pkg: "scipy", ver: "1.10.0", kind: "module", path: "scipy.signal:convolve" },
        { pkg: "scipy", ver: "1.11.0", kind: "module", path: "scipy.signal:convolve" },
      ];

      const view = buildQualnamePageView(doc, backrefs, "numpy");
      expect(view.externalBackrefs).toHaveLength(1);
      expect(view.externalBackrefs[0]!.url).toContain("1.11.0");
    });
  });

  describe("PEP 440 pre-release exclusion", () => {
    it("prefers stable over pre-release when both link", () => {
      const doc = makeMinimalDoc();
      const backrefs: RefTuple[] = [
        { pkg: "scipy", ver: "1.10.0", kind: "module", path: "scipy.signal:convolve" },
        { pkg: "scipy", ver: "1.11.0rc1", kind: "module", path: "scipy.signal:convolve" },
      ];

      const view = buildQualnamePageView(doc, backrefs, "numpy");
      expect(view.externalBackrefs).toHaveLength(1);
      expect(view.externalBackrefs[0]!.url).toContain("1.10.0");
    });

    it("prefers latest stable when multiple stable + pre-release versions link", () => {
      const doc = makeMinimalDoc();
      const backrefs: RefTuple[] = [
        { pkg: "scipy", ver: "1.9.0", kind: "module", path: "scipy.signal:convolve" },
        { pkg: "scipy", ver: "1.10.0", kind: "module", path: "scipy.signal:convolve" },
        { pkg: "scipy", ver: "1.11.0a1", kind: "module", path: "scipy.signal:convolve" },
        { pkg: "scipy", ver: "1.11.0b2", kind: "module", path: "scipy.signal:convolve" },
      ];

      const view = buildQualnamePageView(doc, backrefs, "numpy");
      expect(view.externalBackrefs).toHaveLength(1);
      expect(view.externalBackrefs[0]!.url).toContain("1.10.0");
    });

    it("falls back to latest pre-release when no stable version links", () => {
      const doc = makeMinimalDoc();
      const backrefs: RefTuple[] = [
        { pkg: "scipy", ver: "1.11.0a1", kind: "module", path: "scipy.signal:convolve" },
        { pkg: "scipy", ver: "1.11.0rc1", kind: "module", path: "scipy.signal:convolve" },
      ];

      const view = buildQualnamePageView(doc, backrefs, "numpy");
      expect(view.externalBackrefs).toHaveLength(1);
      // rc1 > a1, so rc1 should be picked
      expect(view.externalBackrefs[0]!.url).toContain("1.11.0rc1");
    });

    it("treats .dev versions as pre-release", () => {
      const doc = makeMinimalDoc();
      const backrefs: RefTuple[] = [
        { pkg: "scipy", ver: "1.10.0", kind: "module", path: "scipy.signal:convolve" },
        { pkg: "scipy", ver: "1.11.0.dev20240101", kind: "module", path: "scipy.signal:convolve" },
      ];

      const view = buildQualnamePageView(doc, backrefs, "numpy");
      expect(view.externalBackrefs).toHaveLength(1);
      expect(view.externalBackrefs[0]!.url).toContain("1.10.0");
    });
  });

  describe("backref bucketing (internal vs external)", () => {
    it("separates internal and external backrefs", () => {
      const doc = makeMinimalDoc();
      const backrefs: RefTuple[] = [
        { pkg: "numpy", ver: "2.0.0", kind: "module", path: "numpy.linalg:norm" },
        { pkg: "scipy", ver: "1.11.0", kind: "module", path: "scipy.signal:convolve" },
      ];

      const view = buildQualnamePageView(doc, backrefs, "numpy");
      expect(view.internalBackrefs).toHaveLength(1);
      expect(view.externalBackrefs).toHaveLength(1);
      expect(view.internalBackrefs[0]!.pkg).toBeUndefined();
      expect(view.externalBackrefs[0]!.pkg).toBe("scipy");
    });

    it("applies version filtering to both internal and external backrefs", () => {
      const doc = makeMinimalDoc();
      const backrefs: RefTuple[] = [
        { pkg: "numpy", ver: "1.26.0", kind: "module", path: "numpy.linalg:norm" },
        { pkg: "numpy", ver: "2.0.0", kind: "module", path: "numpy.linalg:norm" },
        { pkg: "scipy", ver: "1.10.0", kind: "module", path: "scipy.signal:convolve" },
        { pkg: "scipy", ver: "1.11.0", kind: "module", path: "scipy.signal:convolve" },
      ];

      const view = buildQualnamePageView(doc, backrefs, "numpy");
      expect(view.internalBackrefs).toHaveLength(1);
      expect(view.internalBackrefs[0]!.url).toContain("2.0.0");
      expect(view.externalBackrefs).toHaveLength(1);
      expect(view.externalBackrefs[0]!.url).toContain("1.11.0");
    });
  });
});
