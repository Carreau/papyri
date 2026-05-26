import { describe, it, expect } from "vitest";
import { renderNode } from "../src/lib/render-node.ts";
import type { IRNode } from "../src/lib/ir-reader.ts";

describe("renderNode CrossRef", () => {
  const crossref = {
    __type: "CrossRef",
    value: "numpy.linspace",
    reference: {
      __type: "RefInfo",
      module: "numpy",
      version: "*",
      kind: "api",
      path: "numpy:linspace",
    },
  } as unknown as IRNode;

  it("exposes the RefInfo on an unresolved ref for debugging", async () => {
    // No resolveXref → unresolved branch.
    const html = await renderNode(crossref);
    expect(html).toContain('class="xref unresolved"');
    // Visible CSS hover tooltip (content:attr(data-debug)) carries the RefInfo,
    // mirrored into title for accessibility.
    const dbg = "unresolved RefInfo(module=numpy, version=*, kind=api, path=numpy:linspace)";
    expect(html).toContain(`data-debug="${dbg}"`);
    expect(html).toContain(`title="${dbg}"`);
    // data-* attributes make it inspectable on click / in devtools.
    expect(html).toContain('data-ref-type="RefInfo"');
    expect(html).toContain('data-ref-module="numpy"');
    expect(html).toContain('data-ref-kind="api"');
    expect(html).toContain('data-ref-path="numpy:linspace"');
    expect(html).toContain(">numpy.linspace</span>");
  });

  it("renders a plain anchor (no debug attrs) when the ref resolves", async () => {
    const html = await renderNode(crossref, {
      resolveXref: () => ({
        url: "/project/numpy/2.0/api/numpy:linspace",
        label: "numpy.linspace",
      }),
    });
    expect(html).toContain('class="xref"');
    expect(html).not.toContain("unresolved");
    expect(html).not.toContain("data-ref-");
  });

  it("falls back to placeholders when the reference is missing", async () => {
    const bare = { __type: "CrossRef", value: "mystery" } as unknown as IRNode;
    const html = await renderNode(bare);
    expect(html).toContain('data-ref-type="RefInfo"');
    expect(html).toContain('data-debug="unresolved RefInfo(module=∅, version=∅, kind=∅, path=∅)"');
    expect(html).toContain('data-ref-module=""');
  });
});
