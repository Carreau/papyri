import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

// Build a minimal but valid Sphinx v2 inventory payload. The header is four
// plaintext lines followed by the zlib-compressed entry stream. Each entry
// follows `<name> <domain>:<role> <priority> <uri> <display_name>`.
function buildInventory(
  project: string,
  version: string,
  entries: Array<[string, string, number, string, string]>,
): Buffer {
  const header =
    "# Sphinx inventory version 2\n" +
    `# Project: ${project}\n` +
    `# Version: ${version}\n` +
    "# The remainder of this file is compressed using zlib.\n";
  const body = entries.map((e) => e.join(" ")).join("\n") + "\n";
  return Buffer.concat([Buffer.from(header, "utf8"), deflateSync(body)]);
}

// `inventory.ts` caches loaded files in a module-level map; re-import fresh
// per test via resetModules.
const freshInv = async () => {
  vi.resetModules();
  return await import("../src/lib/inventory.ts");
};

describe("parseInventory", () => {
  it("decodes header + entries from a v2 inventory", async () => {
    const { parseInventory } = await freshInv();
    const buf = buildInventory("numpy", "2.0.0", [
      ["numpy.linspace", "py:function", 1, "reference/generated/numpy.linspace.html", "-"],
      ["numpy.ndarray", "py:class", 1, "reference/generated/numpy.ndarray.html", "-"],
    ]);
    const parsed = parseInventory(buf);
    expect(parsed.project).toBe("numpy");
    expect(parsed.version).toBe("2.0.0");
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries[0]).toMatchObject({
      name: "numpy.linspace",
      domain: "py",
      role: "function",
      priority: 1,
      uri: "reference/generated/numpy.linspace.html",
      displayName: "numpy.linspace", // "-" expands to name
    });
  });

  it("expands `$` suffix in uri to the entry name", async () => {
    const { parseInventory } = await freshInv();
    const buf = buildInventory("python", "3", [
      ["os.path", "py:module", 0, "library/os.path.html#module-$", "-"],
    ]);
    const parsed = parseInventory(buf);
    expect(parsed.entries[0]?.uri).toBe("library/os.path.html#module-os.path");
  });

  it("keeps explicit display names instead of expanding `-`", async () => {
    const { parseInventory } = await freshInv();
    const buf = buildInventory("x", "1", [
      ["foo.bar", "py:function", 1, "api.html#foo.bar", "the bar function"],
    ]);
    const parsed = parseInventory(buf);
    expect(parsed.entries[0]?.displayName).toBe("the bar function");
  });

  it("skips comments and blank lines inside the compressed body", async () => {
    const { parseInventory } = await freshInv();
    const body =
      "# a comment\n" +
      "\n" +
      "foo py:function 1 api.html#foo -\n";
    const header =
      "# Sphinx inventory version 2\n# Project: x\n# Version: 1\n" +
      "# The remainder of this file is compressed using zlib.\n";
    const buf = Buffer.concat([Buffer.from(header, "utf8"), deflateSync(body)]);
    const parsed = parseInventory(buf);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]?.name).toBe("foo");
  });

  it("rejects a non-v2 header", async () => {
    const { parseInventory } = await freshInv();
    const buf = Buffer.concat([
      Buffer.from(
        "# Sphinx inventory version 1\n# Project: x\n# Version: 1\n# ...\n",
        "utf8",
      ),
      deflateSync(""),
    ]);
    expect(() => parseInventory(buf)).toThrow(/unsupported header/);
  });
});

describe("inventory lookup + resolveExternal", () => {
  let dir: string;
  const origDir = process.env.PAPYRI_INVENTORY_DIR;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "papyri-viewer-inv-"));
    process.env.PAPYRI_INVENTORY_DIR = dir;
  });
  afterEach(async () => {
    if (origDir === undefined) delete process.env.PAPYRI_INVENTORY_DIR;
    else process.env.PAPYRI_INVENTORY_DIR = origDir;
    await rm(dir, { recursive: true, force: true });
  });

  it("returns null when no inventory is cached for the project", async () => {
    const { lookupExternal, resolveExternal } = await freshInv();
    expect(lookupExternal("numpy", "numpy.linspace")).toBeNull();
    expect(resolveExternal("numpy", "numpy.linspace")).toBeNull();
  });

  it("ignores .inv files for projects not in the registry", async () => {
    await writeFile(
      join(dir, "totally-unknown.inv"),
      buildInventory("x", "1", [["x.y", "py:function", 1, "y.html", "-"]]),
    );
    const { lookupExternal } = await freshInv();
    expect(lookupExternal("totally-unknown", "x.y")).toBeNull();
  });

  it("resolves a registered project to a full URL", async () => {
    await writeFile(
      join(dir, "numpy.inv"),
      buildInventory("numpy", "2.0.0", [
        ["numpy.linspace", "py:function", 1, "reference/generated/numpy.linspace.html", "-"],
      ]),
    );
    const { lookupExternal } = await freshInv();
    const hit = lookupExternal("numpy", "numpy.linspace");
    expect(hit).not.toBeNull();
    expect(hit?.url).toBe(
      "https://numpy.org/doc/stable/reference/generated/numpy.linspace.html",
    );
    expect(hit?.displayName).toBe("numpy.linspace");
  });

  it("matches colon-form paths against dotted inventory names", async () => {
    await writeFile(
      join(dir, "numpy.inv"),
      buildInventory("numpy", "2.0.0", [
        ["numpy.fft.fft", "py:function", 1, "generated/numpy.fft.fft.html", "-"],
      ]),
    );
    const { lookupExternal } = await freshInv();
    // RefInfo.path can carry a colon; normalize to dots on fallback.
    expect(lookupExternal("numpy", "numpy.fft:fft")).not.toBeNull();
  });

  it("resolveExternal falls back to the first dotted component of path", async () => {
    await writeFile(
      join(dir, "scipy.inv"),
      buildInventory("scipy", "1.0.0", [
        ["scipy.signal.butter", "py:function", 1, "reference/generated/scipy.signal.butter.html", "-"],
      ]),
    );
    const { resolveExternal } = await freshInv();
    // module=null (as papyri emits for "missing"), so resolveExternal has to
    // infer "scipy" from the leading component of the path.
    const hit = resolveExternal(null, "scipy.signal.butter");
    expect(hit).not.toBeNull();
    expect(hit?.url).toContain("scipy.signal.butter.html");
  });

  it("prefers higher-priority entries when names collide", async () => {
    // Priority -1 is "hidden fallback only"; priority 1 wins.
    await writeFile(
      join(dir, "numpy.inv"),
      buildInventory("numpy", "2.0.0", [
        ["numpy.fft", "py:module", -1, "hidden.html", "-"],
        ["numpy.fft", "py:module", 1, "visible.html", "-"],
      ]),
    );
    const { lookupExternal } = await freshInv();
    const hit = lookupExternal("numpy", "numpy.fft");
    expect(hit?.uri).toBe("visible.html");
  });
});
