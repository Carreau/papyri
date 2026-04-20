import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Encoder, Tag } from "cbor-x";

// Encode BEFORE importing ir-reader.ts: ir-reader registers a global
// read-only encode extension for Object that would break encode() afterwards.
const tg = (tag: number, fields: unknown[]) => new Tag(fields, tag);
const enc = new Encoder({ useRecords: false });

const mkDoc = (qa: string, o: Record<string, unknown> = {}) =>
  tg(4010, [
    {}, [], o.item_file ?? null, o.item_line ?? null, o.item_type ?? null,
    [], null, [], o.signature ?? null, [], qa, o.arbitrary ?? [],
  ]);

const bytesFull = enc.encode(mkDoc("pkg.mod:foo", {
  item_file: "foo.py", item_line: 42, item_type: "function",
  signature: tg(4029, ["function", [], tg(4031, []), "foo"]),
}));
const bytesBar = enc.encode(mkDoc("pkg:bar"));
const bytesUnknown = enc.encode(
  mkDoc("pkg:qux", { arbitrary: [tg(9999, ["mystery"])] }),
);

import { LocalStore } from "../src/lib/storage-local.ts";
import { initStore } from "../src/lib/storage.ts";
import { LocalGraph } from "../src/lib/graph-local.ts";
import { initGraph } from "../src/lib/graph.ts";

let loadModule: typeof import("../src/lib/ir-reader.ts").loadModule;
beforeAll(async () => {
  ({ loadModule } = await import("../src/lib/ir-reader.ts"));
});

describe("loadModule (CBOR roundtrip)", () => {
  let storeRoot: string;
  beforeEach(async () => {
    storeRoot = await mkdtemp(join(tmpdir(), "papyri-viewer-cbor-"));
    initStore(new LocalStore(storeRoot));
    // graph must be initialised too (buildXrefResolver uses it)
    initGraph(new LocalGraph(join(storeRoot, "nope.db")));
  });
  afterEach(async () => {
    await rm(storeRoot, { recursive: true, force: true });
  });

  const writeBlob = async (pkg: string, ver: string, name: string, bytes: Uint8Array) => {
    const modDir = join(storeRoot, pkg, ver, "module");
    await mkdir(modDir, { recursive: true });
    await writeFile(join(modDir, name), bytes);
  };

  it("decodes an IngestedDoc (tag 4010) with nested tagged children", async () => {
    await writeBlob("pkg", "1.0", "pkg.mod$foo", bytesFull);
    const out = await loadModule("pkg", "1.0", "pkg.mod$foo");
    expect(out.__type).toBe("IngestedDoc");
    expect(out.__tag).toBe(4010);
    expect(out.qa).toBe("pkg.mod:foo");
    expect(out.item_file).toBe("foo.py");
    expect(out.item_line).toBe(42);
    const s = out.signature as { __type: string; target_name: string; return_annotation: { __type: string } };
    expect(s.__type).toBe("SignatureNode");
    expect(s.target_name).toBe("foo");
    expect(s.return_annotation.__type).toBe("Empty");
  });

  it("falls back to .cbor when the bare filename is absent", async () => {
    await writeBlob("pkg", "1.0", "pkg$bar.cbor", bytesBar);
    expect((await loadModule("pkg", "1.0", "pkg$bar")).qa).toBe("pkg:bar");
  });

  it("leaves unregistered inner tags as raw cbor-x Tag instances", async () => {
    const { Tag: DecTag } = await import("cbor-x");
    await writeBlob("pkg", "1.0", "pkg$qux", bytesUnknown);
    const out = await loadModule("pkg", "1.0", "pkg$qux");
    const arb = out.arbitrary as unknown[];
    expect(arb).toHaveLength(1);
    const inner = arb[0] as InstanceType<typeof DecTag>;
    expect(inner).toBeInstanceOf(DecTag);
    expect(inner.tag).toBe(9999);
    expect(inner.value).toEqual(["mystery"]);
  });
});
