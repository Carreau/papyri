import { describe, it, expect } from "vitest";
import { renderNode } from "../src/lib/render-node.ts";
import type { IRNode } from "../src/lib/ir-reader.ts";

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

  it("keeps base_type independent of kind (versionadded -> version)", async () => {
    const html = await renderNode(adm("versionadded", "version"));
    expect(html).toContain("admonition-version");
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
