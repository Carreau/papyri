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

describe("renderNode SeeAlsoItem", () => {
  it("renders name + description, resolving refs inside the description", async () => {
    const item = {
      __type: "SeeAlsoItem",
      name: {
        __type: "CrossRef",
        value: "higher_order",
        reference: { __type: "LocalRef", kind: "module", path: "papyri.examples:higher_order" },
      },
      descriptions: [
        {
          __type: "Paragraph",
          children: [
            { __type: "Text", value: "Consume the output via a " },
            {
              __type: "CrossRef",
              value: "Callable",
              reference: {
                __type: "RefInfo",
                module: "collections",
                version: "*",
                kind: "api",
                path: "collections.abc:Callable",
              },
            },
            { __type: "Text", value: "." },
          ],
        },
      ],
      type: null,
    } as unknown as IRNode;

    const html = await renderNode(item, {
      resolveXref: (raw) => {
        const n = raw as { reference?: { path?: string } };
        if (n.reference?.path === "collections.abc:Callable")
          return {
            url: "https://docs.python.org/3/library/collections.abc.html#collections.abc.Callable",
            label: "Callable",
            external: true,
          };
        return null;
      },
    });

    expect(html).toContain('<dt class="see-also-name">');
    expect(html).toContain('<dd class="see-also-desc">');
    // The ref inside the description resolved to the external python inventory.
    expect(html).toContain('class="xref external"');
    expect(html).toContain(
      'href="https://docs.python.org/3/library/collections.abc.html#collections.abc.Callable"'
    );
  });
});

const adm = (kind: string, baseType: string): IRNode =>
  ({
    __type: "Admonition",
    __tag: 4056,
    kind,
    base_type: baseType,
    children: [{ __type: "Text", __tag: 4046, value: "body" }],
  }) as unknown as IRNode;

describe("renderNode Admonition", () => {
  it("emits admonition-<base_type> alongside the raw kind class", async () => {
    const html = await renderNode(adm("error", "danger"));
    expect(html).toContain('class="admonition admonition-danger error"');
    expect(html).toContain("body");
  });

  it("keeps base_type independent of kind (versionadded -> neutral)", async () => {
    const html = await renderNode(adm("versionadded", "neutral"));
    expect(html).toContain("admonition-neutral");
    expect(html).toContain("versionadded");
  });

  it("falls back to note when base_type is absent", async () => {
    const node = {
      __type: "Admonition",
      __tag: 4056,
      kind: "note",
      children: [],
    } as unknown as IRNode;
    expect(await renderNode(node)).toContain("admonition-note");
  });
});

describe("renderNode URL sanitisation", () => {
  const link = (url: string): IRNode =>
    ({
      __type: "Link",
      url,
      title: "",
      children: [{ __type: "Text", value: "x" }],
    }) as unknown as IRNode;
  const image = (url: string): IRNode => ({ __type: "Image", url, alt: "a" }) as unknown as IRNode;

  it("blanks a javascript: href on a Link", async () => {
    const html = await renderNode(link("javascript:alert(1)"));
    expect(html).not.toContain("javascript:");
    expect(html).toContain('href=""');
  });

  it("blanks a data: src on an Image", async () => {
    const html = await renderNode(image("data:text/html,<script>x</script>"));
    expect(html).not.toContain("data:");
    expect(html).toContain('src=""');
  });

  it("preserves safe http(s) and relative URLs", async () => {
    expect(await renderNode(link("https://example.com"))).toContain('href="https://example.com"');
    expect(await renderNode(link("../docs/page"))).toContain('href="../docs/page"');
    expect(await renderNode(image("../assets/fig.png"))).toContain('src="../assets/fig.png"');
  });
});
