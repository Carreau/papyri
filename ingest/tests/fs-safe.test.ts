/**
 * Path-traversal guard tests for the filesystem store backends.
 *
 * Bundle-derived key components (module/version/kind/path, pkg/ver) — and, on
 * the read side, request params that flow straight into a blob key — must not
 * be able to escape the store root.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsBlobStore } from "../src/blob-store.ts";
import { FsRawStore } from "../src/raw-store.ts";

describe("store path-traversal guard", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "papyri-fs-safe-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("FsBlobStore.put rejects a traversing path", async () => {
    const store = new FsBlobStore(root);
    await expect(
      store.put(
        { module: "pkg", version: "1.0", kind: "module", path: "../../../../../../escape" },
        new Uint8Array([1]),
      ),
    ).rejects.toThrow(/escapes store root/);
  });

  it("FsBlobStore.get rejects a traversing path param", async () => {
    const store = new FsBlobStore(root);
    await expect(
      store.get({
        module: "pkg",
        version: "1.0",
        kind: "module",
        path: "../../../../../../etc/passwd",
      }),
    ).rejects.toThrow(/escapes store root/);
  });

  it("FsBlobStore.put rejects a traversing module segment", async () => {
    const store = new FsBlobStore(root);
    await expect(
      store.put(
        { module: "../../../../../../evil", version: "1.0", kind: "module", path: "x" },
        new Uint8Array([1]),
      ),
    ).rejects.toThrow(/escapes store root/);
  });

  it("FsRawStore.put rejects a traversing pkg or ver", async () => {
    const store = new FsRawStore(root);
    await expect(store.put("../../../../../../evil", "1.0", new Uint8Array([1]))).rejects.toThrow(
      /escapes store root/,
    );
    await expect(store.put("pkg", "../../../../../../evil", new Uint8Array([1]))).rejects.toThrow(
      /escapes store root/,
    );
  });

  it("allows ordinary keys to round-trip", async () => {
    const store = new FsBlobStore(root);
    const key = { module: "pkg", version: "1.0", kind: "module", path: "numpy.foo" };
    await store.put(key, new Uint8Array([1, 2, 3]));
    expect(await store.get(key)).toEqual(new Uint8Array([1, 2, 3]));
  });
});
