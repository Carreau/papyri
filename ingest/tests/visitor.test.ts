/**
 * Tests for visitor.ts: collectForwardRefs and collectForwardRefsFromSection.
 */

import { describe, it, expect } from "vitest";
import { collectForwardRefs, collectForwardRefsFromSection } from "../src/visitor.ts";
import type { TypedNode } from "../src/encoder.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function refInfo(module: string, version: string, kind: string, path: string): TypedNode {
  return { __type: "RefInfo", __tag: 4000, module, version, kind, path };
}

function localRef(kind: string, path: string): TypedNode {
  return { __type: "RefInfo", __tag: 4000, module: "mymod", version: "1.0", kind, path };
}

function section(children: unknown[] = [], title: string | null = null): TypedNode {
  return { __type: "Section", __tag: 4015, children, title, level: 1, target: null };
}

function paragraph(children: unknown[] = []): TypedNode {
  return { __type: "Paragraph", __tag: 4045, children };
}

function figure(module: string, version: string, path: string): TypedNode {
  return {
    __type: "Figure",
    __tag: 4024,
    value: refInfo(module, version, "assets", path),
  };
}

function ingestedDoc(overrides: Partial<TypedNode> = {}): TypedNode {
  return {
    __type: "IngestedDoc",
    __tag: 4010,
    _content: {},
    _ordered_sections: [],
    item_file: null,
    item_line: null,
    item_type: null,
    aliases: [],
    example_section_data: null,
    see_also: [],
    signature: null,
    references: null,
    qa: "test.func",
    arbitrary: [],
    local_refs: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// collectForwardRefs
// ---------------------------------------------------------------------------

describe("collectForwardRefs", () => {
  it("returns empty list for a doc with no refs", () => {
    const doc = ingestedDoc();
    expect(collectForwardRefs(doc)).toEqual([]);
  });

  it("collects RefInfo nodes from _content sections", () => {
    const ref = refInfo("numpy", "2.0", "module", "numpy.linspace");
    const doc = ingestedDoc({
      _content: { Summary: section([paragraph([ref])]) },
      _ordered_sections: ["Summary"],
    });
    const refs = collectForwardRefs(doc);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      module: "numpy",
      version: "2.0",
      kind: "module",
      path: "numpy.linspace",
    });
  });

  it("skips RefInfo nodes with kind='local'", () => {
    const ref = localRef("local", "somesection");
    const doc = ingestedDoc({
      _content: { Summary: section([paragraph([ref])]) },
    });
    expect(collectForwardRefs(doc)).toEqual([]);
  });

  it("collects RefInfo nodes from example_section_data", () => {
    const ref = refInfo("scipy", "1.0", "module", "scipy.linalg");
    const doc = ingestedDoc({
      example_section_data: section([paragraph([ref])]),
    });
    const refs = collectForwardRefs(doc);
    expect(refs).toHaveLength(1);
    expect(refs[0]!.module).toBe("scipy");
  });

  it("collects RefInfo nodes from arbitrary sections", () => {
    const ref = refInfo("sklearn", "1.0", "module", "sklearn.linear_model");
    const doc = ingestedDoc({ arbitrary: [section([paragraph([ref])])] });
    const refs = collectForwardRefs(doc);
    expect(refs).toHaveLength(1);
    expect(refs[0]!.module).toBe("sklearn");
  });

  it("collects Figure refs from _content", () => {
    const fig = figure("numpy", "2.0", "fig_scatter.png");
    const doc = ingestedDoc({
      _content: { Notes: section([fig]) },
    });
    const refs = collectForwardRefs(doc);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ kind: "assets", path: "fig_scatter.png" });
  });

  it("deduplicates identical refs", () => {
    const ref = refInfo("numpy", "2.0", "module", "numpy.array");
    const doc = ingestedDoc({
      _content: {
        Summary: section([paragraph([ref])]),
        Notes: section([paragraph([ref])]),
      },
    });
    expect(collectForwardRefs(doc)).toHaveLength(1);
  });

  it("returns refs sorted lexicographically", () => {
    const r1 = refInfo("numpy", "2.0", "module", "numpy.zeros");
    const r2 = refInfo("numpy", "2.0", "module", "numpy.arange");
    const doc = ingestedDoc({
      _content: { Notes: section([paragraph([r1, r2])]) },
    });
    const refs = collectForwardRefs(doc);
    expect(refs.map((r) => r.path)).toEqual(["numpy.arange", "numpy.zeros"]);
  });
});

// ---------------------------------------------------------------------------
// collectForwardRefsFromSection
// ---------------------------------------------------------------------------

describe("collectForwardRefsFromSection", () => {
  it("returns empty list for a section with no refs", () => {
    expect(collectForwardRefsFromSection(section())).toEqual([]);
  });

  it("collects RefInfo nodes nested inside a section", () => {
    const ref = refInfo("numpy", "2.0", "module", "numpy.linspace");
    const sec = section([paragraph([ref])]);
    const refs = collectForwardRefsFromSection(sec);
    expect(refs).toHaveLength(1);
    expect(refs[0]!.path).toBe("numpy.linspace");
  });

  it("skips local refs", () => {
    const ref = localRef("local", "target");
    const sec = section([paragraph([ref])]);
    expect(collectForwardRefsFromSection(sec)).toEqual([]);
  });
});
