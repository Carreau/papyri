import { describe, it, expect } from "vitest";
import {
  qualnameToSlug,
  slugToQualname,
  linkForRef,
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
