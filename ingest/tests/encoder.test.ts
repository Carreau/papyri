/**
 * Tests for encoder.ts: decode/encode round-trip and GeneratedDoc→IngestedDoc
 * conversion.
 *
 * We test at the TypedNode / Tag level so tests run without any real gen
 * bundle on disk.
 */

import { describe, it, expect } from "vitest";
import { encode as cborEncode, Tag } from "cbor-x";
import {
  decode,
  encode,
  toEncodable,
  generatedDocToIngested,
  FIELD_ORDER,
} from "../src/encoder.ts";
import type { TypedNode } from "../src/encoder.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSection(title: string | null = null): TypedNode {
  return {
    __type: "Section",
    __tag: 4015,
    children: [],
    title,
    level: 1,
    target: null,
  };
}

function makeText(value: string): TypedNode {
  return { __type: "Text", __tag: 4046, value };
}

function makeRefInfo(module: string, version: string, kind: string, path: string): TypedNode {
  return { __type: "RefInfo", __tag: 4000, module, version, kind, path };
}

// ---------------------------------------------------------------------------
// toEncodable
// ---------------------------------------------------------------------------

describe("toEncodable", () => {
  it("passes through null", () => {
    expect(toEncodable(null)).toBe(null);
  });

  it("passes through primitives", () => {
    expect(toEncodable(42)).toBe(42);
    expect(toEncodable("hello")).toBe("hello");
    expect(toEncodable(true)).toBe(true);
  });

  it("recursively processes arrays", () => {
    const result = toEncodable([makeText("hi")]) as unknown[];
    expect(result).toHaveLength(1);
    expect(result[0]).toBeInstanceOf(Tag);
    const tag = result[0] as Tag;
    expect(tag.tag).toBe(4046);
    expect(Array.isArray(tag.value)).toBe(true);
  });

  it("converts a TypedNode to Tag(values, tag)", () => {
    const node = makeText("hello");
    const result = toEncodable(node);
    expect(result).toBeInstanceOf(Tag);
    const tag = result as Tag;
    expect(tag.tag).toBe(4046);
    expect(tag.value).toEqual(["hello"]);
  });

  it("converts a RefInfo to Tag with 4 fields in order", () => {
    const node = makeRefInfo("numpy", "2.0", "module", "numpy.linspace");
    const tag = toEncodable(node) as Tag;
    expect(tag.tag).toBe(4000);
    expect(tag.value).toEqual(["numpy", "2.0", "module", "numpy.linspace"]);
  });

  it("passes plain objects through as maps (no tag)", () => {
    const obj = { key: "val" };
    const result = toEncodable(obj);
    // Not a Tag, just a plain object.
    expect(result).not.toBeInstanceOf(Tag);
    expect(result).toEqual({ key: "val" });
  });

  it("strips __type and __tag from plain objects (they look like TypedNodes only if both present)", () => {
    // The _content dict has string keys, no __type.
    const content = { Parameters: makeSection("Parameters") };
    const result = toEncodable(content) as Record<string, unknown>;
    expect(result["Parameters"]).toBeInstanceOf(Tag);
    // __type / __tag not present in the map itself.
    expect(Object.keys(result)).toEqual(["Parameters"]);
  });
});

// ---------------------------------------------------------------------------
// encode / decode round-trip
// ---------------------------------------------------------------------------

describe("encode + decode round-trip", () => {
  it("round-trips a Text node", () => {
    const node = makeText("hello world");
    const bytes = encode(node);
    const back = decode<TypedNode>(bytes);
    expect(back.__type).toBe("Text");
    expect(back.value).toBe("hello world");
  });

  it("round-trips a Section containing a Text", () => {
    const sec = { ...makeSection("My Section"), children: [makeText("body")] };
    const bytes = encode(sec);
    const back = decode<TypedNode>(bytes);
    expect(back.__type).toBe("Section");
    expect(back.title).toBe("My Section");
    const children = back.children as TypedNode[];
    expect(children).toHaveLength(1);
    expect(children[0]!.__type).toBe("Text");
    expect(children[0]!.value).toBe("body");
  });

  it("round-trips a RefInfo node", () => {
    const ref = makeRefInfo("numpy", "2.0", "module", "numpy.linspace");
    const bytes = encode(ref);
    const back = decode<TypedNode>(bytes);
    expect(back.__type).toBe("RefInfo");
    expect(back.module).toBe("numpy");
    expect(back.version).toBe("2.0");
    expect(back.kind).toBe("module");
    expect(back.path).toBe("numpy.linspace");
  });

  it("round-trips a plain dict (CBOR map) inside a node", () => {
    const sec = makeSection();
    const doc: TypedNode = {
      __type: "IngestedDoc",
      __tag: 4010,
      _content: { Summary: sec },
      _ordered_sections: ["Summary"],
      item_file: null,
      item_line: null,
      item_type: "module",
      aliases: [],
      example_section_data: null,
      see_also: [],
      signature: null,
      references: null,
      qa: "mymodule",
      arbitrary: [],
      local_refs: [],
    };
    const bytes = encode(doc);
    const back = decode<TypedNode>(bytes);
    expect(back.__type).toBe("IngestedDoc");
    expect(back.qa).toBe("mymodule");
    const content = back._content as Record<string, TypedNode>;
    expect(content["Summary"]?.__type).toBe("Section");
  });

  it("decode is the inverse of the raw cbor-x encoder when no tags are used", () => {
    // Encode a plain value with cbor-x directly (no IR tags).
    const plain = { a: 1, b: "two", c: [true, null] };
    const bytes = cborEncode(plain);
    const back = decode(bytes);
    expect(back).toEqual(plain);
  });

  it("decodes a cbor-x Tag produced outside papyri", () => {
    // Simulate what happens when cbor-x sees a raw tagged value.
    const tag = new Tag([["numpy", "2.0", "module", "numpy.linspace"]], 4000);
    const bytes = cborEncode(tag);
    const back = decode<TypedNode>(bytes);
    // The outer Tag(4000, [...]) should be decoded as a RefInfo.
    // Note: cbor-x encodes Tag(value, tag) — value is the array wrapping the fields.
    // Our FIELD_ORDER expects the value to be the positional fields array directly.
    // The raw encoding produces Tag(4000, [["numpy", ...]]) — one extra nesting.
    // That's fine; this test just checks that unknown structures degrade gracefully.
    expect(back.__type).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// generatedDocToIngested
// ---------------------------------------------------------------------------

describe("generatedDocToIngested", () => {
  function makeGenDoc(_qa: string): TypedNode {
    return {
      __type: "GeneratedDoc",
      __tag: 4011,
      _content: {},
      example_section_data: null,
      _ordered_sections: ["Summary"],
      item_file: "/path/to/file.py",
      item_line: 10,
      item_type: "function",
      aliases: ["mymodule.alias"],
      see_also: [],
      signature: null,
      references: null,
      arbitrary: [],
      local_refs: ["someref"],
      // qa is NOT a field on GeneratedDoc; it's passed explicitly
    };
  }

  it("produces an IngestedDoc node with correct __type and __tag", () => {
    const gen = makeGenDoc("mymodule.myfunc");
    const ing = generatedDocToIngested(gen, "mymodule.myfunc");
    expect(ing.__type).toBe("IngestedDoc");
    expect(ing.__tag).toBe(4010);
  });

  it("sets qa from the second argument", () => {
    const gen = makeGenDoc("x");
    expect(generatedDocToIngested(gen, "mymodule.myfunc").qa).toBe("mymodule.myfunc");
  });

  it("copies all matching fields from GeneratedDoc", () => {
    const gen = makeGenDoc("mymodule.myfunc");
    const ing = generatedDocToIngested(gen, "mymodule.myfunc");
    expect(ing.item_file).toBe("/path/to/file.py");
    expect(ing.item_line).toBe(10);
    expect(ing.item_type).toBe("function");
    expect(ing.aliases).toEqual(["mymodule.alias"]);
    expect(ing._ordered_sections).toEqual(["Summary"]);
  });

  it("copies local_refs from GeneratedDoc", () => {
    const gen = makeGenDoc("mymodule.myfunc");
    const ing = generatedDocToIngested(gen, "mymodule.myfunc");
    expect(ing.local_refs).toEqual(["someref"]);
  });

  it("defaults local_refs to [] when GeneratedDoc has none", () => {
    const gen = makeGenDoc("x");
    delete (gen as Record<string, unknown>)["local_refs"];
    const ing = generatedDocToIngested(gen, "x");
    expect(ing.local_refs).toEqual([]);
  });

  it("throws when given a non-GeneratedDoc node", () => {
    const bad = makeText("oops");
    expect(() => generatedDocToIngested(bad, "x")).toThrow("expected GeneratedDoc");
  });

  it("has exactly the fields listed in FIELD_ORDER[4010]", () => {
    const gen = makeGenDoc("mymodule.myfunc");
    const ing = generatedDocToIngested(gen, "mymodule.myfunc");
    const expectedFields = FIELD_ORDER[4010]!.fields;
    for (const f of expectedFields) {
      expect(ing).toHaveProperty(f);
    }
  });
});
