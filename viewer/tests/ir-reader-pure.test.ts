import { describe, it, expect } from "vitest";
import {
  qualnameToSlug,
  slugToQualname,
  linkForRef,
  collectNodes,
  collectImages,
} from "../src/lib/ir-reader.ts";

describe("qualname <-> slug", () => {
  it("rewrites colons to $ and leaves dotted qualnames alone", () => {
    expect(qualnameToSlug("papyri.nodes:RefInfo")).toBe("papyri.nodes$RefInfo");
    expect(qualnameToSlug("numpy.linalg.svd")).toBe("numpy.linalg.svd");
  });

  it("roundtrips qualname -> slug -> qualname", () => {
    const qa = "papyri.gen:Config.__init__";
    expect(slugToQualname(qualnameToSlug(qa))).toBe(qa);
  });

  it("qualnameToSlug is idempotent on slug-shaped input (no colons)", () => {
    // The docstring assumes qualnames never contain '$'. Running the slugger
    // again is a no-op, but slugToQualname is destructive in reverse.
    expect(qualnameToSlug("papyri.nodes$RefInfo")).toBe("papyri.nodes$RefInfo");
    expect(slugToQualname("papyri.nodes$RefInfo")).toBe("papyri.nodes:RefInfo");
  });
});

describe("linkForRef", () => {
  it("shapes URLs per kind and slugifies module paths", () => {
    expect(
      linkForRef({ pkg: "numpy", ver: "1.26.4", kind: "module", path: "numpy.fft:fft" }),
    ).toBe("/numpy/1.26.4/numpy.fft$fft/");
    expect(
      linkForRef({ pkg: "np", ver: "1.0", kind: "docs", path: "user guide" }),
    ).toBe("/np/1.0/docs/user%20guide/");
    expect(
      linkForRef({ pkg: "np", ver: "1.0", kind: "examples", path: "intro" }),
    ).toBe("/np/1.0/examples/intro/");
    expect(
      linkForRef({ pkg: "np", ver: "1.0", kind: "assets", path: "img/logo.png" }),
    ).toBe("/assets/np/1.0/img/logo.png");
  });

  it("returns null for unknown kinds", () => {
    expect(
      linkForRef({ pkg: "np", ver: "1.0", kind: "bogus", path: "x" }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// collectNodes / collectImages
// ---------------------------------------------------------------------------

function makeNode(type: string, extra: Record<string, unknown> = {}) {
  return { __type: type, __tag: 0, ...extra };
}

describe("collectNodes", () => {
  it("returns empty for primitives and null", () => {
    expect(collectNodes(null, new Set(["Math"]))).toEqual([]);
    expect(collectNodes("hello", new Set(["Math"]))).toEqual([]);
    expect(collectNodes(42, new Set(["Math"]))).toEqual([]);
  });

  it("finds a top-level matching node", () => {
    const node = makeNode("Math", { value: "x^2" });
    const result = collectNodes(node, new Set(["Math"]));
    expect(result).toHaveLength(1);
    expect((result[0] as any).__type).toBe("Math");
    expect((result[0] as any).value).toBe("x^2");
  });

  it("finds nodes nested inside a Section's children array", () => {
    const math = makeNode("Math", { value: "e=mc^2" });
    const para = makeNode("Paragraph", { children: [math] });
    const section = makeNode("Section", { children: [para], title: null, level: 1 });
    const result = collectNodes(section, new Set(["Math"]));
    expect(result).toHaveLength(1);
    expect((result[0] as any).value).toBe("e=mc^2");
  });

  it("collects multiple types in one pass", () => {
    const math = makeNode("Math", { value: "a+b" });
    const code = makeNode("Code", { value: "print(x)" });
    const para = makeNode("Paragraph", { children: [math, code] });
    const result = collectNodes(para, new Set(["Math", "Code"]));
    expect(result).toHaveLength(2);
    expect(result.map((n) => (n as any).__type).sort()).toEqual(["Code", "Math"]);
  });

  it("does not collect nodes of non-requested types", () => {
    const inline = makeNode("InlineMath", { value: "x" });
    const para = makeNode("Paragraph", { children: [inline] });
    expect(collectNodes(para, new Set(["Math"]))).toHaveLength(0);
    expect(collectNodes(para, new Set(["InlineMath"]))).toHaveLength(1);
  });

  it("walks flat arrays", () => {
    const nodes = [
      makeNode("Math", { value: "1" }),
      makeNode("Text", { value: "hello" }),
      makeNode("Math", { value: "2" }),
    ];
    expect(collectNodes(nodes, new Set(["Math"]))).toHaveLength(2);
  });

  it("recurses into matched nodes (nested Figure inside Section)", () => {
    const inner = makeNode("Math", { value: "inner" });
    const outer = makeNode("Math", { value: "outer", nested: { __type: "Paragraph", __tag: 0, children: [inner] } });
    const result = collectNodes(outer, new Set(["Math"]));
    // Both outer and inner should be found
    expect(result).toHaveLength(2);
  });
});

describe("collectImages", () => {
  it("extracts Image nodes with direct URLs", () => {
    const img = makeNode("Image", { url: "https://example.com/pic.png", alt: "a pic" });
    const result = collectImages(img);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ kind: "Image", src: "https://example.com/pic.png", alt: "a pic" });
  });

  it("extracts Figure nodes with asset RefInfo and builds the src URL", () => {
    const ref = makeNode("RefInfo", { module: "numpy", version: "2.0", kind: "assets", path: "fig:plot.png" });
    const fig = makeNode("Figure", { value: ref });
    const result = collectImages(fig);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      kind: "Figure",
      assetPath: "fig:plot.png",
      src: "/assets/numpy/2.0/fig$plot.png",
    });
  });

  it("ignores Figure nodes whose RefInfo kind is not assets", () => {
    const ref = makeNode("RefInfo", { module: "numpy", version: "2.0", kind: "module", path: "numpy.fft" });
    const fig = makeNode("Figure", { value: ref });
    expect(collectImages(fig)).toHaveLength(0);
  });

  it("skips Image nodes with empty URLs", () => {
    const img = makeNode("Image", { url: "", alt: "" });
    expect(collectImages(img)).toHaveLength(0);
  });
});
