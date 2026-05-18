import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsBlobStore } from "papyri-ingest";
import { encode } from "../../ingest/src/encoder.ts";
import type { TypedNode } from "../../ingest/src/encoder.ts";

// Build IngestedDoc fixtures using the papyri encoder so the test verifies
// the full encode→store→loadModule decode round-trip.

const mkDoc = (qa: string, o: Record<string, unknown> = {}): TypedNode => ({
  __type: "IngestedDoc",
  __tag: 4010,
  _content: {},
  _ordered_sections: [],
  item_file: (o.item_file as string | null) ?? null,
  item_line: (o.item_line as number | null) ?? null,
  item_type: (o.item_type as string | null) ?? null,
  aliases: [],
  example_section_data: null,
  see_also: [],
  signature: (o.signature as TypedNode | null) ?? null,
  references: null,
  qa,
  arbitrary: (o.arbitrary as unknown[]) ?? [],
  local_refs: [],
});

const bytesFull = encode(
  mkDoc("pkg.mod:foo", {
    item_file: "foo.py",
    item_line: 42,
    item_type: "function",
    signature: {
      __type: "SignatureNode",
      __tag: 4029,
      kind: "function",
      parameters: [],
      return_annotation: { __type: "Empty", __tag: 4031 },
      target_name: "foo",
    },
  }),
);
const bytesBar = encode(mkDoc("pkg:bar"));
const bytesUnknown = encode(
  mkDoc("pkg:qux", {
    arbitrary: [{ __type: "unknown", __tag: 9999, value: ["mystery"] }],
  }),
);

let loadModule: typeof import("../src/lib/ir-reader.ts").loadModule;
beforeAll(async () => {
  ({ loadModule } = await import("../src/lib/ir-reader.ts"));
});

describe("loadModule (msgpack roundtrip)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "papyri-viewer-msgpack-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // Writes a blob at <dir>/pkg/1.0/module/<name> and returns an FsBlobStore
  // rooted at <dir>.
  const writeBlob = async (name: string, bytes: Uint8Array): Promise<FsBlobStore> => {
    const moduleDir = join(dir, "pkg", "1.0", "module");
    await mkdir(moduleDir, { recursive: true });
    await writeFile(join(moduleDir, name), bytes);
    return new FsBlobStore(dir);
  };

  it("decodes an IngestedDoc (tag 4010) with nested tagged children", async () => {
    const store = await writeBlob("pkg.mod:foo.msgpack", bytesFull);
    const out = await loadModule(store, "pkg", "1.0", "pkg.mod:foo");
    expect(out.__type).toBe("IngestedDoc");
    expect(out.__tag).toBe(4010);
    expect(out.qa).toBe("pkg.mod:foo");
    expect(out.item_file).toBe("foo.py");
    expect(out.item_line).toBe(42);
    const s = out.signature as {
      __type: string;
      target_name: string;
      return_annotation: { __type: string };
    };
    expect(s.__type).toBe("SignatureNode");
    expect(s.target_name).toBe("foo");
    expect(s.return_annotation.__type).toBe("Empty");
  });

  it("falls back to bare filename when .msgpack is absent", async () => {
    const store = await writeBlob("pkg:bar", bytesBar);
    expect((await loadModule(store, "pkg", "1.0", "pkg:bar")).qa).toBe("pkg:bar");
  });

  it("wraps unregistered inner tags as UnknownNode", async () => {
    const store = await writeBlob("pkg:qux.msgpack", bytesUnknown);
    const out = await loadModule(store, "pkg", "1.0", "pkg:qux");
    const arb = out.arbitrary as unknown[];
    expect(arb).toHaveLength(1);
    const inner = arb[0] as { __type: string; __tag: number; value: unknown };
    expect(inner.__type).toBe("unknown");
    expect(inner.__tag).toBe(9999);
    expect(inner.value).toEqual(["mystery"]);
  });
});
