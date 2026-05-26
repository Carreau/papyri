import { describe, it, expect } from "vitest";
import { deflateSync } from "node:zlib";
import { parseObjectsInv, resolveExternalUri } from "../src/inventory.js";

/** Build a Sphinx objects.inv (format v2) from body lines. */
function makeInv(project: string, version: string, lines: string[]): Uint8Array {
  const header = Buffer.from(
    `# Sphinx inventory version 2\n# Project: ${project}\n# Version: ${version}\n` +
      `# The remainder of this file is compressed using zlib.\n`,
    "utf-8",
  );
  const body = deflateSync(Buffer.from(lines.join("\n") + "\n", "utf-8"));
  return new Uint8Array(Buffer.concat([header, body]));
}

describe("parseObjectsInv", () => {
  it("parses header, domain:role, $ substitution and '-' dispname", async () => {
    const inv = makeInv("NumPy", "1.26", [
      "numpy.ndarray py:class 1 reference/generated/numpy.ndarray.html#$ -",
      "numpy.fft.fft py:function 1 reference/generated/numpy.fft.fft.html#numpy.fft.fft NumPy FFT",
      "genindex std:label -1 genindex.html Index",
    ]);
    const parsed = await parseObjectsInv(inv);

    expect(parsed.project).toBe("NumPy");
    expect(parsed.version).toBe("1.26");
    expect(parsed.objects).toHaveLength(3);

    const ndarray = parsed.objects[0]!;
    expect(ndarray.name).toBe("numpy.ndarray");
    expect(ndarray.domain).toBe("py");
    expect(ndarray.role).toBe("class");
    expect(ndarray.priority).toBe(1);
    // trailing $ replaced by the object name
    expect(ndarray.uri).toBe("reference/generated/numpy.ndarray.html#numpy.ndarray");
    // dispname "-" becomes the name
    expect(ndarray.dispname).toBe("numpy.ndarray");

    const label = parsed.objects[2]!;
    expect(label.domain).toBe("std");
    expect(label.role).toBe("label");
    expect(label.priority).toBe(-1);
  });

  it("rejects a non-v2 header", async () => {
    const bad = new Uint8Array(Buffer.from("# Sphinx inventory version 1\n\n\n\nx", "utf-8"));
    await expect(parseObjectsInv(bad)).rejects.toThrow(/unsupported format/);
  });
});

describe("resolveExternalUri", () => {
  it("joins relative uris onto the base, inserting a missing slash", () => {
    expect(resolveExternalUri("https://numpy.org/doc/stable", "a/b.html#x")).toBe(
      "https://numpy.org/doc/stable/a/b.html#x",
    );
    expect(resolveExternalUri("https://numpy.org/doc/stable/", "a/b.html#x")).toBe(
      "https://numpy.org/doc/stable/a/b.html#x",
    );
  });

  it("leaves absolute uris untouched", () => {
    expect(resolveExternalUri("https://numpy.org/doc/stable/", "https://elsewhere/x.html")).toBe(
      "https://elsewhere/x.html",
    );
  });
});
